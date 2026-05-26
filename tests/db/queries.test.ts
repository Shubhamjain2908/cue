import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  closePosition,
  insertDailyPrices,
  insertPosition,
  insertSignal,
  listUnenrichedBuySignals,
  mapLiveExitReason,
  markSignalAlerted,
} from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

type SqliteConnection = InstanceType<typeof Database>;

function openMemoryDb(): SqliteConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

const sampleSignal = {
  ticker: "TEST",
  date: "2024-06-01",
  signal: "BUY" as const,
  price: 100,
  momentumRank: 1,
  universeRankedCount: 50,
  momentum12_1Return: 0.12,
  atr14: 2.5,
  initialAtrStop: 90,
};

describe("db queries", () => {
  it("inserts a signal", () => {
    const db = openMemoryDb();
    const { changes } = insertSignal(db, sampleSignal);
    expect(changes).toBe(1);
    const row = db
      .prepare(`SELECT ticker, date, signal, alerted FROM signals WHERE ticker = ?`)
      .get(sampleSignal.ticker) as { ticker: string; date: string; signal: string; alerted: number };
    expect(row.signal).toBe("BUY");
    expect(row.alerted).toBe(0);
    db.close();
  });

  it("ignores duplicate signal for same ticker and date", () => {
    const db = openMemoryDb();
    expect(insertSignal(db, sampleSignal).changes).toBe(1);
    expect(insertSignal(db, sampleSignal).changes).toBe(0);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM signals`).get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("lists BUY signals without enrichments", () => {
    const db = openMemoryDb();
    insertSignal(db, { ...sampleSignal, date: "2024-06-01" });
    insertSignal(db, { ...sampleSignal, date: "2024-06-02", momentumRank: 2 });

    const firstId = (
      db.prepare(`SELECT id FROM signals WHERE date = '2024-06-01'`).get() as { id: number }
    ).id;
    const secondId = (
      db.prepare(`SELECT id FROM signals WHERE date = '2024-06-02'`).get() as { id: number }
    ).id;

    db.prepare(
      `
      INSERT INTO enrichments (signal_id, sentiment, rationale, headlines)
      VALUES (@signalId, 'NEUTRAL', 'ok', @headlines)
    `,
    ).run({
      signalId: firstId,
      headlines: JSON.stringify(["h1", "h2", "h3"]),
    });

    const pending = listUnenrichedBuySignals(db);
    expect(pending).toEqual([{ id: secondId, ticker: "TEST", date: "2024-06-02" }]);
    db.close();
  });

  it("marks a signal as alerted", () => {
    const db = openMemoryDb();
    insertSignal(db, sampleSignal);
    const id = (db.prepare(`SELECT id FROM signals`).get() as { id: number }).id;
    markSignalAlerted(db, id);
    const alerted = (db.prepare(`SELECT alerted FROM signals WHERE id = ?`).get(id) as {
      alerted: number;
    }).alerted;
    expect(alerted).toBe(1);
    db.close();
  });

  it("inserts daily prices and ignores duplicate ticker/date", () => {
    const db = openMemoryDb();
    const bars = [
      { date: "2024-01-02", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { date: "2024-01-03", open: 1.5, high: 2.5, low: 1, close: 2, volume: 200 },
    ];
    insertDailyPrices(db, "AAA", bars);
    insertDailyPrices(db, "aaa", bars);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM daily_prices`).get() as {
      c: number;
    };
    expect(count.c).toBe(2);
    const tickers = db
      .prepare(`SELECT DISTINCT ticker FROM daily_prices ORDER BY ticker`)
      .all() as Array<{ ticker: string }>;
    expect(tickers).toEqual([{ ticker: "AAA" }]);
    db.close();
  });

  it("inserts a position and closes it", () => {
    const db = openMemoryDb();
    insertSignal(db, sampleSignal);
    const signalId = (db.prepare(`SELECT id FROM signals`).get() as { id: number }).id;

    const { lastInsertRowid } = insertPosition(db, {
      signalId,
      entryDate: "2024-06-03",
      entryPrice: 99,
      status: "OPEN",
    });
    const positionId = Number(lastInsertRowid);

    closePosition(db, positionId, "2024-06-10", 105, mapLiveExitReason("TRAILING_STOP"));
    const row = db
      .prepare(
        `SELECT status, exit_date, exit_price, pnl_pct, exit_reason FROM positions WHERE id = ?`,
      )
      .get(positionId) as {
      status: string;
      exit_date: string | null;
      exit_price: number | null;
      pnl_pct: number | null;
      exit_reason: string | null;
    };
    expect(row.status).toBe("CLOSED");
    expect(row.exit_date).toBe("2024-06-10");
    expect(row.exit_price).toBe(105);
    expect(row.exit_reason).toBe("TRAILING_STOP");
    expect(row.pnl_pct).toBeCloseTo(6.0606, 3);
    db.close();
  });

  it("mapLiveExitReason maps all strategy exit reasons", () => {
    expect(mapLiveExitReason("TRAILING_STOP")).toBe("TRAILING_STOP");
    expect(mapLiveExitReason("MAX_HOLD")).toBe("TIME_EXIT");
    expect(mapLiveExitReason("REBALANCE_DROP")).toBe("MANUAL");
    expect(mapLiveExitReason("FORCED_CLOSE")).toBe("MANUAL");
  });
});
