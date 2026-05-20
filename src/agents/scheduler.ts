import { clearInterval, setInterval } from "node:timers";

import winston from "winston";

import { CUE_LOCALE, CUE_TIME_ZONE } from "../config/cue-timezone.js";
import { getConfig } from "../config/index.js";
import type { CueDatabase } from "../db/provider.js";
import { openCueDbReadonly } from "../db/provider.js";

import {
  formatEtYmd,
  getNyCalendarWeekday,
  isWithinExecutionWindow,
  type PipelineStep,
  runPipelineWithSteps,
} from "./daily-workflow.js";

const POLL_MS = 60_000;

/** Friday EOD: full rebalance path (Spec §3). */
const SCHEDULER_FRIDAY_STEPS: PipelineStep[] = [
  { name: "ingest", cueArgs: ["ingest"], critical: true, runOn: "both" },
  { name: "enrich-fundamentals", cueArgs: ["enrich-fundamentals"], critical: false, runOn: "both" },
  { name: "screen", cueArgs: ["screen"], critical: true, runOn: "both" },
  { name: "enrich", cueArgs: ["enrich"], critical: false, runOn: "both" },
  {
    name: "brief",
    cueArgs: ["brief"],
    critical: false,
    runOn: "both",
    forwardArgs: ["--mode"],
  },
];

/** Mon–Thu maintenance: stop path only. */
const SCHEDULER_MON_THU_STEPS: PipelineStep[] = [
  { name: "ingest", cueArgs: ["ingest"], critical: true, runOn: "both" },
  { name: "execute-stops", cueArgs: ["execute-stops"], critical: true, runOn: "both" },
  {
    name: "brief",
    cueArgs: ["brief"],
    critical: false,
    runOn: "both",
    forwardArgs: ["--mode"],
  },
];

const logger = winston.createLogger({
  defaultMeta: { service: "scheduler" },
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const { timestamp, level, message, service, ...rest } = info;
      const extra =
        Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
      return `${String(timestamp)} ${String(service ?? "scheduler")} ${level}: ${String(message)}${extra}`;
    }),
  ),
  transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
});

/** NY weekday: Friday → rebalance; Mon–Thu → weekday maintenance; Sat/Sun → idle. */
export function schedulerRunKindForNyWeekday(dow: number): "rebalance" | "weekday" | null {
  if (dow === 5) {
    return "rebalance";
  }
  if (dow >= 1 && dow <= 4) {
    return "weekday";
  }
  return null;
}

let lastRunDate = "";
let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** Parent-held readonly handle for clean shutdown (subprocess `cue` steps open their own DBs). */
let heldDb: CueDatabase | undefined;

function openAndLogHealth(): void {
  try {
    const cfg = getConfig();
    const now = new Date();
    heldDb = openCueDbReadonly(cfg.DB_PATH);
    heldDb.prepare("SELECT 1 AS ok").get();
    logger.info(
      `scheduler_health ${JSON.stringify({
        ok: true,
        locale: CUE_LOCALE,
        timeZone: CUE_TIME_ZONE,
        etYmd: formatEtYmd(now),
        etWeekday: getNyCalendarWeekday(now),
        pollMs: POLL_MS,
        executionWindowEt: "16:05–16:15",
        dbPath: cfg.DB_PATH,
      })}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`scheduler_health_failed error=${msg}`);
    if (heldDb !== undefined) {
      heldDb.close();
      heldDb = undefined;
    }
    process.exit(1);
  }
}

function schedulerTick(): void {
  const now = new Date();
  if (!isWithinExecutionWindow(now)) {
    return;
  }
  const todayEt = formatEtYmd(now);
  if (lastRunDate === todayEt) {
    return;
  }

  const dow = getNyCalendarWeekday(now);
  const kind = schedulerRunKindForNyWeekday(dow);
  if (kind === null) {
    logger.debug(`scheduler_skip_weekend_or_idle dow=${dow} etDate=${todayEt}`);
    return;
  }

  if (isRunning) {
    logger.warn(
      "scheduler_skip_overlap previous tick still running; skipping to avoid overlapping DB writes",
    );
    return;
  }

  isRunning = true;
  try {
    if (kind === "rebalance") {
      logger.info(`scheduler_fire kind=rebalance etDate=${todayEt} dow=${dow}`);
      const code = runPipelineWithSteps(SCHEDULER_FRIDAY_STEPS, "rebalance");
      if (code === 0) {
        lastRunDate = todayEt;
      }
    } else {
      logger.info(`scheduler_fire kind=weekday_stop etDate=${todayEt} dow=${dow}`);
      const code = runPipelineWithSteps(SCHEDULER_MON_THU_STEPS, "stop");
      if (code === 0) {
        lastRunDate = todayEt;
      }
    }
  } finally {
    isRunning = false;
  }
}

function shutdown(): void {
  logger.info("scheduler_shutdown draining better-sqlite3 parent handle");
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (heldDb !== undefined) {
    heldDb.close();
    heldDb = undefined;
  }
  process.exit(0);
}

/**
 * Long-running scheduler daemon (60s poll, 16:05–16:15 ET window, once per ET calendar day).
 * Intended for systemd / PM2 alongside `cue schedule`.
 */
export function runScheduleDaemonCli(): void {
  openAndLogHealth();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(
    `scheduler_started pollMs=${POLL_MS} windowEt=16:05-16:15 locale=${CUE_LOCALE} timeZone=${CUE_TIME_ZONE}`,
  );
  pollTimer = setInterval(schedulerTick, POLL_MS);
  schedulerTick();
}
