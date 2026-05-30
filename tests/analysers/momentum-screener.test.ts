import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLiveScreen } from "../../src/analysers/momentum-screener.js";
import { resetConfigCache } from "../../src/config/index.js";
import { insertDailyPrices } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

const savedEnv = { ...process.env };

vi.mock("../../src/universe/load-universe.js", () => ({
  loadUniverseTickers: () => ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"],
  tryLoadUniverseMeta: () => null,
  universeMetaMatchesTickerCount: () => true,
}));

type SqliteConnection = InstanceType<typeof Database>;

function envBase(): void {
  resetConfigCache();
  Object.assign(process.env, savedEnv);
  process.env.POLYGON_API_KEY = "p";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "c";
  process.env.WATCHLIST_BENCH_DEPTH = "5";
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

function seedUniverse(db: SqliteConnection, asOf: string): void {
  const momentumEnds: Record<string, number> = {
    AAA: 200,
    BBB: 180,
    CCC: 160,
    DDD: 140,
    EEE: 120,
    FFF: 110,
    GGG: 105,
    HHH: 100,
  };
  for (const [ticker, end] of Object.entries(momentumEnds)) {
    insertDailyPrices(db, ticker, barsFromCloses(makeCloses(80, end)));
  }
  const qqqCloses = Array.from({ length: 320 }, (_, i) => 80 + (i / 319) * 120);
  insertDailyPrices(db, "QQQ", barsFromCloses(qqqCloses));
  db.prepare(`DELETE FROM daily_prices WHERE ticker = 'QQQ' AND date > ?`).run(asOf);
  for (const ticker of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]) {
    db.prepare(`DELETE FROM daily_prices WHERE ticker = ? AND date > ?`).run(ticker, asOf);
  }
}

describe("runLiveScreen WATCHLIST bench", () => {
  beforeEach(() => {
    envBase();
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    resetConfigCache();
  });

  it("persists WATCHLIST rows for ranks 4–8 on rebalance", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);

    seedUniverse(db, "2099-12-31");
    const asOf = (
      db.prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`).get() as {
        d: string;
      }
    ).d;

    runLiveScreen(db, "rebalance", { asOf });

    const watchlist = db
      .prepare(
        `SELECT ticker, momentum_rank AS rank, signal FROM signals WHERE signal = 'WATCHLIST' ORDER BY momentum_rank ASC`,
      )
      .all() as Array<{ ticker: string; rank: number; signal: string }>;

    expect(watchlist).toHaveLength(5);
    expect(watchlist.map((r) => r.rank)).toEqual([4, 5, 6, 7, 8]);
    expect(watchlist.every((r) => r.signal === "WATCHLIST")).toBe(true);

    const positions = db.prepare(`SELECT COUNT(*) AS c FROM positions`).get() as { c: number };
    expect(positions.c).toBeLessThanOrEqual(3);

    db.close();
  });

  it("writes no WATCHLIST rows when WATCHLIST_BENCH_DEPTH=0", () => {
    process.env.WATCHLIST_BENCH_DEPTH = "0";
    resetConfigCache();

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);

    seedUniverse(db, "2099-12-31");
    const asOf = (
      db.prepare(`SELECT MAX(date) AS d FROM daily_prices WHERE ticker = 'QQQ'`).get() as {
        d: string;
      }
    ).d;

    runLiveScreen(db, "rebalance", { asOf });

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM signals WHERE signal = 'WATCHLIST'`)
      .get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });
});
