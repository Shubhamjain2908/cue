import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";

import winston from "winston";

import { CUE_LOCALE, CUE_TIME_ZONE } from "../config/cue-timezone.js";
import { getConfig } from "../config/index.js";
import { getPipelineState, setPipelineState } from "../db/queries.js";
import type { CueDatabase } from "../db/provider.js";
import { openCueDb } from "../db/provider.js";

import { cueLogger } from "../cli/cue-logger.js";
import {
  executionWindowEtForDate,
  formatEtYmd,
  getNyCalendarWeekday,
  isWithinExecutionWindow,
  runPipelineWithSteps,
  stepsForMode,
} from "./daily-workflow.js";

const POLL_MS = 60_000;

/** `pipeline_state.key` — ET `YYYY-MM-DD` of last scheduler run that exited 0. */
const PIPELINE_STATE_LAST_SUCCESSFUL_RUN_DATE = "last_successful_run_date";

// MAINTAINER NOTE: bump this string whenever a new migration is added.
// verifyMigrations() will exit(2) if the DB is behind HEAD.
export const HEAD_MIGRATION = "016_signals_alerted_at";

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

/** NY weekday: Sunday → rebalance; Tue–Sat → stop maintenance; Monday → idle. */
export function schedulerRunKindForNyWeekday(dow: number): "rebalance" | "weekday" | null {
  if (dow === 0) {
    return "rebalance";
  }
  if (dow >= 2 && dow <= 6) {
    return "weekday";
  }
  return null;
}

let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** Parent-held DB for health, pipeline_state, and clean shutdown (subprocess `cue` steps open their own DBs). */
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

export function verifyMigrations(db: CueDatabase): void {
  const row = db
    .prepare("SELECT id FROM _migrations WHERE id = ? LIMIT 1")
    .get(HEAD_MIGRATION) as { id: string } | undefined;

  if (!row) {
    cueLogger.error(
      `scheduler: migration '${HEAD_MIGRATION}' not applied — ` +
        "run `cue db:migrate` before starting the scheduler.",
    );
    db.close();
    process.exit(2);
  }
}

function openAndLogHealth(): void {
  try {
    const cfg = getConfig();
    const now = new Date();
    heldDb = openCueDb(cfg.DB_PATH);
    heldDb.prepare("SELECT 1 AS ok").get();
    verifyMigrations(heldDb);
    logger.info(
      `scheduler_health ${JSON.stringify({
        ok: true,
        locale: CUE_LOCALE,
        timeZone: CUE_TIME_ZONE,
        etYmd: formatEtYmd(now),
        etWeekday: getNyCalendarWeekday(now),
        pollMs: POLL_MS,
        executionWindowEt: formatSchedulerWindowEt(now),
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
  if (heldDb === undefined) {
    return;
  }
  if (getPipelineState(heldDb, PIPELINE_STATE_LAST_SUCCESSFUL_RUN_DATE) === todayEt) {
    return;
  }

  const dow = getNyCalendarWeekday(now);
  const kind = schedulerRunKindForNyWeekday(dow);
  if (kind === null) {
    logger.debug(`scheduler_skip_idle_day dow=${dow} etDate=${todayEt}`);
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
  let exitCode = 1;
  try {
    if (kind === "rebalance") {
      logger.info(`scheduler_fire kind=rebalance etDate=${todayEt} dow=${dow}`);
      exitCode = runPipelineWithSteps(stepsForMode("rebalance"), "rebalance");
    } else {
      logger.info(`scheduler_fire kind=weekday_stop etDate=${todayEt} dow=${dow}`);
      exitCode = runPipelineWithSteps(stepsForMode("stop"), "stop");
    }
  } finally {
    isRunning = false;
    if (exitCode === 0) {
      setPipelineState(heldDb, PIPELINE_STATE_LAST_SUCCESSFUL_RUN_DATE, todayEt);
    }
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

function formatSchedulerWindowEt(now: Date): string {
  const { startMin, endMin } = executionWindowEtForDate(now);
  const sh = String(Math.floor(startMin / 60)).padStart(2, "0");
  const sm = String(startMin % 60).padStart(2, "0");
  const eh = String(Math.floor(endMin / 60)).padStart(2, "0");
  const em = String(endMin % 60).padStart(2, "0");
  return `${sh}:${sm}–${eh}:${em}`;
}

/**
 * Long-running scheduler daemon (60s poll; ET window Tue–Sat 06:00–06:10 stop, Sun 06:00–06:10 rebalance).
 * Intended for systemd / PM2 alongside `cue schedule`.
 */
export function runScheduleDaemonCli(): void {
  openAndLogHealth();
  const cfg = getConfig();
  clearStaleSchedulerLockIfDead(cfg.LOCK_PATH);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(
    `scheduler_started pollMs=${POLL_MS} windowEt=Tue-Sat_06:00-06:10_Sun_06:00-06:10 locale=${CUE_LOCALE} timeZone=${CUE_TIME_ZONE} lockPath=${cfg.LOCK_PATH}`,
  );
  pollTimer = setInterval(schedulerTick, POLL_MS);
  schedulerTick();
}
