import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";

import axios from "axios";
import Database from "better-sqlite3";
import { z } from "zod";
import winston from "winston";

import { getConfig } from "../config/index.js";
import { insertDailyPrices } from "../db/queries.js";
import { initSchema } from "../db/schema.js";
import {
  readCachedOhlcvIfFresh,
  writeCachedOhlcv,
} from "./cache.js";
import {
  type CachedOhlcvBundle,
  type DailyOhlcvBar,
  massiveStocksAggregatesResponseSchema,
  type MassiveStocksAggResult,
} from "./types.js";

function createHttpClient(): import("axios").AxiosInstance {
  const client = axios.create({ timeout: 60_000 });

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
const AGGS_PAGE_LIMIT = 50_000;
const MAX_AGG_PAGES = 500;

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

function formatLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Latest Mon–Fri on or before the local calendar day of `fromDate`, stepping back at most 5 days
 * (covers Fri–Sun weekend gaps; returns null if no weekday found → treat DB as stale).
 */
function latestWeekday(fromDate: Date): string | null {
  const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  for (let i = 0; i < 5; i++) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      return formatLocalYmd(d);
    }
    d.setDate(d.getDate() - 1);
  }
  return null;
}

function rangeEndYmd(): string {
  return formatLocalYmd(new Date());
}

function rangeStartYmdFiveYears(end: string): string {
  const [yy, mm, dd] = end.split("-").map(Number);
  const d = new Date(yy!, mm! - 1, dd!);
  d.setFullYear(d.getFullYear() - 5);
  return formatLocalYmd(d);
}

function barDateFromUnixMs(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function mapMassiveResultsToBars(results: MassiveStocksAggResult[]): DailyOhlcvBar[] {
  const bars = results.map((r) => ({
    date: barDateFromUnixMs(r.t),
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: Math.trunc(r.v),
  }));
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

function parseFetchArgs(argv: string[]): { ticker?: string } {
  const idx = argv.indexOf("--ticker");
  if (idx !== -1 && argv[idx + 1] !== undefined && argv[idx + 1]!.length > 0) {
    return { ticker: argv[idx + 1] };
  }
  return {};
}

function loadUniverseTickers(projectRoot: string): string[] {
  const filePath = path.join(projectRoot, "data", "universe", "nasdaq100.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const data = universeSchema.parse(parsed);
  return data.tickers.map((t) => t.toUpperCase());
}

function openDb(dbPath: string): InstanceType<typeof Database> {
  const resolved = path.isAbsolute(dbPath)
    ? dbPath
    : path.resolve(process.cwd(), dbPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(resolved);
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function maxDailyPriceDate(db: InstanceType<typeof Database>, ticker: string): string | null {
  const row = db
    .prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = ?`)
    .get(ticker.toUpperCase()) as { d: string | null };
  return row.d;
}

function buildInitialAggsUrl(input: {
  ticker: string;
  start: string;
  end: string;
  apiKey: string;
}): string {
  const pathSeg = `/v2/aggs/ticker/${encodeURIComponent(input.ticker)}/range/1/day/${input.start}/${input.end}`;
  const u = new URL(pathSeg, `${MASSIVE_REST_BASE}/`);
  u.searchParams.set("adjusted", "true");
  u.searchParams.set("sort", "asc");
  u.searchParams.set("limit", String(AGGS_PAGE_LIMIT));
  u.searchParams.set("apiKey", input.apiKey);
  return u.toString();
}

/** Ensures `apiKey` is present (Massive `next_url` pages may omit it). */
function ensureApiKeyOnUrl(url: string, apiKey: string): string {
  const u = new URL(url);
  if (!u.searchParams.has("apiKey")) {
    u.searchParams.set("apiKey", apiKey);
  }
  return u.toString();
}

async function fetchMassiveDailyAggs(input: {
  apiKey: string;
  ticker: string;
  start: string;
  end: string;
}): Promise<DailyOhlcvBar[]> {
  const byTs = new Map<number, MassiveStocksAggResult>();
  let nextUrl: string | null = buildInitialAggsUrl(input);
  let pageIndex = 0;

  while (nextUrl !== null) {
    if (pageIndex > 0) {
      await delay(12_000);
    }
    if (pageIndex >= MAX_AGG_PAGES) {
      throw new Error(
        `Massive aggs pagination exceeded ${String(MAX_AGG_PAGES)} pages`,
      );
    }
    const url = ensureApiKeyOnUrl(nextUrl, input.apiKey);
    const httpClient = createHttpClient();
    const http = await httpClient.get<unknown>(url, {
      validateStatus: () => true,
    });
    if (http.status !== 200) {
      throw new Error(
        `Massive HTTP ${String(http.status)}: ${JSON.stringify(http.data)}`,
      );
    }
    const parsed = massiveStocksAggregatesResponseSchema.safeParse(http.data);
    if (!parsed.success) {
      throw new Error(
        `Massive response validation failed: ${parsed.error.message}`,
      );
    }
    const body = parsed.data;
    if (body.status !== undefined && body.status.toUpperCase() === "ERROR") {
      throw new Error(`Massive aggregates error: ${JSON.stringify(http.data)}`);
    }
    for (const r of body.results ?? []) {
      byTs.set(r.t, r);
    }
    const rawNext = body.next_url;
    nextUrl =
      rawNext !== undefined && rawNext !== null && rawNext.length > 0
        ? rawNext
        : null;
    pageIndex += 1;
  }

  const merged = [...byTs.values()].sort((a, b) => a.t - b.t);
  return mapMassiveResultsToBars(merged);
}

async function run(): Promise<void> {
  const config = getConfig();
  const logger = createLogger();
  const projectRoot = process.cwd();
  const { ticker: singleTicker } = parseFetchArgs(process.argv);

  const tickers =
    singleTicker !== undefined
      ? [singleTicker.toUpperCase()]
      : loadUniverseTickers(projectRoot);

  const rangeEnd = rangeEndYmd();
  const rangeStart = rangeStartYmdFiveYears(rangeEnd);
  const [ey, em, ed] = rangeEnd.split("-").map(Number);
  const expectedLastTradingDate = latestWeekday(new Date(ey!, em! - 1, ed!));

  const db = openDb(config.DB_PATH);
  try {
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i]!;
      const maxDate = maxDailyPriceDate(db, ticker);
      const dbCurrent =
        expectedLastTradingDate !== null &&
        maxDate !== null &&
        maxDate.localeCompare(expectedLastTradingDate) >= 0;

      if (dbCurrent) {
        const cached = readCachedOhlcvIfFresh(
          config.CACHE_DIR,
          ticker,
          rangeStart,
          rangeEnd,
          Number.MAX_SAFE_INTEGER,
        );
        if (cached !== null) {
          logger.info("OHLCV cache hit; skipping Massive API", {
            ticker,
            rangeStart,
            rangeEnd,
            maxDate,
            expectedLastTradingDate,
          });
          insertDailyPrices(db, ticker, cached.bars);
          continue;
        }
        logger.info("OHLCV DB current; skipping Massive API (no disk cache for range)", {
          ticker,
          rangeStart,
          rangeEnd,
          maxDate,
          expectedLastTradingDate,
        });
        continue;
      }

      let bars: DailyOhlcvBar[] = [];
      try {
        bars = await fetchMassiveDailyAggs({
          apiKey: config.POLYGON_API_KEY,
          ticker,
          start: rangeStart,
          end: rangeEnd,
        });
        const bundle: CachedOhlcvBundle = {
          ticker,
          rangeStart,
          rangeEnd,
          bars,
        };
        writeCachedOhlcv(config.CACHE_DIR, bundle);
        insertDailyPrices(db, ticker, bars);
        logger.info("Fetched OHLCV from Massive", {
          ticker,
          barCount: bars.length,
          rangeStart,
          rangeEnd,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Massive fetch failed; skipping ticker", {
          ticker,
          error: message,
        });
      }

      const isLast = i === tickers.length - 1;
      if (!isLast) {
        await delay(12_000);
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

export { run as runFetcher };
