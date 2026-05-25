import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";

import winston from "winston";

import { CUE_LOCALE, CUE_TIME_ZONE } from "../config/cue-timezone.js";
import { getConfig, getLogLevel } from "../config/index.js";
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
  level: getLogLevel(),
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

/** `process.kill(pid, 0)` liveness probe; EPERM means a process exists but we cannot signal it. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function readPidFromLockFile(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim().split(/\s+/)[0] ?? "";
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** If a lock file exists but the PID is gone, remove it (PM2 crash / SIGKILL mid-run). */
function clearStaleSchedulerLockIfDead(lockPath: string): void {
  if (!existsSync(lockPath)) {
    return;
  }
  const pid = readPidFromLockFile(lockPath);
  if (pid !== null && isProcessAlive(pid)) {
    return;
  }
  try {
    unlinkSync(lockPath);
    logger.info(`scheduler_lock_cleared_stale path=${lockPath} previousPid=${pid === null ? "invalid" : pid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`scheduler_lock_clear_stale_failed path=${lockPath} error=${msg}`);
  }
}

/**
 * Atomically create `LOCK_PATH` with this PID after removing a stale lock.
 * Returns false if another live process holds the lock.
 */
function tryAcquireSchedulerLock(lockPath: string): boolean {
  const dir = path.dirname(lockPath);
  if (dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (existsSync(lockPath)) {
      const holder = readPidFromLockFile(lockPath);
      if (holder !== null && isProcessAlive(holder)) {
        logger.warn(
          `scheduler_skip_lock path=${lockPath} holderPid=${holder} reason=live_process_holds_lock`,
        );
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // concurrent unlink or race; retry with O_EXCL
      }
    }

    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "EEXIST") {
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`scheduler_lock_acquire_failed path=${lockPath} error=${msg}`);
      return false;
    }
  }

  logger.warn(`scheduler_skip_lock path=${lockPath} reason=max_acquire_retries`);
  return false;
}

function releaseSchedulerLock(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) {
      return;
    }
    const holder = readPidFromLockFile(lockPath);
    if (holder === process.pid) {
      unlinkSync(lockPath);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`scheduler_lock_release_failed path=${lockPath} error=${msg}`);
  }
}

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
        lockPath: cfg.LOCK_PATH,
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

  const { LOCK_PATH } = getConfig();
  if (!tryAcquireSchedulerLock(LOCK_PATH)) {
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
    releaseSchedulerLock(LOCK_PATH);
  }
}

function shutdown(): void {
  logger.info("scheduler_shutdown draining better-sqlite3 parent handle");
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  try {
    if (!isRunning) {
      releaseSchedulerLock(getConfig().LOCK_PATH);
    }
  } catch {
    // config may be unavailable in extreme teardown paths
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
  const cfg = getConfig();
  clearStaleSchedulerLockIfDead(cfg.LOCK_PATH);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(
    `scheduler_started pollMs=${POLL_MS} windowEt=16:05-16:15 locale=${CUE_LOCALE} timeZone=${CUE_TIME_ZONE} lockPath=${cfg.LOCK_PATH}`,
  );
  pollTimer = setInterval(schedulerTick, POLL_MS);
  schedulerTick();
}
