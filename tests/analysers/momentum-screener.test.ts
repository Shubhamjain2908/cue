import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLiveScreen } from "../../src/analysers/momentum-screener.js";
import { resetConfigCache } from "../../src/config/index.js";
import { insertDailyPrices, insertPosition, insertSignal } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

const savedEnv = { ...process.env };

const UNIVERSE_TICKERS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"] as const;

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

function qqqDateOffset(db: SqliteConnection, asOf: string, offset: number): string {
  return (
    db
      .prepare(
        `SELECT date FROM daily_prices WHERE ticker = 'QQQ' AND date <= ? ORDER BY date DESC LIMIT 1 OFFSET ?`,
      )
      .get(asOf, offset) as { date: string }
  ).date;
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
  for (const ticker of UNIVERSE_TICKERS) {
    db.prepare(`DELETE FROM daily_prices WHERE ticker = ? AND date > ?`).run(ticker, asOf);
  }
}

/** Flat OHLCV for all universe tickers + uptrend QQQ (stop-mode fixtures). */
function seedFlatUniverse(
  db: SqliteConnection,
  lastCloseByTicker: Partial<Record<(typeof UNIVERSE_TICKERS)[number], number>> = {},
): string {
  const flat = Array.from({ length: 320 }, () => 100);
  const qqqCloses = Array.from({ length: 320 }, (_, i) => 80 + (i / 319) * 120);
  insertDailyPrices(db, "QQQ", barsFromCloses(qqqCloses));
  for (const ticker of UNIVERSE_TICKERS) {
    const closes = [...flat];
    const override = lastCloseByTicker[ticker];
    if (override !== undefined) {
      closes[closes.length - 1] = override;
    }
    insertDailyPrices(db, ticker, barsFromCloses(closes));
  }
  return latestQqqDate(db);
}

interface OpenPositionSeed {
  ticker?: string;
  entryDate: string;
  entryPrice: number;
  initialAtrStop: number;
  currentStopLoss?: number;
  highestClose?: number;
}

function insertOpenPosition(db: SqliteConnection, seed: OpenPositionSeed): { positionId: number } {
  const ticker = seed.ticker ?? "AAA";
  const ins = insertSignal(db, {
    ticker,
    date: seed.entryDate,
    signal: "BUY",
    price: seed.entryPrice,
    momentumRank: 1,
    universeRankedCount: UNIVERSE_TICKERS.length,
    momentum12_1Return: 0.5,
    atr14: 2.5,
    initialAtrStop: seed.initialAtrStop,
  });
  const signalId = Number(ins.lastInsertRowid);
  const { lastInsertRowid } = insertPosition(db, {
    signalId,
    entryDate: seed.entryDate,
    entryPrice: seed.entryPrice,
    status: "OPEN",
  });
  db.prepare(
    `
    UPDATE positions
    SET
      current_stop_loss = @stop,
      highest_close_since_entry = @high
    WHERE id = @id
  `,
  ).run({
    id: Number(lastInsertRowid),
    stop: seed.currentStopLoss ?? seed.initialAtrStop,
    high: seed.highestClose ?? seed.entryPrice,
  });
  return { positionId: Number(lastInsertRowid) };
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
    const db = openTestDb();

    seedUniverse(db, "2099-12-31");
    const asOf = latestQqqDate(db);

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

    const db = openTestDb();

    seedUniverse(db, "2099-12-31");
    const asOf = latestQqqDate(db);

    runLiveScreen(db, "rebalance", { asOf });

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM signals WHERE signal = 'WATCHLIST'`)
      .get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });
});

describe("runLiveScreen stop mode", () => {
  beforeEach(() => {
    envBase();
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    resetConfigCache();
  });

  it("records stop_movements when trailing stop or high-water ratchets", () => {
    const db = openTestDb();
    const asOf = seedFlatUniverse(db, { AAA: 115 });
    const entryDate = qqqDateOffset(db, asOf, 30);

    const { positionId } = insertOpenPosition(db, {
      entryDate,
      entryPrice: 100,
      initialAtrStop: 90,
      currentStopLoss: 90,
      highestClose: 100,
    });

    runLiveScreen(db, "stop", { asOf });

    const movement = db
      .prepare(
        `SELECT previous_stop, new_stop, previous_high, new_high, stop_regime, close_price
         FROM stop_movements WHERE position_id = ?`,
      )
      .get(positionId) as {
      previous_stop: number;
      new_stop: number;
      previous_high: number;
      new_high: number;
      stop_regime: string;
      close_price: number;
    };

    expect(movement.previous_stop).toBe(90);
    expect(movement.new_stop).toBeGreaterThan(90);
    expect(movement.previous_high).toBe(100);
    expect(movement.new_high).toBe(115);
    expect(movement.close_price).toBe(115);
    expect(movement.stop_regime).toBe("BASE");

    const position = db
      .prepare(
        `SELECT current_stop_loss, highest_close_since_entry, status FROM positions WHERE id = ?`,
      )
      .get(positionId) as {
      current_stop_loss: number;
      highest_close_since_entry: number;
      status: string;
    };
    expect(position.status).toBe("OPEN");
    expect(position.current_stop_loss).toBe(movement.new_stop);
    expect(position.highest_close_since_entry).toBe(115);

    db.close();
  });

  it("writes no stop_movements row on a no-op stop evaluation", () => {
    const db = openTestDb();
    const asOf = seedFlatUniverse(db, { AAA: 100 });
    const entryDate = qqqDateOffset(db, asOf, 30);

    insertOpenPosition(db, {
      entryDate,
      entryPrice: 100,
      initialAtrStop: 90,
      currentStopLoss: 100,
      highestClose: 100,
    });

    runLiveScreen(db, "stop", { asOf });

    const count = db.prepare(`SELECT COUNT(*) AS c FROM stop_movements`).get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });

  it("is idempotent for the same position_id and as_of_date", () => {
    const db = openTestDb();
    const asOf = seedFlatUniverse(db, { AAA: 115 });
    const entryDate = qqqDateOffset(db, asOf, 30);

    insertOpenPosition(db, {
      entryDate,
      entryPrice: 100,
      initialAtrStop: 90,
      currentStopLoss: 90,
      highestClose: 100,
    });

    runLiveScreen(db, "stop", { asOf });
    runLiveScreen(db, "stop", { asOf });

    const count = db.prepare(`SELECT COUNT(*) AS c FROM stop_movements`).get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("closes on trailing stop without recording a stop_movement for the exit", () => {
    const db = openTestDb();
    const asOf = seedFlatUniverse(db, { AAA: 88 });
    const entryDate = qqqDateOffset(db, asOf, 30);

    const { positionId } = insertOpenPosition(db, {
      entryDate,
      entryPrice: 100,
      initialAtrStop: 90,
      currentStopLoss: 90,
      highestClose: 100,
    });

    runLiveScreen(db, "stop", { asOf });

    const position = db
      .prepare(`SELECT status, exit_reason FROM positions WHERE id = ?`)
      .get(positionId) as { status: string; exit_reason: string | null };
    expect(position.status).toBe("CLOSED");
    expect(position.exit_reason).toBe("TRAILING_STOP");

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM stop_movements WHERE position_id = ?`)
      .get(positionId) as { c: number };
    expect(count.c).toBe(0);

    const sell = db
      .prepare(`SELECT signal, price FROM signals WHERE ticker = 'AAA' AND signal = 'SELL' AND date = ?`)
      .get(asOf) as { signal: string; price: number };
    expect(sell.signal).toBe("SELL");
    expect(sell.price).toBe(88);

    db.close();
  });
});
