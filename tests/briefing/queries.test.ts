import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { getMomentumBacktestSummary } from "../../src/briefing/queries.js";
import { initSchema } from "../../src/db/schema.js";

type SqliteConnection = InstanceType<typeof Database>;

function openMemoryDb(): SqliteConnection {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function insertBacktestRunRow(
  db: SqliteConnection,
  row: {
    runDate: string;
    strategy: string;
    cagr: number;
    sharpeRatio: number;
    maxDrawdown: number;
    expectancy: number;
    winRate: number;
    totalTrades: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO backtest_runs (
      run_date, from_date, to_date, cagr, max_drawdown, win_rate, sharpe_ratio,
      total_trades, benchmark_cagr, expectancy, strategy
    ) VALUES (
      @runDate, '2020-01-01', '2026-01-01', @cagr, @maxDrawdown, @winRate, @sharpeRatio,
      @totalTrades, 0, @expectancy, @strategy
    )
  `,
  ).run({
    runDate: row.runDate,
    strategy: row.strategy,
    cagr: row.cagr,
    maxDrawdown: row.maxDrawdown,
    winRate: row.winRate,
    sharpeRatio: row.sharpeRatio,
    totalTrades: row.totalTrades,
    expectancy: row.expectancy,
  });
}

describe("getMomentumBacktestSummary", () => {
  it("selects latest MOMENTUM run, not a newer GARP_RESEARCH row", () => {
    const db = openMemoryDb();

    insertBacktestRunRow(db, {
      runDate: "2026-05-19",
      strategy: "MOMENTUM",
      cagr: 21.39,
      sharpeRatio: 1.162,
      maxDrawdown: 11.54,
      expectancy: 4.78,
      winRate: 52.2,
      totalTrades: 103,
    });
    insertBacktestRunRow(db, {
      runDate: "2026-05-20",
      strategy: "GARP_RESEARCH",
      cagr: 1.1,
      sharpeRatio: -0.778,
      maxDrawdown: 6.56,
      expectancy: 0.5,
      winRate: 40,
      totalTrades: 9,
    });

    const summary = getMomentumBacktestSummary(db);

    expect(summary).not.toBeNull();
    expect(summary!.strategy).toBe("MOMENTUM");
    expect(summary!.run_date).toBe("2026-05-19");
    expect(summary!.cagr).toBeCloseTo(0.2139, 4);
    expect(summary!.sharpe).toBeCloseTo(1.162, 3);
    expect(summary!.max_drawdown).toBeCloseTo(0.1154, 4);
    expect(summary!.expectancy).toBeCloseTo(0.0478, 4);
    expect(summary!.total_trades).toBe(103);

    db.close();
  });

  it("returns null when no MOMENTUM runs exist", () => {
    const db = openMemoryDb();

    insertBacktestRunRow(db, {
      runDate: "2026-05-20",
      strategy: "GARP_RESEARCH",
      cagr: 1.1,
      sharpeRatio: -0.778,
      maxDrawdown: 6.56,
      expectancy: 0.5,
      winRate: 40,
      totalTrades: 9,
    });

    expect(getMomentumBacktestSummary(db)).toBeNull();
    db.close();
  });
});
