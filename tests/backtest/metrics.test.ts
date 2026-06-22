import { describe, expect, it } from "vitest";
import {
  aggregateExitBuckets,
  benchmarkBuyHoldCagrPct,
  cagrPct,
  calendarHoldDaysHeld,
  computeBacktestMetrics,
  dailyRiskFreeRateFromAnnual,
  equityMarksToDailyReturns,
  equityPointsToDailyReturns,
  fmtNum,
  fmtPct,
  maxDrawdownPct,
  printBacktestSummary,
  sharpeRatioAnnualized,
  strategyBucketFromClosedTrade,
  toBacktestExitReason,
  winRatePct,
} from "../../src/backtest/metrics.js";
import type { DailyBar } from "../../src/shared/market-data-utils.js";
import type { ClosedBacktestTrade, EquityPoint } from "../../src/backtest/types.js";

// ── Formatting helpers ────────────────────────────────────────────────

describe("fmtPct", () => {
  it("formats a positive number as percentage", () => {
    expect(fmtPct(12.345)).toBe("12.35%");
  });

  it("formats a negative number as percentage", () => {
    expect(fmtPct(-5.1)).toBe("-5.10%");
  });

  it("respects custom digits", () => {
    expect(fmtPct(0.1234, 4)).toBe("0.1234%");
  });

  it("returns 'n/a' for null", () => {
    expect(fmtPct(null)).toBe("n/a");
  });

  it("returns 'n/a' for NaN", () => {
    expect(fmtPct(NaN)).toBe("n/a");
  });

  it("formats zero", () => {
    expect(fmtPct(0)).toBe("0.00%");
  });
});

describe("fmtNum", () => {
  it("formats a number with default digits", () => {
    expect(fmtNum(1.23456)).toBe("1.235");
  });

  it("formats a number with custom digits", () => {
    expect(fmtNum(1.2, 5)).toBe("1.20000");
  });

  it("returns 'n/a' for null", () => {
    expect(fmtNum(null)).toBe("n/a");
  });

  it("returns 'n/a' for NaN", () => {
    expect(fmtNum(NaN)).toBe("n/a");
  });
});

// ── CAGR ──────────────────────────────────────────────────────────────

describe("cagrPct", () => {
  it("computes CAGR for a positive return", () => {
    // $100 → $200 over 1 year = 100% CAGR
    const result = cagrPct(100, 200, 1);
    expect(result).toBeCloseTo(100, 5);
  });

  it("computes CAGR for a multi-year return", () => {
    // $100 → $200 over 2 years = ~41.42% CAGR
    const result = cagrPct(100, 200, 2);
    expect(result).toBeCloseTo(41.42, 1);
  });

  it("returns null for non-positive start equity", () => {
    expect(cagrPct(0, 200, 1)).toBeNull();
    expect(cagrPct(-10, 200, 1)).toBeNull();
  });

  it("returns null for non-positive end equity", () => {
    expect(cagrPct(100, 0, 1)).toBeNull();
    expect(cagrPct(100, -50, 1)).toBeNull();
  });

  it("returns null for non-positive year fraction", () => {
    expect(cagrPct(100, 200, 0)).toBeNull();
    expect(cagrPct(100, 200, -1)).toBeNull();
  });

  it("handles negative CAGR (declining equity)", () => {
    // $200 → $100 over 1 year = -50% CAGR
    const result = cagrPct(200, 100, 1);
    expect(result).toBeCloseTo(-50, 5);
  });
});

// ── Max Drawdown ──────────────────────────────────────────────────────

describe("maxDrawdownPct", () => {
  it("returns null for empty series", () => {
    expect(maxDrawdownPct([])).toBeNull();
  });

  it("returns 0 for a monotonically rising curve", () => {
    expect(maxDrawdownPct([100, 110, 120, 130])).toBeCloseTo(0, 5);
  });

  it("computes a simple drawdown", () => {
    // Peak 100 → trough 70 = 30% drawdown, then recover
    expect(maxDrawdownPct([100, 90, 70, 85, 95])).toBeCloseTo(30, 5);
  });

  it("tracks the maximum drawdown over multiple dips", () => {
    // Peak 100 → trough 50 = 50% drawdown
    const curve = [100, 110, 90, 50, 80, 120];
    expect(maxDrawdownPct(curve)).toBeCloseTo(54.545, 1);
  });

  it("returns null when all values are zero or negative", () => {
    expect(maxDrawdownPct([0, 0, 0])).toBeNull();
    expect(maxDrawdownPct([-10, -5])).toBeNull();
  });
});

// ── Win Rate ──────────────────────────────────────────────────────────

describe("winRatePct", () => {
  it("returns null for empty trades", () => {
    expect(winRatePct([])).toBeNull();
  });

  it("returns 100% when all trades are winners", () => {
    const trades: ClosedBacktestTrade[] = [
      { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-02-01", realizedPnlUsd: 10, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 110 },
      { ticker: "B", entryDate: "2023-01-15", exitDate: "2023-02-15", realizedPnlUsd: 50, exitReason: "maxHoldDays", entryFillPrice: 200, exitFillPrice: 250 },
    ];
    expect(winRatePct(trades)).toBeCloseTo(100, 5);
  });

  it("returns 0% when all trades are losers", () => {
    const trades: ClosedBacktestTrade[] = [
      { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-02-01", realizedPnlUsd: -10, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 90 },
    ];
    expect(winRatePct(trades)).toBeCloseTo(0, 5);
  });

  it("computes mixed win rate correctly", () => {
    const trades: ClosedBacktestTrade[] = [
      { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-01-10", realizedPnlUsd: 10, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 110 },
      { ticker: "B", entryDate: "2023-01-05", exitDate: "2023-01-15", realizedPnlUsd: -5, exitReason: "maxHoldDays", entryFillPrice: 100, exitFillPrice: 95 },
      { ticker: "C", entryDate: "2023-01-08", exitDate: "2023-01-18", realizedPnlUsd: 20, exitReason: "standardTakeProfit", entryFillPrice: 100, exitFillPrice: 120 },
      { ticker: "D", entryDate: "2023-01-10", exitDate: "2023-01-20", realizedPnlUsd: -3, exitReason: "standardTrendBreak", entryFillPrice: 100, exitFillPrice: 97 },
    ];
    expect(winRatePct(trades)).toBeCloseTo(50, 5);
  });

  it("treats zero P&L as a loss", () => {
    const trades: ClosedBacktestTrade[] = [
      { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-01-10", realizedPnlUsd: 0, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 100 },
    ];
    expect(winRatePct(trades)).toBeCloseTo(0, 5);
  });
});

// ── Risk-free rate helpers ────────────────────────────────────────────

describe("dailyRiskFreeRateFromAnnual", () => {
  it("returns a small positive rate for a 4% annual rate", () => {
    const rate = dailyRiskFreeRateFromAnnual(0.04);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.0002); // ~0.0156%
  });

  it("returns 0 for 0% annual rate", () => {
    expect(dailyRiskFreeRateFromAnnual(0)).toBe(0);
  });
});

// ── Equity returns ────────────────────────────────────────────────────

describe("equityMarksToDailyReturns", () => {
  it("returns empty array for fewer than 2 marks", () => {
    expect(equityMarksToDailyReturns([])).toEqual([]);
    expect(equityMarksToDailyReturns([100])).toEqual([]);
  });

  it("computes simple returns between consecutive marks", () => {
    // 100 → 110 = +10%, 110 → 99 = -10%
    const result = equityMarksToDailyReturns([100, 110, 99]);
    expect(result.length).toBe(2);
    expect(result[0]).toBeCloseTo(0.1, 5);
    expect(result[1]).toBeCloseTo(-0.1, 5);
  });

  it("skips returns where prior equity is non-positive", () => {
    // First mark has zero prior equity → skip; third pair computed normally
    const result = equityMarksToDailyReturns([0, 100, 110]);
    expect(result.length).toBe(1);
    expect(result[0]!).toBeCloseTo(0.1, 10);
  });
});

describe("equityPointsToDailyReturns", () => {
  it("extracts equity values and computes returns", () => {
    const points: EquityPoint[] = [
      { date: "2023-01-01", equityUsd: 100 },
      { date: "2023-01-02", equityUsd: 110 },
    ];
    const result = equityPointsToDailyReturns(points);
    expect(result.length).toBe(1);
    expect(result[0]!).toBeCloseTo(0.1, 10);
  });
});

// ── Exit reason mapping (round-trip) ──────────────────────────────────

describe("toBacktestExitReason", () => {
  it("maps TRAILING_STOP to gapOrStop", () => {
    expect(toBacktestExitReason("TRAILING_STOP")).toBe("gapOrStop");
  });

  it("maps MAX_HOLD to maxHoldDays", () => {
    expect(toBacktestExitReason("MAX_HOLD")).toBe("maxHoldDays");
  });

  it("maps REBALANCE_DROP to standardTrendBreak", () => {
    expect(toBacktestExitReason("REBALANCE_DROP")).toBe("standardTrendBreak");
  });

  it("maps FORCED_CLOSE to standardTakeProfit", () => {
    expect(toBacktestExitReason("FORCED_CLOSE")).toBe("standardTakeProfit");
  });
});

describe("strategyBucketFromClosedTrade", () => {
  // Build a minimal trade template
  const baseTrade: ClosedBacktestTrade = {
    ticker: "X",
    entryDate: "2023-01-01",
    exitDate: "2023-01-10",
    realizedPnlUsd: 0,
    exitReason: "gapOrStop",
    entryFillPrice: 100,
    exitFillPrice: 100,
  };

  it("maps gapOrStop to TRAILING_STOP", () => {
    expect(strategyBucketFromClosedTrade({ ...baseTrade, exitReason: "gapOrStop" })).toBe("TRAILING_STOP");
  });

  it("maps maxHoldDays to MAX_HOLD", () => {
    expect(strategyBucketFromClosedTrade({ ...baseTrade, exitReason: "maxHoldDays" })).toBe("MAX_HOLD");
  });

  it("maps standardTrendBreak to REBALANCE_DROP", () => {
    expect(strategyBucketFromClosedTrade({ ...baseTrade, exitReason: "standardTrendBreak" })).toBe("REBALANCE_DROP");
  });

  it("maps standardTakeProfit to FORCED_CLOSE", () => {
    expect(strategyBucketFromClosedTrade({ ...baseTrade, exitReason: "standardTakeProfit" })).toBe("FORCED_CLOSE");
  });

  it("round-trips correctly through toBacktestExitReason", () => {
    const reasons: Array<{ strategy: "TRAILING_STOP" | "MAX_HOLD" | "REBALANCE_DROP" | "FORCED_CLOSE"; db: ClosedBacktestTrade["exitReason"] }> = [
      { strategy: "TRAILING_STOP", db: "gapOrStop" },
      { strategy: "MAX_HOLD", db: "maxHoldDays" },
      { strategy: "REBALANCE_DROP", db: "standardTrendBreak" },
      { strategy: "FORCED_CLOSE", db: "standardTakeProfit" },
    ];
    for (const { strategy, db } of reasons) {
      expect(toBacktestExitReason(strategy)).toBe(db);
      expect(strategyBucketFromClosedTrade({ ...baseTrade, exitReason: db })).toBe(strategy);
    }
  });
});

// ── Calendar days held ────────────────────────────────────────────────

describe("calendarHoldDaysHeld", () => {
  it("computes days between same-day dates as 0", () => {
    expect(calendarHoldDaysHeld("2023-01-01", "2023-01-01")).toBe(0);
  });

  it("computes days for a 1-day difference", () => {
    expect(calendarHoldDaysHeld("2023-01-01", "2023-01-02")).toBe(1);
  });

  it("computes days across month boundary", () => {
    expect(calendarHoldDaysHeld("2023-01-31", "2023-02-01")).toBe(1);
  });

  it("computes days across year boundary", () => {
    expect(calendarHoldDaysHeld("2022-12-31", "2023-01-01")).toBe(1);
  });

  it("computes a multi-week hold", () => {
    expect(calendarHoldDaysHeld("2023-01-01", "2023-01-22")).toBe(21);
  });
});

// ── Exit bucket aggregation ───────────────────────────────────────────

describe("aggregateExitBuckets", () => {
  it("returns zero-filled buckets for empty trades", () => {
    const buckets = aggregateExitBuckets([]);
    for (const key of ["TRAILING_STOP", "MAX_HOLD", "REBALANCE_DROP", "FORCED_CLOSE"] as const) {
      expect(buckets[key]).toEqual({ count: 0, sumPnlPct: 0, sumHoldDays: 0 });
    }
  });

  it("aggregates a single trade into the correct bucket", () => {
    const trades: ClosedBacktestTrade[] = [
      {
        ticker: "A",
        entryDate: "2023-01-01",
        exitDate: "2023-01-10",
        realizedPnlUsd: 50,
        exitReason: "gapOrStop",
        entryFillPrice: 100,
        exitFillPrice: 150,
      },
    ];
    const buckets = aggregateExitBuckets(trades);
    expect(buckets.TRAILING_STOP.count).toBe(1);
    expect(buckets.TRAILING_STOP.sumPnlPct).toBeCloseTo(50, 5); // (150-100)/100*100
    expect(buckets.TRAILING_STOP.sumHoldDays).toBeCloseTo(9, 5); // 2023-01-01 to 2023-01-10
    expect(buckets.MAX_HOLD.count).toBe(0);
  });

  it("aggregates multiple trades across buckets", () => {
    const trades: ClosedBacktestTrade[] = [
      { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-01-05", realizedPnlUsd: 10, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 110 },
      { ticker: "B", entryDate: "2023-01-10", exitDate: "2023-01-20", realizedPnlUsd: -5, exitReason: "maxHoldDays", entryFillPrice: 100, exitFillPrice: 95 },
      { ticker: "C", entryDate: "2023-02-01", exitDate: "2023-02-10", realizedPnlUsd: 20, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 120 },
    ];
    const buckets = aggregateExitBuckets(trades);
    expect(buckets.TRAILING_STOP.count).toBe(2);
    expect(buckets.TRAILING_STOP.sumPnlPct).toBeCloseTo(30, 5); // 10% + 20%
    expect(buckets.MAX_HOLD.count).toBe(1);
    expect(buckets.MAX_HOLD.sumPnlPct).toBeCloseTo(-5, 5);
    expect(buckets.REBALANCE_DROP.count).toBe(0);
    expect(buckets.FORCED_CLOSE.count).toBe(0);
  });

  it("handles trades with zero entry fill price gracefully", () => {
    const trades: ClosedBacktestTrade[] = [
      { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-01-10", realizedPnlUsd: 0, exitReason: "gapOrStop", entryFillPrice: 0, exitFillPrice: 100 },
    ];
    const buckets = aggregateExitBuckets(trades);
    expect(buckets.TRAILING_STOP.count).toBe(1);
    expect(buckets.TRAILING_STOP.sumPnlPct).toBe(0); // entryFillPrice is 0, so P&L % is 0
  });
});

// ── Sharpe ratio ──────────────────────────────────────────────────────

describe("sharpeRatioAnnualized", () => {
  it("returns null for fewer than 2 returns", () => {
    expect(sharpeRatioAnnualized([])).toBeNull();
    expect(sharpeRatioAnnualized([0.01])).toBeNull();
  });

  it("returns null for zero volatility", () => {
    // All equal returns → std dev = 0 → null
    expect(sharpeRatioAnnualized([0.01, 0.01, 0.01])).toBeNull();
  });

  it("computes a reasonable Sharpe for consistent positive returns", () => {
    // Consistent small positive returns: expect positive Sharpe
    const returns = [0.001, 0.002, 0.0015, 0.0025, 0.001, 0.002, 0.0015];
    const sharpe = sharpeRatioAnnualized(returns);
    expect(sharpe).not.toBeNull();
    expect(sharpe!).toBeGreaterThan(0);
  });

  it("returns negative Sharpe for consistently negative returns", () => {
    const returns = [-0.002, -0.003, -0.001, -0.004, -0.002];
    const sharpe = sharpeRatioAnnualized(returns, 0);
    expect(sharpe).not.toBeNull();
    expect(sharpe!).toBeLessThan(0);
  });

  it("respects a custom risk-free rate", () => {
    // Excess returns = raw - rf_daily → lower Sharpe with higher rf
    const returns = [0.001, 0.001, 0.001, 0.001, 0.001];
    const sharpeDefault = sharpeRatioAnnualized(returns, 0.04);
    const sharpeHighRf = sharpeRatioAnnualized(returns, 0.10);
    if (sharpeDefault !== null && sharpeHighRf !== null) {
      expect(sharpeHighRf).toBeLessThan(sharpeDefault);
    }
  });
});

// ── computeBacktestMetrics (integration) ──────────────────────────────

describe("computeBacktestMetrics", () => {
  const equityPoints: EquityPoint[] = [
    { date: "2023-01-01", equityUsd: 100 },
    { date: "2023-01-02", equityUsd: 105 },
    { date: "2023-01-03", equityUsd: 110 },
    { date: "2023-01-04", equityUsd: 108 },
    { date: "2023-01-05", equityUsd: 115 },
  ];

  const closedTrades: ClosedBacktestTrade[] = [
    { ticker: "A", entryDate: "2023-01-01", exitDate: "2023-01-05", realizedPnlUsd: 10, exitReason: "gapOrStop", entryFillPrice: 100, exitFillPrice: 110 },
    { ticker: "B", entryDate: "2023-01-02", exitDate: "2023-01-05", realizedPnlUsd: -5, exitReason: "maxHoldDays", entryFillPrice: 50, exitFillPrice: 45 },
    { ticker: "C", entryDate: "2023-01-03", exitDate: "2023-01-05", realizedPnlUsd: 3, exitReason: "standardTakeProfit", entryFillPrice: 20, exitFillPrice: 23 },
  ];

  const result = computeBacktestMetrics({
    equityPoints,
    closedTrades,
    yearFraction: 4 / 365.25, // ~4 days in years
  });

  it("computes CAGR from equity curve", () => {
    // 100 → 115 over ~0.01095 years = very large CAGR
    expect(result.cagrPct).not.toBeNull();
    expect(result.cagrPct!).toBeGreaterThan(0);
  });

  it("computes max drawdown from equity curve", () => {
    // Peak 110 → trough 108 = ~1.818% drawdown
    expect(result.maxDrawdownPct).not.toBeNull();
    expect(result.maxDrawdownPct!).toBeCloseTo(1.818, 1);
  });

  it("computes win rate from closed trades", () => {
    // 2 winners out of 3 = 66.67%
    expect(result.winRatePct).toBeCloseTo(66.667, 1);
  });

  it("computes Sharpe ratio from daily returns", () => {
    expect(result.sharpeRatio).not.toBeNull();
  });

  it("reports total trade count", () => {
    expect(result.totalTrades).toBe(3);
  });

  it("returns 0% CAGR for flat equity curve", () => {
    const flat: EquityPoint[] = [
      { date: "2023-01-01", equityUsd: 100 },
      { date: "2023-01-02", equityUsd: 100 },
    ];
    const r = computeBacktestMetrics({ equityPoints: flat, closedTrades: [], yearFraction: 1 / 365.25 });
    // CAGR is exactly 0 (no growth), not null
    expect(r.cagrPct).toBeCloseTo(0, 10);
  });
});

// ── benchmarkBuyHoldCagrPct ──────────────────────────────────────────

describe("benchmarkBuyHoldCagrPct", () => {
  it("returns null for empty bars", () => {
    expect(benchmarkBuyHoldCagrPct([], "2023-01-01", "2023-12-31")).toBeNull();
  });

  it("finds the first bar when fromDate is before all data (lower bound semantics)", () => {
    const bars: DailyBar[] = [
      { ticker: "QQQ", date: "2023-06-01", open: 200, high: 210, low: 199, close: 205, volume: 1000 },
      { ticker: "QQQ", date: "2023-12-31", open: 300, high: 310, low: 295, close: 305, volume: 1000 },
    ];
    const result = benchmarkBuyHoldCagrPct(bars, "2023-01-01", "2023-12-31");
    // lowerBoundInclusiveByDate finds index 0 (first bar ≥ "2023-01-01")
    // CAGR = (305/205)^(1/0.58) − 1 ≈ positive
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });
});

// ── printBacktestSummary (smoke test) ─────────────────────────────────

describe("printBacktestSummary", () => {
  it("does not throw with minimal options", () => {
    expect(() =>
      printBacktestSummary({
        fromDate: "2023-01-01",
        toDate: "2023-12-31",
        metrics: {
          cagrPct: 10.5,
          maxDrawdownPct: 15.2,
          winRatePct: 55,
          sharpeRatio: 1.2,
          totalTrades: 50,
        },
        benchmarkCagrPct: 8.0,
        expectancyPctPerTrade: 1.5,
      }),
    ).not.toThrow();
  });

  it("does not throw with label and exit buckets", () => {
    const exitBuckets = {
      TRAILING_STOP: { count: 10, sumPnlPct: 50, sumHoldDays: 60 },
      MAX_HOLD: { count: 5, sumPnlPct: -10, sumHoldDays: 100 },
      REBALANCE_DROP: { count: 3, sumPnlPct: 15, sumHoldDays: 20 },
      FORCED_CLOSE: { count: 1, sumPnlPct: 5, sumHoldDays: 30 },
    };
    expect(() =>
      printBacktestSummary({
        label: "test-strategy",
        fromDate: "2023-01-01",
        toDate: "2023-12-31",
        metrics: {
          cagrPct: null,
          maxDrawdownPct: null,
          winRatePct: null,
          sharpeRatio: null,
          totalTrades: 0,
        },
        benchmarkCagrPct: null,
        expectancyPctPerTrade: null,
        exitBuckets,
      }),
    ).not.toThrow();
  });
});
