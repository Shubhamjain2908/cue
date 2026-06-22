import { spawnSync } from "node:child_process";

import { createCueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import {
  CUE_LOCALE,
  CUE_TIME_ZONE,
  getEtCalendarParts,
  weekdayUtcForNyCalendarDate,
} from "../config/cue-timezone.js";
import { setPipelineState } from "../db/queries.js";
import { openCueDb, type CueDatabase } from "../db/provider.js";

/** Sunday in America/New_York civil calendar (matches `Date.UTC` weekday: 0 Sun … 6 Sat). */
export const REBALANCE_DAY_OF_WEEK = 0;

/** Tue–Sat stop path: next-morning 06:00–06:10 ET for stable free-tier T-1 availability. */
const WEEKDAY_WINDOW_START_MIN = 6 * 60;
const WEEKDAY_WINDOW_END_MIN = 6 * 60 + 10;
/** Sunday rebalance: 06:00–06:10 ET using Friday OHLCV from T-1 ingest. */
const REBALANCE_WINDOW_START_MIN = 6 * 60;
const REBALANCE_WINDOW_END_MIN = 6 * 60 + 10;

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
  { name: "adjust-splits", cueArgs: ["adjust-splits"], critical: false, runOn: "both" },
  {
    name: "enrich-fundamentals",
    cueArgs: ["enrich-fundamentals"],
    critical: false,
    runOn: "rebalance",
  },
  { name: "screen", cueArgs: ["screen"], critical: true, runOn: "rebalance" },
  {
    name: "execute-stops",
    cueArgs: ["execute-stops"],
    critical: true,
    runOn: "stop",
  },
  { name: "enrich", cueArgs: ["enrich"], critical: false, runOn: "rebalance" },
  {
    name: "brief",
    cueArgs: ["brief"],
    critical: false,
    runOn: "both",
    forwardArgs: ["--mode"],
  },
];

const logger = createCueLogger("pipeline");

/** NY civil calendar weekday for an instant (0 Sunday … 6 Saturday). */
export function getNyCalendarWeekday(now: Date): number {
  const { year, month, day } = getEtCalendarParts(now);
  return weekdayUtcForNyCalendarDate(year, month, day);
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

/** ET execution window for scheduler polling (Tue–Sat stop vs Sunday rebalance). */
export function executionWindowEtForDate(now: Date): { startMin: number; endMin: number } {
  const dow = getNyCalendarWeekday(now);
  if (dow === REBALANCE_DAY_OF_WEEK) {
    return { startMin: REBALANCE_WINDOW_START_MIN, endMin: REBALANCE_WINDOW_END_MIN };
  }
  return { startMin: WEEKDAY_WINDOW_START_MIN, endMin: WEEKDAY_WINDOW_END_MIN };
}

export function isWithinExecutionWindow(now: Date): boolean {
  const m = getEtMinutesSinceMidnight(now);
  const { startMin, endMin } = executionWindowEtForDate(now);
  return m >= startMin && m <= endMin;
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
  db: CueDatabase,
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
    const storedExit = result.status === null ? -1 : result.status;
    setPipelineState(db, `step:${step.name}:last_exit_code`, String(storedExit));
    setPipelineState(db, `step:${step.name}:last_run_at`, new Date().toISOString());
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
export function runPipeline(
  mode: "rebalance" | "stop",
  db: CueDatabase,
  deps: RunPipelineDeps = {},
): number {
  return runPipelineWithSteps(stepsForMode(mode), mode, db, deps);
}

/** One-shot: full pipeline in subprocess order (ingest → screen → …). Returns exit code (0 ok, 1 critical failure). */
export function runAllPipelineCli(argv?: readonly string[]): number {
  const mode = detectRunMode({ argv: argv ?? process.argv });
  const db = openCueDb(getConfig().DB_PATH);
  try {
    return runPipeline(mode, db);
  } finally {
    db.close();
  }
}

export function runDailyWorkflowCli(): void {
  if (!process.argv.includes("--now")) {
    throw new Error("runDailyWorkflowCli is only for --now; use `cue schedule` for the daemon.");
  }
  const mode = detectRunMode();
  const db = openCueDb(getConfig().DB_PATH);
  try {
    const code = runPipeline(mode, db);
    process.exit(code);
  } finally {
    db.close();
  }
}
