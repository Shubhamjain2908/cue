import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import winston from "winston";

import { insertPosition, insertSignal } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";
import {
  adjustSplitsForOpenPositions,
  type YahooFinanceHandle,
} from "../../src/ingestors/corporate-actions.js";

type SqliteConnection = InstanceType<typeof Database>;

const sampleSignal = {
  ticker: "AAPL",
  date: "2024-06-01",
  signal: "BUY" as const,
  price: 200,
  momentumRank: 1,
  universeRankedCount: 50,
  momentum12_1Return: 0.12,
  atr14: 4,
  initialAtrStop: 180,
};

function openMemoryDb(): SqliteConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function silentLogger(): winston.Logger {
  return winston.createLogger({
    silent: true,
    transports: [new winston.transports.Console()],
  });
}

function seedDailyPrices(
  db: SqliteConnection,
  ticker: string,
  bars: Array<{ date: string; close: number; volume?: number }>,
): void {
  const insert = db.prepare(`
    INSERT INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES (@ticker, @date, @close, @close, @close, @close, @volume)
  `);
  for (const bar of bars) {
    insert.run({ ticker, date: bar.date, close: bar.close, volume: bar.volume ?? 1_000_000 });
  }
}

function seedOpenPosition(
  db: SqliteConnection,
  overrides?: Partial<typeof sampleSignal> & { entryPrice?: number },
): { positionId: number; signalId: number } {
  const signal = { ...sampleSignal, ...overrides };
  insertSignal(db, signal);
  const signalId = (db.prepare(`SELECT id FROM signals WHERE ticker = ?`).get(signal.ticker) as {
    id: number;
  }).id;
  const entryPrice = overrides?.entryPrice ?? signal.price;
  const { lastInsertRowid } = insertPosition(db, {
    signalId,
    entryDate: "2024-06-03",
    entryPrice,
    status: "OPEN",
  });
  const positionId = Number(lastInsertRowid);
  db.prepare(
    `
    UPDATE positions
    SET
      current_stop_loss = @stop,
      highest_close_since_entry = @high
    WHERE id = @id
  `,
  ).run({
    id: positionId,
    stop: signal.initialAtrStop,
    high: entryPrice,
  });
  return { positionId, signalId };
}

function mockChart(splits: Record<string, unknown> | Array<unknown>): YahooFinanceHandle {
  return {
    chart: vi.fn().mockResolvedValue({
      meta: { symbol: "MOCK" },
      indicators: { quote: [{ close: [] }] },
      events: { splits },
    }),
  } as unknown as YahooFinanceHandle;
}

describe("adjustSplitsForOpenPositions", () => {
  it("returns early with no open positions and no DB writes", async () => {
    const db = openMemoryDb();
    const yf = mockChart({});
    const logger = silentLogger();
    const infoSpy = vi.spyOn(logger, "info");

    await adjustSplitsForOpenPositions(db, yf, logger);

    expect(infoSpy).toHaveBeenCalledWith(
      "[corporate-actions] No open positions; skipping split adjustment",
    );
    expect(yf.chart).not.toHaveBeenCalled();
    const count = db.prepare(`SELECT COUNT(*) AS c FROM corporate_actions`).get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });

  it("adjusts daily_prices before ex_date on a 2:1 forward split", async () => {
    const db = openMemoryDb();
    const exDate = "2024-06-01";
    const yf = mockChart({
      "1717200000": {
        date: new Date(`${exDate}T00:00:00.000Z`),
        numerator: 2,
        denominator: 1,
        splitRatio: "2:1",
      },
    });
    seedDailyPrices(db, "TEST", [
      { date: "2024-05-30", close: 200, volume: 1_000_000 },
      { date: "2024-05-31", close: 204, volume: 2_000_000 },
      { date: exDate, close: 100, volume: 5_000_000 },
      { date: "2024-06-02", close: 102, volume: 6_000_000 },
    ]);
    seedOpenPosition(db, { ticker: "TEST", price: 100, entryPrice: 100 });

    await adjustSplitsForOpenPositions(db, yf, silentLogger());

    const preBarA = db
      .prepare(`SELECT close, volume FROM daily_prices WHERE ticker = 'TEST' AND date = '2024-05-30'`)
      .get() as { close: number; volume: number };
    expect(preBarA.close).toBeCloseTo(100, 6);
    expect(preBarA.volume).toBe(2_000_000); // 2:1 forward → historical volume doubles

    const preBarB = db
      .prepare(`SELECT close, volume FROM daily_prices WHERE ticker = 'TEST' AND date = '2024-05-31'`)
      .get() as { close: number; volume: number };
    expect(preBarB.close).toBeCloseTo(102, 6);
    expect(preBarB.volume).toBe(4_000_000);

    const exBar = db
      .prepare(`SELECT close, volume FROM daily_prices WHERE ticker = 'TEST' AND date = ?`)
      .get(exDate) as { close: number; volume: number };
    expect(exBar.close).toBe(100);
    expect(exBar.volume).toBe(5_000_000); // ex-date bar untouched

    const postBar = db
      .prepare(`SELECT close, volume FROM daily_prices WHERE ticker = 'TEST' AND date = '2024-06-02'`)
      .get() as { close: number; volume: number };
    expect(postBar.close).toBe(102);
    expect(postBar.volume).toBe(6_000_000); // post-ex bar untouched
    db.close();
  });

  it("does not double-adjust daily_prices when corporate_actions row already exists", async () => {
    const db = openMemoryDb();
    const exDate = "2024-06-05";
    const yf = mockChart({
      "1717545600": {
        date: new Date(`${exDate}T00:00:00.000Z`),
        numerator: 2,
        denominator: 1,
        splitRatio: "2:1",
      },
    });
    seedDailyPrices(db, "AAPL", [{ date: "2024-06-04", close: 200 }]);
    seedOpenPosition(db);
    db.prepare(
      `
      INSERT INTO corporate_actions (ticker, ex_date, type, factor, source)
      VALUES ('AAPL', ?, 'split', 2.0, 'yahoo')
    `,
    ).run(exDate);

    await adjustSplitsForOpenPositions(db, yf, silentLogger());

    const bar = db
      .prepare(`SELECT close FROM daily_prices WHERE ticker = 'AAPL' AND date = '2024-06-04'`)
      .get() as { close: number };
    expect(bar.close).toBe(200);
    db.close();
  });

  it("applies a new 2:1 forward split to positions and signals", async () => {
    const db = openMemoryDb();
    const exDate = "2024-06-05";
    const yf = mockChart({
      "1717545600": {
        date: new Date(`${exDate}T00:00:00.000Z`),
        numerator: 2,
        denominator: 1,
        splitRatio: "2:1",
      },
    });
    const { positionId, signalId } = seedOpenPosition(db);

    await adjustSplitsForOpenPositions(db, yf, silentLogger());

    const action = db
      .prepare(`SELECT type, factor, ex_date FROM corporate_actions WHERE ticker = 'AAPL'`)
      .get() as { type: string; factor: number; ex_date: string };
    expect(action).toEqual({ type: "split", factor: 2, ex_date: exDate });

    const position = db
      .prepare(
        `SELECT entry_price, current_stop_loss, highest_close_since_entry FROM positions WHERE id = ?`,
      )
      .get(positionId) as {
      entry_price: number;
      current_stop_loss: number;
      highest_close_since_entry: number;
    };
    expect(position.entry_price).toBe(100);
    expect(position.current_stop_loss).toBe(90);
    expect(position.highest_close_since_entry).toBe(100);

    const signal = db
      .prepare(`SELECT price, atr14, initial_atr_stop FROM signals WHERE id = ?`)
      .get(signalId) as { price: number; atr14: number; initial_atr_stop: number };
    expect(signal.price).toBe(100);
    expect(signal.atr14).toBe(2);
    expect(signal.initial_atr_stop).toBe(90);
    db.close();
  });

  it("skips duplicate corporate_actions rows (idempotency)", async () => {
    const db = openMemoryDb();
    const exDate = "2024-06-05";
    const yf = mockChart({
      "1717545600": {
        date: new Date(`${exDate}T00:00:00.000Z`),
        numerator: 2,
        denominator: 1,
        splitRatio: "2:1",
      },
    });
    const { positionId } = seedOpenPosition(db);

    db.prepare(
      `
      INSERT INTO corporate_actions (ticker, ex_date, type, factor, source)
      VALUES ('AAPL', ?, 'split', 2.0, 'yahoo')
    `,
    ).run(exDate);

    await adjustSplitsForOpenPositions(db, yf, silentLogger());

    const count = db.prepare(`SELECT COUNT(*) AS c FROM corporate_actions`).get() as { c: number };
    expect(count.c).toBe(1);

    const position = db
      .prepare(`SELECT current_stop_loss FROM positions WHERE id = ?`)
      .get(positionId) as { current_stop_loss: number };
    expect(position.current_stop_loss).toBe(180);
    db.close();
  });

  it("continues when one ticker fails and still adjusts another", async () => {
    const db = openMemoryDb();
    const exDate = "2024-06-05";
    const chart = vi
      .fn()
      .mockRejectedValueOnce(new Error("Yahoo down"))
      .mockResolvedValueOnce({
        meta: { symbol: "MSFT" },
        indicators: { quote: [{ close: [] }] },
        events: {
          splits: {
            "1717545600": {
              date: new Date(`${exDate}T00:00:00.000Z`),
              numerator: 2,
              denominator: 1,
              splitRatio: "2:1",
            },
          },
        },
      });
    const yf = { chart } as unknown as YahooFinanceHandle;

    insertSignal(db, { ...sampleSignal, ticker: "FAIL" });
    const failSignalId = (db.prepare(`SELECT id FROM signals WHERE ticker = 'FAIL'`).get() as {
      id: number;
    }).id;
    insertPosition(db, {
      signalId: failSignalId,
      entryDate: "2024-06-03",
      entryPrice: 50,
      status: "OPEN",
    });
    db.prepare(`UPDATE positions SET current_stop_loss = 45, highest_close_since_entry = 50 WHERE signal_id = ?`).run(
      failSignalId,
    );

    const { positionId: msftPositionId } = seedOpenPosition(db, {
      ticker: "MSFT",
      price: 400,
      atr14: 8,
      initialAtrStop: 360,
    });

    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, "warn");

    await adjustSplitsForOpenPositions(db, yf, logger);

    expect(chart).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[corporate-actions] Yahoo chart failed for FAIL"),
    );

    const msftStop = (
      db.prepare(`SELECT current_stop_loss FROM positions WHERE id = ?`).get(msftPositionId) as {
        current_stop_loss: number;
      }
    ).current_stop_loss;
    expect(msftStop).toBe(180);
    db.close();
  });

  it("applies a 1:10 reverse split by multiplying price levels by 10", async () => {
    const db = openMemoryDb();
    const exDate = "2024-06-06";
    const yf = mockChart({
      "1717632000": {
        date: new Date(`${exDate}T00:00:00.000Z`),
        numerator: 1,
        denominator: 10,
        splitRatio: "1:10",
      },
    });
    const { positionId } = seedOpenPosition(db, {
      ticker: "REV",
      price: 2,
      atr14: 0.2,
      initialAtrStop: 1.8,
      entryPrice: 2,
    });

    await adjustSplitsForOpenPositions(db, yf, silentLogger());

    const action = db
      .prepare(`SELECT type, factor FROM corporate_actions WHERE ticker = 'REV'`)
      .get() as { type: string; factor: number };
    expect(action.type).toBe("reverse_split");
    expect(action.factor).toBeCloseTo(0.1, 6);

    const position = db
      .prepare(`SELECT current_stop_loss FROM positions WHERE id = ?`)
      .get(positionId) as { current_stop_loss: number };
    expect(position.current_stop_loss).toBe(18);
    db.close();
  });
});
