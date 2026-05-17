import fs from "node:fs";
import path from "node:path";
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
  polygonAggsResponseSchema,
  type PolygonAggResult,
} from "./types.js";

const universeSchema = z.object({
  tickers: z.array(z.string().min(1)),
});

const POLYGON_BASE = "https://api.polygon.io";

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

function mapPolygonResultsToBars(results: PolygonAggResult[]): DailyOhlcvBar[] {
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

async function fetchPolygonDailyAggs(input: {
  apiKey: string;
  ticker: string;
  start: string;
  end: string;
}): Promise<DailyOhlcvBar[]> {
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(
    input.ticker,
  )}/range/1/day/${input.start}/${input.end}`;
  const response = await axios.get<unknown>(url, {
    params: {
      adjusted: "true",
      sort: "asc",
      apiKey: input.apiKey,
    },
    timeout: 60_000,
    validateStatus: () => true,
  });
  if (response.status !== 200) {
    throw new Error(
      `Polygon HTTP ${String(response.status)}: ${JSON.stringify(response.data)}`,
    );
  }
  const parsed = polygonAggsResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(
      `Polygon response validation failed: ${parsed.error.message}`,
    );
  }
  const results = parsed.data.results ?? [];
  return mapPolygonResultsToBars(results);
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

  const db = openDb(config.DB_PATH);
  try {
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i]!;
      const cached = readCachedOhlcvIfFresh(
        config.CACHE_DIR,
        ticker,
        rangeStart,
        rangeEnd,
      );
      if (cached !== null) {
        logger.info("OHLCV cache hit; skipping API", {
          ticker,
          rangeStart,
          rangeEnd,
        });
        insertDailyPrices(db, ticker, cached.bars);
        continue;
      }

      let bars: DailyOhlcvBar[] = [];
      try {
        bars = await fetchPolygonDailyAggs({
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
        logger.info("Fetched OHLCV from Polygon", {
          ticker,
          barCount: bars.length,
          rangeStart,
          rangeEnd,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Polygon fetch failed; skipping ticker", {
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
  run().catch((err) => {
    const logger = winston.createLogger({
      transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
    });
    logger.error("Fetcher fatal error", { err });
    process.exitCode = 1;
  });
}

export { run as runFetcher };
