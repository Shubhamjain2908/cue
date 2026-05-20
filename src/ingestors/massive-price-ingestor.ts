import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";

import axios from "axios";
import { z } from "zod";
import winston from "winston";

import { CUE_LOCALE, CUE_TIME_ZONE } from "../config/cue-timezone.js";
import { getConfig } from "../config/index.js";
import { openCueDb, type CueDatabase } from "../db/provider.js";
import {
  massiveGroupedResponseSchema,
  type MassiveGroupedBar,
} from "./types.js";

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
        config._retryCount < 3 && (status === 429 || status === 500 || status === 503);

      if (!shouldRetry) {
        return Promise.reject(error);
      }

      config._retryCount += 1;
      const backoffMs = Math.pow(2, config._retryCount - 1) * 1000; // 1s, 2s, 4s
      await delay(backoffMs);
      return client(config);
    },
  );

  return client;
}

const universeSchema = z.object({
  tickers: z.array(z.string().min(1)),
});

const MASSIVE_REST_BASE = "https://api.massive.com";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createLogger(): winston.Logger {
  const { LOG_LEVEL } = getConfig();
  return winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf((info) => {
        const { timestamp, level, message, ...rest } = info;
        const extra =
          Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
        return `${String(timestamp)} ${level}: ${String(message)}${extra}`;
      }),
    ),
    transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
  });
}

/** ET civil calendar parts for `now` (aligns ingest with US equity dates / pipeline). */
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

function formatEtYmd(now: Date): string {
  const { year, month, day } = getEtCalendarParts(now);
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Gregorian weekday for an America/New_York civil date (0 Sun … 6 Sat), UTC-noon anchor. */
function weekdayUtcForNyCivilDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

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
    const dow = weekdayUtcForNyCivilDate(y, mo, d);
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

function rangeEndYmd(): string {
  return formatEtYmd(new Date());
}

const ymdArgRegex = /^\d{4}-\d{2}-\d{2}$/;

/** Validates `YYYY-MM-DD` and that the calendar date exists (e.g. not 2026-02-31). */
function parseExplicitSessionDate(raw: string): string {
  const trimmed = raw.trim();
  if (!ymdArgRegex.test(trimmed)) {
    throw new Error(
      `Invalid --date "${raw}": expected YYYY-MM-DD (example: 2026-05-19)`,
    );
  }
  const [ys, ms, ds] = trimmed.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const civil = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (
    civil.getUTCFullYear() !== y ||
    civil.getUTCMonth() + 1 !== m ||
    civil.getUTCDate() !== d
  ) {
    throw new Error(`Invalid --date "${raw}": not a valid calendar day`);
  }
  return trimmed;
}

function parseFetchArgs(argv: string[]): {
  ticker?: string;
  force: boolean;
  explicitSessionDate?: string;
} {
  const force = argv.includes("--force");
  const dateIdx = argv.indexOf("--date");
  let explicitSessionDate: string | undefined;
  if (dateIdx !== -1 && argv[dateIdx + 1] !== undefined && argv[dateIdx + 1]!.length > 0) {
    explicitSessionDate = parseExplicitSessionDate(String(argv[dateIdx + 1]));
  }

  const idx = argv.indexOf("--ticker");
  if (idx !== -1 && argv[idx + 1] !== undefined && argv[idx + 1]!.length > 0) {
    return { ticker: argv[idx + 1], force, explicitSessionDate };
  }
  return { force, explicitSessionDate };
}

function loadUniverseTickers(projectRoot: string): string[] {
  const filePath = path.join(projectRoot, "data", "universe", "nasdaq100.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const data = universeSchema.parse(parsed);
  return data.tickers.map((t) => t.toUpperCase());
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
}): void {
  const { db, sessionDate, tickerMask, expectedMaskCount, rows, logger } = input;

  const matched = rows.filter((r) => tickerMask.has(r.T.toUpperCase()));
  const quorum = expectedMaskCount * 0.8;
  if (matched.length < quorum) {
    logger.warn(
      `Partial data anomaly: expected at least ${String(Math.ceil(quorum))} universe matches for ${sessionDate}, found ${String(matched.length)}. Aborting transactional commit.`,
      { sessionDate, expectedMaskCount, matchedCount: matched.length },
    );
    throw new Error("Ingestion aborted: Massive grouped payload is incomplete.");
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
  const tickersForMask =
    singleTicker !== undefined ? [singleTicker.toUpperCase()] : [...universe, "QQQ"];

  const tickerMask = new Set(tickersForMask.map((t) => t.toUpperCase()));
  const expectedMaskCount = tickerMask.size;

  let sessionDate: string;
  if (explicitSessionDate !== undefined) {
    sessionDate = explicitSessionDate;
  } else {
    const rangeEnd = rangeEndYmd();
    const [ey, em, ed] = rangeEnd.split("-").map(Number);
    const resolved = latestWeekdayOnOrBeforeEtCivil(ey!, em!, ed!);
    if (resolved === null) {
      throw new Error("Could not resolve ET session date for grouped ingest");
    }
    sessionDate = resolved;
  }

  const db = openCueDb(config.DB_PATH);
  try {
    const tickersUpper = [...tickerMask];
    if (!force && isDbCurrentForSession(db, tickersUpper, sessionDate)) {
      logger.info("daily_prices already current for session; skipping Massive API", {
        sessionDate,
        force,
        tickerCount: tickersUpper.length,
      });
      return;
    }

    const results = await fetchGroupedDaily({
      apiKey: config.POLYGON_API_KEY,
      dateString: sessionDate,
    });

    insertGroupedSessionRows({
      db,
      sessionDate,
      tickerMask,
      expectedMaskCount,
      rows: results,
      logger,
    });
  } finally {
    db.close();
  }
}

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) ===
  path.resolve(process.argv[1] ?? "");

if (isMain) {
  run().catch((err: unknown) => {
    const logger = winston.createLogger({
      transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
    });
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
