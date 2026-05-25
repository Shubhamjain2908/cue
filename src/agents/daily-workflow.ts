import { spawnSync } from "node:child_process";

import winston from "winston";

import { getLogLevel } from "../config/index.js";
import { CUE_LOCALE, CUE_TIME_ZONE } from "../config/cue-timezone.js";

/** Friday in America/New_York civil calendar (matches `Date.UTC` weekday: 0 Sun … 5 Fri). */
export const REBALANCE_DAY_OF_WEEK = 5;

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
  level: getLogLevel(),
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
  const dtf = new Intl.DateTimeFormat(CUE_LOCALE, {
    timeZone: CUE_TIME_ZONE,
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

/** NY civil calendar weekday for an instant (0 Sunday … 6 Saturday). */
export function getNyCalendarWeekday(now: Date): number {
  const { year, month, day } = getEtCalendarParts(now);
  return weekdayUtcForNyCalendarDate(year, month, day);
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
  const dtf = new Intl.DateTimeFormat(CUE_LOCALE, {
    timeZone: CUE_TIME_ZONE,
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
  const dow = getNyCalendarWeekday(now);
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
 * Runs the given steps in order. Returns 0 on success, 1 if a critical step failed (caller should `process.exit(1)`).
 */
export function runPipelineWithSteps(
  steps: PipelineStep[],
  mode: "rebalance" | "stop",
  deps: RunPipelineDeps = {},
): number {
  const spawnImpl = deps.spawn ?? spawnSync;
  const skippedSteps: string[] = [];
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

/**
 * Runs filtered registry steps in order. Returns 0 on success, 1 if a critical step failed (caller should `process.exit(1)`).
 */
export function runPipeline(mode: "rebalance" | "stop", deps: RunPipelineDeps = {}): number {
  return runPipelineWithSteps(stepsForMode(mode), mode, deps);
}

/** One-shot: full pipeline in subprocess order (ingest → screen → …). Returns exit code (0 ok, 1 critical failure). */
export function runAllPipelineCli(argv?: readonly string[]): number {
  const mode = detectRunMode({ argv: argv ?? process.argv });
  return runPipeline(mode);
}

export function runDailyWorkflowCli(): void {
  if (!process.argv.includes("--now")) {
    throw new Error("runDailyWorkflowCli is only for --now; use `cue schedule` for the daemon.");
  }
  const mode = detectRunMode();
  const code = runPipeline(mode);
  process.exit(code);
}
