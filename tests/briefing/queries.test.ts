import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  extractDashboardPayloadFromDb,
  getMomentumBacktestSummary,
  listBuySignalsReadyToAlert,
} from "../../src/briefing/queries.js";
import {
  insertDailyPrices,
  insertEnrichmentStub,
  insertPosition,
  insertSignal,
} from "../../src/db/queries.js";
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
    windowLabel?: string | null;
    locked?: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO backtest_runs (
      run_date, from_date, to_date, cagr, max_drawdown, win_rate, sharpe_ratio,
      total_trades, benchmark_cagr, expectancy, strategy, window_label, locked
    ) VALUES (
      @runDate, '2020-01-01', '2026-01-01', @cagr, @maxDrawdown, @winRate, @sharpeRatio,
      @totalTrades, 0, @expectancy, @strategy, @windowLabel, @locked
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
    windowLabel: row.windowLabel ?? null,
    locked: row.locked ?? 0,
  });
}

describe("listBuySignalsReadyToAlert", () => {
  it("returns failed enrichment with literal stub rationale and enrichmentStatus", () => {
    const db = openMemoryDb();
    const ins = insertSignal(db, {
      ticker: "FAIL",
      date: "2024-06-10",
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.5,
      atr14: 2.5,
      initialAtrStop: 90,
    });
    const signalId = Number(ins.lastInsertRowid);
    insertEnrichmentStub(db, { signalId, status: "TIMEOUT" });

    const pending = listBuySignalsReadyToAlert(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(signalId);
    expect(pending[0]!.rationale).toBe("[enrichment unavailable]");
    expect(pending[0]!.enrichmentStatus).toBe("TIMEOUT");

    db.close();
  });
});

describe("getMomentumBacktestSummary", () => {
  it("selects latest locked MOMENTUM run, not a newer unlocked extended run", () => {
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
      windowLabel: "2023-2025 (bull)",
      locked: 1,
    });
    insertBacktestRunRow(db, {
      runDate: "2026-05-25",
      strategy: "MOMENTUM",
      cagr: 18.0,
      sharpeRatio: 0.956,
      maxDrawdown: 14.0,
      expectancy: 3.5,
      winRate: 50,
      totalTrades: 120,
      windowLabel: "2022-2025 (extended)",
      locked: 0,
    });
    insertBacktestRunRow(db, {
      runDate: "2026-05-26",
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
    expect(summary!.window_label).toBe("2023-2025 (bull)");
    expect(summary!.run_date).toBe("2026-05-19");
    expect(summary!.cagr).toBeCloseTo(0.2139, 4);
    expect(summary!.sharpe).toBeCloseTo(1.162, 3);
    expect(summary!.max_drawdown).toBeCloseTo(0.1154, 4);
    expect(summary!.expectancy).toBeCloseTo(0.0478, 4);
    expect(summary!.total_trades).toBe(103);

    db.close();
  });

  it("returns null when no locked MOMENTUM runs exist", () => {
    const db = openMemoryDb();

    insertBacktestRunRow(db, {
      runDate: "2026-05-25",
      strategy: "MOMENTUM",
      cagr: 18.0,
      sharpeRatio: 0.956,
      maxDrawdown: 14.0,
      expectancy: 3.5,
      winRate: 50,
      totalTrades: 120,
      windowLabel: "2022-2025 (extended)",
      locked: 0,
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

    expect(getMomentumBacktestSummary(db)).toBeNull();
    db.close();
  });
});

function bar(date: string, close: number) {
  return { date, open: close, high: close, low: close, close, volume: 1_000_000 };
}

describe("extractDashboardPayloadFromDb", () => {
  it("counts days_held as trading sessions after entry_date, not calendar days", () => {
    const db = openMemoryDb();
    const entryDate = "2024-06-03";

    const ins = insertSignal(db, {
      ticker: "TEST",
      date: entryDate,
      signal: "BUY",
      price: 100,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.5,
      atr14: 2.5,
      initialAtrStop: 90,
    });
    insertPosition(db, {
      signalId: Number(ins.lastInsertRowid),
      entryDate,
      entryPrice: 100,
      status: "OPEN",
    });

    insertDailyPrices(db, "TEST", [
      bar(entryDate, 100),
      bar("2024-06-04", 101),
      bar("2024-06-05", 102),
      bar("2024-06-06", 103),
    ]);
    insertDailyPrices(db, "QQQ", [bar("2024-06-06", 400)]);

    const payload = extractDashboardPayloadFromDb(db);
    expect(payload.open_positions).toHaveLength(1);
    expect(payload.open_positions[0]!.days_held).toBe(3);

    const calendarDays = db
      .prepare(`SELECT CAST(julianday('now') - julianday(@entryDate) AS INTEGER) AS n`)
      .get({ entryDate }) as { n: number };
    expect(payload.open_positions[0]!.days_held).not.toBe(calendarDays.n);

    db.close();
  });

  it("returns alerted_at on recent_signals and null when not yet alerted", () => {
    const db = openMemoryDb();
    const alertedAt = "2026-06-07 09:15:00";

    const alerted = insertSignal(db, {
      ticker: "ALRT",
      date: "2026-06-05",
      signal: "BUY",
      price: 50,
      momentumRank: 2,
      universeRankedCount: 20,
      momentum12_1Return: 0.3,
      atr14: 1.5,
      initialAtrStop: 45,
    });
    db.prepare(`UPDATE signals SET alerted = 1, alerted_at = @alertedAt WHERE id = @id`).run({
      id: Number(alerted.lastInsertRowid),
      alertedAt,
    });

    insertSignal(db, {
      ticker: "PEND",
      date: "2026-06-04",
      signal: "BUY",
      price: 40,
      momentumRank: 5,
      universeRankedCount: 20,
      momentum12_1Return: 0.2,
      atr14: 1.2,
      initialAtrStop: 36,
    });

    insertDailyPrices(db, "QQQ", [bar("2026-06-05", 400)]);

    const payload = extractDashboardPayloadFromDb(db);
    const byTicker = Object.fromEntries(payload.recent_signals.map((s) => [s.ticker, s]));

    expect(byTicker.ALRT!.alerted_at).toBe(alertedAt);
    expect(byTicker.PEND!.alerted_at).toBeNull();

    db.close();
  });
});
