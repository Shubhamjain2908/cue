import { spawnSync } from "node:child_process";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

import winston from "winston";

/** Friday in America/New_York civil calendar (matches `Date.UTC` weekday: 0 Sun … 5 Fri). */
export const REBALANCE_DAY_OF_WEEK = 5;

const POLL_MS = 60_000;
const WINDOW_START_MIN = 16 * 60 + 5;
const WINDOW_END_MIN = 16 * 60 + 15;

export interface PipelineStep {
  name: string;
  /** Arguments after `pnpm run cue --`. */
  cueArgs: string[];
  critical: boolean;
  runOn: "rebalance" | "stop" | "both";
  /** Appended after `pnpm run cue -- …` when non-empty (passed through to the CLI). */
  forwardArgs?: string[];
}

export const PIPELINE_STEPS: PipelineStep[] = [
  { name: "ingest", cueArgs: ["ingest"], critical: true, runOn: "both" },
  { name: "screen", cueArgs: ["screen"], critical: true, runOn: "both" },
  { name: "enrich", cueArgs: ["enrich"], critical: false, runOn: "rebalance" },
  {
    name: "brief",
    cueArgs: ["brief"],
    critical: false,
    runOn: "both",
    forwardArgs: ["--mode"],
  },
];

const logger = winston.createLogger({
  defaultMeta: { service: "pipeline" },
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const { timestamp, level, message, service, ...rest } = info;
      const extra =
        Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
      return `${String(timestamp)} ${String(service ?? "pipeline")} ${level}: ${String(message)}${extra}`;
    }),
  ),
  transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
});

function getEtCalendarParts(now: Date): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(now);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const p of parts) {
    if (p.type === "year") {
      year = Number(p.value);
    }
    if (p.type === "month") {
      month = Number(p.value);
    }
    if (p.type === "day") {
      day = Number(p.value);
    }
  }
  return { year, month, day };
}

/** Gregorian weekday for an America/New_York calendar date (0 Sunday … 6 Saturday). */
export function weekdayUtcForNyCalendarDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

export function formatEtYmd(now: Date): string {
  const { year, month, day } = getEtCalendarParts(now);
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getEtMinutesSinceMidnight(now: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "hour") {
      hour = Number(p.value);
    }
    if (p.type === "minute") {
      minute = Number(p.value);
    }
  }
  return hour * 60 + minute;
}

export function isWithinExecutionWindow(now: Date): boolean {
  const m = getEtMinutesSinceMidnight(now);
  return m >= WINDOW_START_MIN && m <= WINDOW_END_MIN;
}

export interface DetectRunModeInput {
  readonly argv?: readonly string[];
  readonly now?: Date;
}

export function detectRunMode(input?: DetectRunModeInput): "rebalance" | "stop" {
  const argv = input?.argv ?? process.argv;
  const now = input?.now ?? new Date();
  if (argv.includes("--force-rebalance")) {
    return "rebalance";
  }
  const { year, month, day } = getEtCalendarParts(now);
  const dow = weekdayUtcForNyCalendarDate(year, month, day);
  return dow === REBALANCE_DAY_OF_WEEK ? "rebalance" : "stop";
}

export function stepsForMode(mode: "rebalance" | "stop"): PipelineStep[] {
  return PIPELINE_STEPS.filter((s) => s.runOn === "both" || s.runOn === mode);
}

/** Expands registry `forwardArgs` (e.g. `--mode` placeholder → `--mode stop`). */
export function resolvedForwardArgs(
  step: PipelineStep,
  mode: "rebalance" | "stop",
): string[] {
  const tokens = step.forwardArgs ?? [];
  return tokens.flatMap((t) => (t === "--mode" ? (["--mode", mode] as const) : [t]));
}

export function pnpmRunArgs(step: PipelineStep, mode: "rebalance" | "stop"): string[] {
  const screenRebalance =
    step.name === "screen" && mode === "rebalance" ? (["--force-rebalance"] as const) : [];
  const forwarded = [...resolvedForwardArgs(step, mode), ...screenRebalance];
  const base = ["run", "cue", "--", ...step.cueArgs];
  return forwarded.length > 0 ? [...base, ...forwarded] : base;
}

export interface RunPipelineDeps {
  readonly spawn?: typeof spawnSync;
}

/**
 * Runs filtered steps in order. Returns 0 on success, 1 if a critical step failed (caller should `process.exit(1)`).
 */
export function runPipeline(
  mode: "rebalance" | "stop",
  deps: RunPipelineDeps = {},
): number {
  const spawnImpl = deps.spawn ?? spawnSync;
  const skippedSteps: string[] = [];
  const steps = stepsForMode(mode);
  const t0 = Date.now();
  logger.info(
    `pipeline_start mode=${mode} steps=${steps.map((s) => s.name).join(",")} ts=${new Date().toISOString()}`,
  );

  for (const step of steps) {
    logger.info(`step_start name=${step.name} mode=${mode} ts=${new Date().toISOString()}`);
    const result = spawnImpl("pnpm", pnpmRunArgs(step, mode), {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });
    const exitCode = result.status === null ? 1 : result.status;
    if (exitCode !== 0) {
      if (step.critical) {
        logger.error(`ABORT step=${step.name} exitCode=${exitCode} mode=${mode}`);
        return 1;
      }
      logger.warn(`step_failed_non_critical step=${step.name} exitCode=${exitCode} mode=${mode}`);
      skippedSteps.push(step.name);
    }
  }

  logger.info(
    `pipeline_done mode=${mode} durationMs=${Date.now() - t0} skippedSteps=${skippedSteps.length} skipped=${skippedSteps.join(",")}`,
  );
  return 0;
}

let lastRunEtYmd = "";
let pollTimer: ReturnType<typeof setInterval> | undefined;

function schedulerTick(): void {
  const now = new Date();
  if (!isWithinExecutionWindow(now)) {
    return;
  }
  const todayEt = formatEtYmd(now);
  if (lastRunEtYmd === todayEt) {
    return;
  }
  const mode = detectRunMode();
  logger.info(`scheduler_fire mode=${mode} etDate=${todayEt}`);
  const code = runPipeline(mode);
  if (code === 0) {
    lastRunEtYmd = todayEt;
  }
}

function shutdown(): void {
  logger.info("[pipeline] Shutdown signal received. Exiting.");
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
  }
  process.exit(0);
}

/** Long-running scheduler (16:05–16:15 ET window); does not exit on its own. */
export function runScheduleDaemonCli(): void {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info("[pipeline] Scheduler started pollMs=60000 window=16:05-16:15 America/New_York");
  pollTimer = setInterval(schedulerTick, POLL_MS);
  schedulerTick();
}

/** One-shot: full pipeline in subprocess order (ingest → screen → …). Returns exit code (0 ok, 1 critical failure). */
export function runAllPipelineCli(argv?: readonly string[]): number {
  const mode = detectRunMode({ argv: argv ?? process.argv });
  return runPipeline(mode);
}

export function runDailyWorkflowCli(): void {
  const runNow = process.argv.includes("--now");

  if (runNow) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    const mode = detectRunMode();
    const code = runPipeline(mode);
    process.exit(code);
  }

  runScheduleDaemonCli();
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  runDailyWorkflowCli();
}
