import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";

import axios from "axios";
import winston from "winston";

import {
  formatEtYmd,
  getEtCalendarParts,
  weekdayUtcForNyCalendarDate,
} from "../config/cue-timezone.js";
import { createCueLogger, cueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import { setPipelineState } from "../db/queries.js";
import { openCueDb, type CueDatabase } from "../db/provider.js";
import { parseOptionalYmdFromArgv } from "../cli/ymd-arg.js";
import { addCalendarDays } from "../shared/date-utils.js";
import {
  loadUniverseTickers,
  tryLoadUniverseMeta,
  universeMetaMatchesTickerCount,
} from "../universe/load-universe.js";
import {
  massiveGroupedResponseSchema,
  type MassiveGroupedBar,
} from "./types.js";

/** Maximum HTTP retries for 429/500/503 responses (1s, 2s, 4s backoff). */
const MAX_HTTP_RETRIES = 3;

/** Base exponential backoff in ms (actual: 1s, 2s, 4s). */
const RETRY_BACKOFF_BASE_MS = 1000;

/** HTTP status codes eligible for automatic retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

/** Quorum fraction: at least 80% of expected universe tickers must be present. */
const QUORUM_THRESHOLD = 0.8;

function createHttpClient(): import("axios").AxiosInstance {
  const client = axios.create({ timeout: 120_000 });

  client.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      const axiosError = error as import("axios").AxiosError;
      const config = axiosError.config as import("axios").InternalAxiosRequestConfig & {
        _retryCount?: number;
      };

      if (config === undefined) {
        return Promise.reject(error);
      }

      config._retryCount = config._retryCount ?? 0;
      const status = axiosError.response?.status;
      const shouldRetry =
        config._retryCount < MAX_HTTP_RETRIES &&
        status !== undefined &&
        RETRYABLE_STATUS_CODES.has(status);

      if (!shouldRetry) {
        return Promise.reject(error);
      }

      config._retryCount += 1;
      const backoffMs = Math.pow(2, config._retryCount - 1) * RETRY_BACKOFF_BASE_MS; // 1s, 2s, 4s
      await delay(backoffMs);
      return client(config);
    },
  );

  return client;
}

const MASSIVE_REST_BASE = "https://api.massive.com";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createLogger(): winston.Logger {
  const { LOG_LEVEL } = getConfig();
  return createCueLogger("massive", { level: LOG_LEVEL });
}

// ponytail: getEtCalendarParts, formatEtYmd, weekdayUtcForNyCalendarDate imported from cue-timezone.ts

/**
 * Latest Mon–Fri on or before ET civil (year, month, day); walks back at most 5 days.
 * Used so `dbCurrent` matches US-listed daily bars, not the laptop's local timezone.
 */
function latestWeekdayOnOrBeforeEtCivil(
  year: number,
  month: number,
  day: number,
): string | null {
  let y = year;
  let mo = month;
  let d = day;
  for (let i = 0; i < 5; i++) {
    const dow = weekdayUtcForNyCalendarDate(y, mo, d);
    if (dow !== 0 && dow !== 6) {
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    const civil = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    civil.setUTCDate(civil.getUTCDate() - 1);
    y = civil.getUTCFullYear();
    mo = civil.getUTCMonth() + 1;
    d = civil.getUTCDate();
  }
  return null;
}

/** Latest Mon–Fri on or before today's ET civil date (T+0 session target). */
function currentEtWeekdaySession(now: Date): string {
  const { year, month, day } = getEtCalendarParts(now);
  const resolved = latestWeekdayOnOrBeforeEtCivil(year, month, day);
  if (resolved === null) {
    throw new Error("Could not resolve current ET session date for grouped ingest");
  }
  return resolved;
}

function dailyPricesHasAnyRowOnDate(db: CueDatabase, date: string): boolean {
  const row = db
    .prepare<{ date: string }, { count: number }>(
      "SELECT COUNT(*) as count FROM daily_prices WHERE date = @date LIMIT 1",
    )
    .get({ date });
  return (row?.count ?? 0) > 0;
}

function markT1IngestStaleness(db: CueDatabase, t1Date: string): void {
  if (dailyPricesHasAnyRowOnDate(db, t1Date)) {
    cueLogger.warn(
      `ingest: T+0 unavailable and T-1 (${t1Date}) already in daily_prices — ` +
        "pipeline is running on stale data. No new bars ingested.",
    );
    setPipelineState(db, "last_ingest_was_stale", "1");
  } else {
    setPipelineState(db, "last_ingest_was_stale", "0");
  }
}

/** ET civil date one calendar day before `now`, then latest Mon–Fri on or before that day. */
function previousWeekdayBeforeEtCivil(now: Date): string {
  const [ey, em, ed] = formatEtYmd(now).split("-").map(Number);
  const civil = new Date(Date.UTC(ey!, em! - 1, ed!, 12, 0, 0));
  civil.setUTCDate(civil.getUTCDate() - 1);
  const resolved = latestWeekdayOnOrBeforeEtCivil(
    civil.getUTCFullYear(),
    civil.getUTCMonth() + 1,
    civil.getUTCDate(),
  );
  if (resolved === null) {
    throw new Error("Could not resolve previous ET session date for grouped ingest");
  }
  return resolved;
}

/**
 * Return the last `n` ET civil weekdays (Mon–Fri) on or before `now`, newest first.
 * Used by backfill to detect gaps in `daily_prices`.
 */
function recentEtWeekdays(now: Date, n: number): string[] {
  const results: string[] = [];
  let { year, month, day } = getEtCalendarParts(now);
  for (let attempts = 0; attempts < n * 3 && results.length < n; attempts++) {
    const dow = weekdayUtcForNyCalendarDate(year, month, day);
    if (dow !== 0 && dow !== 6) {
      const yStr = String(year).padStart(4, "0");
      const mStr = String(month).padStart(2, "0");
      const dStr = String(day).padStart(2, "0");
      results.push(`${yStr}-${mStr}-${dStr}`);
    }
    // Step back one calendar day
    const civil = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    civil.setUTCDate(civil.getUTCDate() - 1);
    year = civil.getUTCFullYear();
    month = civil.getUTCMonth() + 1;
    day = civil.getUTCDate();
  }
  return results;
}

/**
 * After the primary session ingest, detect and fill any gaps in `daily_prices`
 * within the last `lookback` weekdays (default 5 ≈ one trading week).
 * Skips dates that return 0 bars from Massive (market holidays).
 * Skips dates already present in `daily_prices` for QQQ.
 */
async function backfillRecentGaps(input: {
  db: CueDatabase;
  apiKey: string;
  primarySessionDate: string;
  now: Date;
  tickerMask: ReadonlySet<string>;
  expectedMaskCount: number;
  lookback: number;
  logger: winston.Logger;
}): Promise<void> {
  const { db, apiKey, primarySessionDate, now, tickerMask, expectedMaskCount, lookback, logger } = input;

  const candidates = recentEtWeekdays(now, lookback).filter(
    // Only backfill dates that have already closed: strictly before the primary session.
    // This prevents 403s from free-tier same-day restrictions.
    (d) => d !== primarySessionDate && d < primarySessionDate,
  );
  if (candidates.length === 0) return;

  const oldest = candidates[candidates.length - 1]!;
  const present = new Set(
    (
      db
        .prepare(`SELECT date FROM daily_prices WHERE ticker = 'QQQ' AND date >= ? ORDER BY date ASC`)
        .all(oldest) as { date: string }[]
    ).map((r) => r.date),
  );

  const missing = candidates.filter((d) => !present.has(d));
  if (missing.length === 0) return;

  logger.info(`ingest: backfilling ${String(missing.length)} gap(s): ${missing.join(", ")}`);

  // Fetch oldest-first so DB is filled in chronological order.
  for (const date of [...missing].reverse()) {
    try {
      const results = await fetchGroupedDaily({ apiKey, dateString: date });
      if (results.length === 0) {
        logger.info(`ingest: backfill ${date} — 0 bars (market holiday or weekend), skipping`);
        continue;
      }
      insertGroupedSessionRows({ db, sessionDate: date, tickerMask, expectedMaskCount, rows: results, logger });
      logger.info(`ingest: backfilled ${date}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`ingest: backfill ${date} failed: ${msg}`);
    }
  }
}

function parseFetchArgs(argv: string[]): {
  ticker?: string;
  force: boolean;
  explicitSessionDate?: string;
} {
  const force = argv.includes("--force");
  const explicitSessionDate = parseOptionalYmdFromArgv(argv, "--date");

  const idx = argv.indexOf("--ticker");
  if (idx !== -1 && argv[idx + 1] !== undefined && argv[idx + 1]!.length > 0) {
    return { ticker: argv[idx + 1], force, explicitSessionDate };
  }
  return { force, explicitSessionDate };
}

/**
 * True when every `ticker` already has at least one daily row on or after `sessionDate`
 * (same per-symbol currency idea as the legacy per-ticker aggs path).
 */
function isDbCurrentForSession(
  db: CueDatabase,
  tickersUpper: readonly string[],
  sessionDate: string,
): boolean {
  if (tickersUpper.length === 0) {
    return true;
  }
  const placeholders = tickersUpper.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ticker, MAX(date) AS m FROM daily_prices WHERE ticker IN (${placeholders}) GROUP BY ticker`,
    )
    .all(...tickersUpper) as { ticker: string; m: string | null }[];

  const maxByTicker = new Map(rows.map((r) => [r.ticker.toUpperCase(), r.m]));
  for (const t of tickersUpper) {
    const m = maxByTicker.get(t);
    if (m === undefined || m === null || m.localeCompare(sessionDate) < 0) {
      return false;
    }
  }
  return true;
}

function buildGroupedDailyUrl(dateString: string, apiKey: string): string {
  const pathSeg = `/v2/aggs/grouped/locale/us/market/stocks/${dateString}`;
  const u = new URL(pathSeg, `${MASSIVE_REST_BASE}/`);
  u.searchParams.set("adjusted", "true");
  u.searchParams.set("apiKey", apiKey);
  return u.toString();
}

async function fetchGroupedDaily(input: {
  apiKey: string;
  dateString: string;
}): Promise<MassiveGroupedBar[]> {
  const url = buildGroupedDailyUrl(input.dateString, input.apiKey);
  const httpClient = createHttpClient();
  const http = await httpClient.get<unknown>(url, {
    validateStatus: () => true,
  });
  if (http.status !== 200) {
    throw new Error(`Massive grouped HTTP ${String(http.status)}: ${JSON.stringify(http.data)}`);
  }
  if (typeof http.data === "object" && http.data !== null) {
    const raw = http.data as Record<string, unknown>;
    if (raw.results === undefined || raw.resultsCount === 0) {
      cueLogger.info(
        `massive: no results for ${input.dateString} — treating as holiday/non-trading day`,
      );
      return [];
    }
  }
  const parsed = massiveGroupedResponseSchema.safeParse(http.data);
  if (!parsed.success) {
    throw new Error(`Massive grouped response validation failed: ${parsed.error.message}`);
  }
  const body = parsed.data;
  if (body.status !== undefined && body.status.toUpperCase() === "ERROR") {
    throw new Error(`Massive grouped error: ${JSON.stringify(http.data)}`);
  }
  return body.results;
}

/**
 * One grouped-daily HTTP response → SQLite `daily_prices` for `sessionDate`, universe-masked,
 * single transaction, quorum guard.
 */
function insertGroupedSessionRows(input: {
  db: CueDatabase;
  sessionDate: string;
  tickerMask: ReadonlySet<string>;
  expectedMaskCount: number;
  rows: MassiveGroupedBar[];
  logger: winston.Logger;
  /** When false, insert matched rows even if below 80% universe quorum (historical backfill). */
  requireQuorum?: boolean;
}): void {
  const { db, sessionDate, tickerMask, expectedMaskCount, rows, logger } = input;
  const requireQuorum = input.requireQuorum !== false;

  const matched = rows.filter((r) => tickerMask.has(r.T.toUpperCase()));
  const quorum = expectedMaskCount * QUORUM_THRESHOLD;
  if (requireQuorum && matched.length < quorum) {
    logger.warn(
      `Partial data anomaly: expected at least ${String(Math.ceil(quorum))} universe matches for ${sessionDate}, found ${String(matched.length)}. Aborting transactional commit.`,
      { sessionDate, expectedMaskCount, matchedCount: matched.length },
    );
    throw new Error("Ingestion aborted: Massive grouped payload is incomplete.");
  }
  if (!requireQuorum && matched.length === 0) {
    logger.info(`Grouped ingest: 0 universe matches for ${sessionDate}; skipping.`);
    return;
  }

  const insertStmt = db.prepare(`
    INSERT INTO daily_prices (ticker, date, open, high, low, close, volume, created_at)
    VALUES (@ticker, @date, @open, @high, @low, @close, @volume, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker, date) DO NOTHING
  `);

  const runInsertTransaction = db.transaction((batch: MassiveGroupedBar[]) => {
    for (const row of batch) {
      const ticker = row.T.toUpperCase();
      insertStmt.run({
        ticker,
        date: sessionDate,
        open: row.o,
        high: row.h,
        low: row.l,
        close: row.c,
        volume: Math.trunc(row.v),
      });
    }
  });

  runInsertTransaction(matched);
  logger.info(`Grouped ingest: wrote ${String(matched.length)} rows for ${sessionDate}.`);
}

async function run(argv: readonly string[] = process.argv): Promise<void> {
  const config = getConfig();
  const logger = createLogger();
  const projectRoot = process.cwd();
  const { ticker: singleTicker, force, explicitSessionDate } = parseFetchArgs([...argv]);

  const universe = loadUniverseTickers(projectRoot);
  const meta = tryLoadUniverseMeta(projectRoot);
  if (meta !== null && !universeMetaMatchesTickerCount(meta, universe.length)) {
    logger.warn(
      `Universe metadata mismatch: _meta.json total_ticker_count=${String(meta.total_ticker_count)} but ${String(universe.length)} tickers in universe file`,
      { universeName: meta.universe_name, asOf: meta.as_of_date },
    );
  } else if (meta !== null) {
    logger.info("Universe metadata", {
      universeName: meta.universe_name,
      asOf: meta.as_of_date,
      tickerCount: universe.length,
      systemAdditions: meta.system_additions,
    });
  }

  const tickersForMask =
    singleTicker !== undefined ? [singleTicker.toUpperCase()] : [...universe, "QQQ"];

  const tickerMask = new Set(tickersForMask.map((t) => t.toUpperCase()));
  const expectedMaskCount = tickerMask.size;

  const db = openCueDb(config.DB_PATH);
  try {
    const tickersUpper = [...tickerMask];
    const resolved = await resolveSessionDateAndResults({
      db,
      apiKey: config.POLYGON_API_KEY,
      now: new Date(),
      explicitDate: explicitSessionDate,
      force,
      tickersUpper,
      logger,
    });

    if (resolved === null) {
      // Already current or explicit date resolved to no-op.
      return;
    }

    insertGroupedSessionRows({
      db,
      sessionDate: resolved.sessionDate,
      tickerMask,
      expectedMaskCount,
      rows: resolved.results,
      logger,
    });

    // Auto-backfill any gaps within the last 5 weekdays (handles transition day,
    // missed pipeline runs, etc.). Skipped when --ticker is set (single-ticker probe).
    if (singleTicker === undefined) {
      await backfillRecentGaps({
        db,
        apiKey: config.POLYGON_API_KEY,
        primarySessionDate: resolved.sessionDate,
        now: new Date(),
        tickerMask,
        expectedMaskCount,
        lookback: 5,
        logger,
      });
    }
  } finally {
    db.close();
  }
}

type FetchGroupedDailyFn = (input: {
  apiKey: string;
  dateString: string;
}) => Promise<MassiveGroupedBar[]>;

/**
 * Resolve which session date to ingest and fetch its grouped bars.
 *
 * Strategy (when no `--date` is given): try T+0 (current ET weekday) first; if the
 * API returns 0 bars or throws, fall back to T-1. After a T-1 fallback, set
 * `pipeline_state.last_ingest_was_stale` when that date already exists in `daily_prices`.
 *
 * Returns `null` when `daily_prices` is already current and `force` is false.
 */
async function resolveSessionDateAndResults(input: {
  db: CueDatabase;
  apiKey: string;
  now: Date;
  explicitDate: string | undefined;
  force: boolean;
  tickersUpper: string[];
  logger: winston.Logger;
  fetchGroupedDailyFn?: FetchGroupedDailyFn;
}): Promise<{ sessionDate: string; results: MassiveGroupedBar[] } | null> {
  const { db, apiKey, now, explicitDate, force, tickersUpper, logger } = input;
  const fetchBars = input.fetchGroupedDailyFn ?? fetchGroupedDaily;

  // Explicit --date: single attempt, no T+0/T-1 logic.
  if (explicitDate !== undefined) {
    if (!force && isDbCurrentForSession(db, tickersUpper, explicitDate)) {
      logger.info("daily_prices already current for session; skipping Massive API", {
        sessionDate: explicitDate,
        tickerCount: tickersUpper.length,
      });
      return null;
    }
    const results = await fetchBars({ apiKey, dateString: explicitDate });
    return { sessionDate: explicitDate, results };
  }

  const t0 = currentEtWeekdaySession(now);
  const t1 = previousWeekdayBeforeEtCivil(now);

  if (!force && isDbCurrentForSession(db, tickersUpper, t0)) {
    setPipelineState(db, "last_ingest_was_stale", "0");
    logger.info("daily_prices already current for T+0; skipping Massive API", {
      sessionDate: t0,
      tickerCount: tickersUpper.length,
    });
    return null;
  }

  try {
    const t0Results = await fetchBars({ apiKey, dateString: t0 });
    if (t0Results.length > 0) {
      setPipelineState(db, "last_ingest_was_stale", "0");
      logger.info("ingest: using T+0 session", { sessionDate: t0 });
      return { sessionDate: t0, results: t0Results };
    }
    logger.info(`ingest: T+0 (${t0}) returned 0 bars; falling back to T-1`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`ingest: T+0 (${t0}) fetch failed; falling back to T-1: ${msg}`);
  }

  if (!force && isDbCurrentForSession(db, tickersUpper, t1)) {
    markT1IngestStaleness(db, t1);
    logger.info("daily_prices already current for T-1; skipping Massive API", {
      sessionDate: t1,
      tickerCount: tickersUpper.length,
    });
    return null;
  }

  logger.info("ingest: using T-1 session", { sessionDate: t1 });
  const results = await fetchBars({ apiKey, dateString: t1 });
  markT1IngestStaleness(db, t1);
  return { sessionDate: t1, results };
}

/** Mon–Fri ISO dates from `start` through `end` inclusive (UTC calendar walk). */
export function weekdaysBetweenInclusive(start: string, end: string): string[] {
  const results: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    const dow = new Date(`${cursor}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      results.push(cursor);
    }
    cursor = addCalendarDays(cursor, 1);
  }
  return results;
}

export interface UniversePriceCoverageRow {
  ticker: string;
  bars: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** Count `daily_prices` bars per universe ticker through optional `asOf`. */
export function reportUniversePriceCoverage(
  db: CueDatabase,
  universe: readonly string[],
  minBars: number,
  asOf?: string,
): { short: UniversePriceCoverageRow[]; eligible: number } {
  const stmt = asOf
    ? db.prepare(
        `SELECT COUNT(*) AS bars, MIN(date) AS firstDate, MAX(date) AS lastDate
         FROM daily_prices WHERE ticker = ? AND date <= ?`,
      )
    : db.prepare(
        `SELECT COUNT(*) AS bars, MIN(date) AS firstDate, MAX(date) AS lastDate
         FROM daily_prices WHERE ticker = ?`,
      );

  const short: UniversePriceCoverageRow[] = [];
  let eligible = 0;
  for (const ticker of universe) {
    const row = (
      asOf ? stmt.get(ticker, asOf) : stmt.get(ticker)
    ) as { bars: number; firstDate: string | null; lastDate: string | null };
    if (row.bars >= minBars) {
      eligible += 1;
      continue;
    }
    short.push({
      ticker,
      bars: row.bars,
      firstDate: row.firstDate,
      lastDate: row.lastDate,
    });
  }
  return { short, eligible };
}

export interface HistoricalPriceBackfillOpts {
  readonly from?: string;
  readonly to?: string;
  readonly minBars?: number;
}

/**
 * Deep grouped-daily backfill for universe + QQQ over a date range.
 * ponytail: one HTTP call per session day; `requireQuorum: false` so partial historical payloads still land.
 */
export async function runHistoricalPriceBackfill(
  opts: HistoricalPriceBackfillOpts = {},
): Promise<void> {
  const config = getConfig();
  const logger = createLogger();
  const projectRoot = process.cwd();
  const universe = loadUniverseTickers(projectRoot);
  const tickersForMask = [...universe, "QQQ"];
  const tickerMask = new Set(tickersForMask.map((t) => t.toUpperCase()));
  const expectedMaskCount = tickerMask.size;
  const minBars = opts.minBars ?? 252;

  const db = openCueDb(config.DB_PATH);
  try {
    const latestRow = db
      .prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`)
      .get() as { d: string | null };
    const to = opts.to ?? latestRow.d ?? resolveLastETSession();
    const from = opts.from ?? addCalendarDays(to, -600);

    if (from > to) {
      throw new Error(`backfill-prices: --from ${from} is after --to ${to}`);
    }

    const sessions = weekdaysBetweenInclusive(from, to);
    logger.info(
      `backfill-prices: ${String(sessions.length)} session(s) from ${from} to ${to} for ${String(universe.length)} universe tickers`,
    );

    let filled = 0;
    const missingForDateStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM daily_prices WHERE ticker = ? AND date = ? LIMIT 1`,
    );
    for (const sessionDate of sessions) {
      let missing = 0;
      for (const t of tickersForMask) {
        const row = missingForDateStmt.get(t, sessionDate) as { c: number };
        if ((row?.c ?? 0) === 0) {
          missing += 1;
        }
      }
      if (missing === 0) {
        continue;
      }
      try {
        const results = await fetchGroupedDaily({
          apiKey: config.POLYGON_API_KEY,
          dateString: sessionDate,
        });
        if (results.length === 0) {
          logger.info(`backfill-prices: ${sessionDate} — 0 bars (holiday), skipping`);
          continue;
        }
        insertGroupedSessionRows({
          db,
          sessionDate,
          tickerMask,
          expectedMaskCount,
          rows: results,
          logger,
          requireQuorum: false,
        });
        filled += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`backfill-prices: ${sessionDate} failed: ${msg}`);
      }
      // ponytail: free-tier Massive caps requests/min; 300ms keeps deep backfill under limit
      await delay(300);
    }

    const coverage = reportUniversePriceCoverage(db, universe, minBars, to);
    logger.info(
      `backfill-prices: wrote ${String(filled)} new session(s); coverage ${String(coverage.eligible)}/${String(universe.length)} tickers with >=${String(minBars)} bars through ${to}`,
    );
    if (coverage.short.length > 0) {
      for (const row of coverage.short) {
        logger.warn(
          `backfill-prices: short history ${row.ticker} bars=${String(row.bars)} first=${row.firstDate ?? "n/a"} last=${row.lastDate ?? "n/a"}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

if (isMain) {
  run().catch((err: unknown) => {
    const logger = createCueLogger("massive-ingest");
    const message =
      err instanceof Error ? err.message : util.inspect(err, { depth: 8 });
    logger.error(`Fetcher fatal error: ${message}`);
    if (err instanceof Error && err.stack !== undefined && err.stack.length > 0) {
      logger.error(err.stack);
    }
    process.exitCode = 1;
  });
}

export async function runFetcher(argv?: readonly string[]): Promise<void> {
  await run(argv ?? process.argv);
}

/** Last completed US equity session date expected in `daily_prices` after ingest (ET). */
export function resolveLastETSession(now: Date = new Date()): string {
  return previousWeekdayBeforeEtCivil(now);
}

export {
  currentEtWeekdaySession,
  fetchGroupedDaily,
  insertGroupedSessionRows,
  markT1IngestStaleness,
  previousWeekdayBeforeEtCivil,
  resolveSessionDateAndResults,
};
