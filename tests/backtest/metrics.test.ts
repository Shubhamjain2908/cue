import { describe, expect, it } from "vitest";

import {
  cagrPct,
  computeBacktestMetrics,
  dailyRiskFreeRateFromAnnual,
  equityMarksToDailyReturns,
  equityPointsToDailyReturns,
  maxDrawdownPct,
  sharpeRatioAnnualized,
  winRatePct,
} from "../../src/backtest/metrics.js";
import type { ClosedBacktestTrade, EquityPoint } from "../../src/backtest/types.js";

describe("cagrPct", () => {
  it("returns null when startEquity is zero", () => {
    expect(cagrPct(0, 100, 1)).toBeNull();
  });

  it("returns null when startEquity is negative", () => {
    expect(cagrPct(-100, 100, 1)).toBeNull();
  });

  it("returns null when yearFraction is zero", () => {
    expect(cagrPct(100, 110, 0)).toBeNull();
  });

  it("computes 10% CAGR for 1 year", () => {
    const result = cagrPct(100, 110, 1);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(10, 5);
  });

  it("computes ~41.42% CAGR for 2-year double", () => {
    const result = cagrPct(100, 200, 2);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(41.42, 1);
  });

  it("handles small positive yearFraction", () => {
    const result = cagrPct(100, 110, 0.5);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(21, 0);
  });
});

describe("maxDrawdownPct", () => {
  it("returns null for empty array", () => {
    expect(maxDrawdownPct([])).toBeNull();
  });

  it("returns 0 for monotonically increasing equity", () => {
    expect(maxDrawdownPct([100, 110, 120, 130])).toBeCloseTo(0, 5);
  });

  it("computes 27.27% drawdown from peak", () => {
    // Peak at 110, trough at 80 → (110-80)/110 * 100 ≈ 27.27%
    expect(maxDrawdownPct([100, 110, 80, 90])).toBeCloseTo(27.27, 1);
  });

  it("tracks peak correctly across multiple peaks", () => {
    expect(maxDrawdownPct([100, 150, 120, 100, 110])).toBeCloseTo(33.33, 1);
  });
});

describe("winRatePct", () => {
  it("returns null for empty trades", () => {
    expect(winRatePct([])).toBeNull();
  });

  it("returns 100% when all trades win", () => {
    const trades: ClosedBacktestTrade[] = [
      {
        ticker: "AAPL",
        entryDate: "2024-01-01",
        exitDate: "2024-02-01",
        realizedPnlUsd: 100,
        exitReason: "gapOrStop",
        entryFillPrice: 100,
        exitFillPrice: 110,
      },
      {
        ticker: "MSFT",
        entryDate: "2024-01-15",
        exitDate: "2024-02-15",
        realizedPnlUsd: 50,
        exitReason: "maxHoldDays",
        entryFillPrice: 200,
        exitFillPrice: 210,
      },
    ];
    expect(winRatePct(trades)).toBeCloseTo(100, 5);
  });

  it("returns 50% for mixed results", () => {
    const trades: ClosedBacktestTrade[] = [
      {
        ticker: "AAPL",
        entryDate: "2024-01-01",
        exitDate: "2024-02-01",
        realizedPnlUsd: 100,
        exitReason: "gapOrStop",
        entryFillPrice: 100,
        exitFillPrice: 110,
      },
      {
        ticker: "MSFT",
        entryDate: "2024-01-15",
        exitDate: "2024-02-15",
        realizedPnlUsd: -50,
        exitReason: "maxHoldDays",
        entryFillPrice: 200,
        exitFillPrice: 190,
      },
    ];
    expect(winRatePct(trades)).toBeCloseTo(50, 5);
  });
});

describe("dailyRiskFreeRateFromAnnual", () => {
  it("returns a small positive rate for 4% annual", () => {
    const rate = dailyRiskFreeRateFromAnnual(0.04);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.001);
  });

  it("returns 0 for 0% annual", () => {
    expect(dailyRiskFreeRateFromAnnual(0)).toBeCloseTo(0, 10);
  });
});

describe("equityMarksToDailyReturns", () => {
  it("returns empty array for fewer than 2 points", () => {
    expect(equityMarksToDailyReturns([100])).toEqual([]);
  });

  it("computes return for 100->110 (approx 0.1)", () => {
    const result = equityMarksToDailyReturns([100, 110]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(0.1, 10);
  });

  it("skips pairs where prior equity is zero", () => {
    const result = equityMarksToDailyReturns([0, 100, 110]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(0.1, 10);
  });
});

describe("equityPointsToDailyReturns", () => {
  it("converts equity points to daily returns", () => {
    const points: EquityPoint[] = [
      { date: "2024-01-01", equityUsd: 100 },
      { date: "2024-01-02", equityUsd: 110 },
      { date: "2024-01-03", equityUsd: 99 },
    ];
    const returns = equityPointsToDailyReturns(points);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(0.1, 5);
    expect(returns[1]).toBeCloseTo(-0.1, 5);
  });
});

describe("sharpeRatioAnnualized", () => {
  it("returns null for fewer than 2 returns", () => {
    expect(sharpeRatioAnnualized([0.01])).toBeNull();
  });

  it("returns null for zero volatility", () => {
    expect(sharpeRatioAnnualized([0.01, 0.01])).toBeNull();
  });

  it("returns a positive Sharpe for positive returns", () => {
    const returns = Array.from({ length: 10 }, () => 0.01);
    const sharpe = sharpeRatioAnnualized(returns, 0.04);
    expect(sharpe).not.toBeNull();
    expect(sharpe!).toBeGreaterThan(0);
  });

  it("returns a negative Sharpe for negative returns", () => {
    const returns = Array.from({ length: 10 }, () => -0.01);
    const sharpe = sharpeRatioAnnualized(returns, 0.04);
    expect(sharpe).not.toBeNull();
    expect(sharpe!).toBeLessThan(0);
  });
});

describe("computeBacktestMetrics", () => {
  it("computes all metrics from equity curve and trades", () => {
    const equityPoints: EquityPoint[] = [
      { date: "2024-01-01", equityUsd: 100 },
      { date: "2024-01-02", equityUsd: 110 },
      { date: "2024-01-03", equityUsd: 105 },
      { date: "2024-01-04", equityUsd: 120 },
    ];
    const closedTrades: ClosedBacktestTrade[] = [
      {
        ticker: "AAPL",
        entryDate: "2024-01-01",
        exitDate: "2024-01-04",
        realizedPnlUsd: 20,
        exitReason: "gapOrStop",
        entryFillPrice: 100,
        exitFillPrice: 120,
      },
    ];

    const metrics = computeBacktestMetrics({
      equityPoints,
      closedTrades,
      yearFraction: 4 / 365.25,
    });

    expect(metrics.cagrPct).not.toBeNull();
    expect(metrics.maxDrawdownPct).not.toBeNull();
    expect(metrics.winRatePct).toBeCloseTo(100, 5);
    expect(metrics.totalTrades).toBe(1);
  });

  it("handles empty trades gracefully", () => {
    const metrics = computeBacktestMetrics({
      equityPoints: [{ date: "2024-01-01", equityUsd: 100 }],
      closedTrades: [],
      yearFraction: 1,
    });

    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRatePct).toBeNull();
  });
});
