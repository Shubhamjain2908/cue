import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import winston from "winston";

import { getPipelineState } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";
import {
  adjustDailyPricesBeforeExDate,
  splitDailyPricesPipelineKey,
} from "../../src/ingestors/corporate-actions.js";
import { runBackfillHistoricalSplitAdjustments } from "../../scripts/backfill_historical_split_adjustments.js";

type SqliteConnection = InstanceType<typeof Database>;

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

function seedDailyPrice(
  db: SqliteConnection,
  ticker: string,
  date: string,
  close: number,
): void {
  db.prepare(
    `
    INSERT INTO daily_prices (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `,
  ).run(ticker, date, close, close, close, close);
}

describe("runBackfillHistoricalSplitAdjustments", () => {
  it("applies all corporate_actions once and skips on second run", () => {
    const db = openMemoryDb();
    const logger = silentLogger();
    const infoSpy = vi.spyOn(logger, "info");

    const actions = [
      { ticker: "AAA", ex_date: "2023-01-15", factor: 2 },
      { ticker: "BBB", ex_date: "2023-06-01", factor: 3 },
      { ticker: "CCC", ex_date: "2024-01-10", factor: 2 },
    ] as const;

    for (const a of actions) {
      db.prepare(
        `
        INSERT INTO corporate_actions (ticker, ex_date, type, factor, source)
        VALUES (?, ?, 'split', ?, 'yahoo')
      `,
      ).run(a.ticker, a.ex_date, a.factor);
      seedDailyPrice(db, a.ticker, "2023-01-01", 300);
    }

    const first = runBackfillHistoricalSplitAdjustments(db, logger);
    expect(first).toEqual({ applied: 3, skipped: 0, failed: 0 });

    for (const a of actions) {
      expect(getPipelineState(db, splitDailyPricesPipelineKey(a.ticker, a.ex_date))).toBe("1");
      const row = db
        .prepare(`SELECT close FROM daily_prices WHERE ticker = ? AND date = '2023-01-01'`)
        .get(a.ticker) as { close: number };
      expect(row.close).toBeCloseTo(300 / a.factor, 6);
    }

    infoSpy.mockClear();
    const second = runBackfillHistoricalSplitAdjustments(db, logger);
    expect(second).toEqual({ applied: 0, skipped: 3, failed: 0 });
    expect(infoSpy).toHaveBeenCalledWith("backfill complete: 0 applied, 3 skipped, 0 failed");
    db.close();
  });

  it("logs failure for one ticker and continues", () => {
    const db = openMemoryDb();
    const logger = silentLogger();

    db.prepare(
      `
      INSERT INTO corporate_actions (ticker, ex_date, type, factor, source)
      VALUES ('OK1', '2024-03-01', 'split', 2, 'yahoo')
    `,
    ).run();
    seedDailyPrice(db, "OK1", "2024-02-01", 80);

    db.prepare(
      `
      INSERT INTO corporate_actions (ticker, ex_date, type, factor, source)
      VALUES ('BAD', '2024-04-01', 'split', 2, 'yahoo')
    `,
    ).run();
    seedDailyPrice(db, "BAD", "2024-03-01", 50);

    const result = runBackfillHistoricalSplitAdjustments(db, logger, {
      adjustDailyPrices: (conn, params) => {
        if (params.ticker === "BAD") {
          throw new Error("constraint");
        }
        return adjustDailyPricesBeforeExDate(conn, params);
      },
    });
    expect(result).toEqual({ applied: 1, skipped: 0, failed: 1 });
    expect(
      (db.prepare(`SELECT close FROM daily_prices WHERE ticker = 'OK1' AND date = '2024-02-01'`).get() as {
        close: number;
      }).close,
    ).toBeCloseTo(40, 6);
    expect(getPipelineState(db, splitDailyPricesPipelineKey("OK1", "2024-03-01"))).toBe("1");
    expect(getPipelineState(db, splitDailyPricesPipelineKey("BAD", "2024-04-01"))).toBeNull();

    db.close();
  });
});
