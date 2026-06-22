import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLiveScreen } from "../../src/analysers/momentum-screener.js";
import { cueLogger } from "../../src/cli/cue-logger.js";
import { resetConfigCache } from "../../src/config/index.js";
import { DEFAULT_RANKING_CONFIG } from "../../src/enrichers/momentum-types.js";
import { insertDailyPrices } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

const TEN_TICKERS = [
  "T01",
  "T02",
  "T03",
  "T04",
  "T05",
  "T06",
  "T07",
  "T08",
  "T09",
  "T10",
] as const;

vi.mock("../../src/universe/load-universe.js", () => ({
  loadUniverseTickers: () => [...TEN_TICKERS],
  tryLoadUniverseMeta: () => null,
  universeMetaMatchesTickerCount: () => true,
}));

vi.mock("../../src/cli/cue-logger.js", () => ({
  createCueLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
  cueLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const savedEnv = { ...process.env };

type SqliteConnection = InstanceType<typeof Database>;

function envBase(): void {
  resetConfigCache();
  Object.assign(process.env, savedEnv);
  process.env.POLYGON_API_KEY = "p";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "c";
  process.env.WATCHLIST_BENCH_DEPTH = "0";
}

function openTestDb(): SqliteConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function makeCloses(start: number, end: number, n = 320): number[] {
  const arr = new Array(n).fill(100);
  arr[n - 252] = start;
  arr[n - 21] = end;
  return arr;
}

function barsFromCloses(
  closes: number[],
  startDate = "2023-01-03",
): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  return closes.map((close, i) => {
    const ms = Date.parse(`${startDate}T12:00:00Z`) + i * 86_400_000;
    const dt = new Date(ms);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const da = String(dt.getUTCDate()).padStart(2, "0");
    const date = `${y}-${mo}-${da}`;
    return { date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000_000 };
  });
}

function latestQqqDate(db: SqliteConnection): string {
  return (db.prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`).get() as {
    d: string;
  }).d;
}

/** Ten tickers with distinct 12-1 momentum (T01 highest … T10 lowest). */
function seedTenTickerUniverse(db: SqliteConnection, asOf: string): void {
  const momentumEnds: Record<string, number> = {
    T01: 220,
    T02: 210,
    T03: 200,
    T04: 190,
    T05: 180,
    T06: 170,
    T07: 160,
    T08: 150,
    T09: 140,
    T10: 130,
  };
  for (const [ticker, end] of Object.entries(momentumEnds)) {
    insertDailyPrices(db, ticker, barsFromCloses(makeCloses(80, end)));
  }
  const qqqCloses = Array.from({ length: 320 }, (_, i) => 80 + (i / 319) * 120);
  insertDailyPrices(db, "QQQ", barsFromCloses(qqqCloses));
  db.prepare(`DELETE FROM daily_prices WHERE ticker = 'QQQ' AND date > ?`).run(asOf);
  for (const ticker of TEN_TICKERS) {
    db.prepare(`DELETE FROM daily_prices WHERE ticker = ? AND date > ?`).run(ticker, asOf);
  }
}

function runRebalance(db: SqliteConnection): void {
  seedTenTickerUniverse(db, "2099-12-31");
  const asOf = latestQqqDate(db);
  runLiveScreen(db, "rebalance", { asOf });
}

describe("runLiveScreen rebalance top-N cap", () => {
  beforeEach(() => {
    envBase();
    vi.mocked(cueLogger.warn).mockClear();
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    resetConfigCache();
    DEFAULT_RANKING_CONFIG.topN = 3;
  });

  it("opens at most 3 BUY positions when MAX_POSITIONS=10 (LOCKED_TOP_N)", () => {
    process.env.MAX_POSITIONS = "10";
    resetConfigCache();

    const db = openTestDb();
    runRebalance(db);

    const buyCount = db
      .prepare(`SELECT COUNT(*) AS c FROM signals WHERE signal = 'BUY' AND date = (SELECT MAX(date) FROM signals)`)
      .get() as { c: number };
    expect(buyCount.c).toBe(3);

    const openCount = db
      .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`)
      .get() as { c: number };
    expect(openCount.c).toBe(3);

    db.close();
  });

  it("warns when MAX_POSITIONS exceeds LOCKED_TOP_N", () => {
    process.env.MAX_POSITIONS = "10";
    resetConfigCache();

    const db = openTestDb();
    runRebalance(db);

    expect(vi.mocked(cueLogger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("Clamping to 3"),
    );
    db.close();
  });

  it("does not warn when MAX_POSITIONS equals LOCKED_TOP_N", () => {
    process.env.MAX_POSITIONS = "3";
    resetConfigCache();

    const db = openTestDb();
    runRebalance(db);

    expect(vi.mocked(cueLogger.warn)).not.toHaveBeenCalled();
    db.close();
  });

  it("respects MAX_POSITIONS below LOCKED_TOP_N without warning", () => {
    process.env.MAX_POSITIONS = "2";
    resetConfigCache();

    const db = openTestDb();
    runRebalance(db);

    expect(vi.mocked(cueLogger.warn)).not.toHaveBeenCalled();

    const openCount = db
      .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`)
      .get() as { c: number };
    expect(openCount.c).toBe(2);

    db.close();
  });

  it("LOCKED_TOP_N is not shadowed by RankingConfig.topN", () => {
    process.env.MAX_POSITIONS = "10";
    resetConfigCache();
    DEFAULT_RANKING_CONFIG.topN = 99;

    const db = openTestDb();
    runRebalance(db);

    const buyCount = db
      .prepare(`SELECT COUNT(*) AS c FROM signals WHERE signal = 'BUY'`)
      .get() as { c: number };
    expect(buyCount.c).toBe(3);

    db.close();
  });
});
