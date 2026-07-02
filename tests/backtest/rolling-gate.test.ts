import { describe, expect, it } from "vitest";

import {
  enumerateWindows,
  evaluateGate,
  bootstrapMeanCi95,
  type RollingWindowRow,
} from "../../src/backtest/rolling-gate.js";
import { BACKTEST_WARMUP_CALENDAR_DAYS } from "../../src/backtest/types.js";

describe("enumerateWindows", () => {
  it("produces windows with correct spacing", () => {
    const windows = enumerateWindows("2021-01-01", "2025-12-31");
    expect(windows.length).toBeGreaterThanOrEqual(5);
    // First window = dataFirst + warmup constant
    const expectedFirst = new Date("2021-01-01T12:00:00Z");
    expectedFirst.setUTCDate(expectedFirst.getUTCDate() + BACKTEST_WARMUP_CALENDAR_DAYS);
    const expectedStr = expectedFirst.toISOString().slice(0, 10);
    expect(windows[0]!.from).toBe(expectedStr);
    // Each window is 730 days, stepped by 90
    if (windows.length >= 2) {
      const diffDays =
        (new Date(windows[1]!.from).getTime() - new Date(windows[0]!.from).getTime()) /
        86_400_000;
      expect(diffDays).toBe(90);
    }
  });

  it("returns empty when range is too short", () => {
    const windows = enumerateWindows("2025-01-01", "2025-06-01");
    expect(windows).toHaveLength(0);
  });

  it("clamps to explicit from/to", () => {
    const windows = enumerateWindows("2021-01-01", "2026-07-01", "2023-01-01", "2025-01-01");
    for (const w of windows) {
      expect(w.from >= "2023-01-01").toBe(true);
      expect(w.to <= "2025-01-01").toBe(true);
    }
  });
});

describe("evaluateGate", () => {
  const baseRow: RollingWindowRow = {
    index: 0,
    fromDate: "2023-01-01",
    toDate: "2024-12-31",
    years: 2,
    cagr: 15,
    maxDrawdown: 15,
    sharpe: 1.2,
    winRate: 55,
    expectancy: 0.5,
    trades: 20,
    benchmarkCagr: 10,
    regimeFraction: 0.8,
    gatePass: false,
    gateFailures: [],
  };

  it("passes when all metrics meet thresholds", () => {
    const { pass, failures } = evaluateGate(baseRow);
    expect(pass).toBe(true);
    expect(failures).toHaveLength(0);
  });

  it("fails when CAGR is below min", () => {
    const { pass } = evaluateGate({ ...baseRow, cagr: 8 });
    expect(pass).toBe(false);
  });

  it("fails when MaxDD exceeds max", () => {
    const { pass } = evaluateGate({ ...baseRow, maxDrawdown: 25 });
    expect(pass).toBe(false);
  });

  it("fails when Sharpe is below min", () => {
    const { pass } = evaluateGate({ ...baseRow, sharpe: 0.5 });
    expect(pass).toBe(false);
  });

  it("fails when expectancy is negative", () => {
    const { pass } = evaluateGate({ ...baseRow, expectancy: -0.5 });
    expect(pass).toBe(false);
  });

  it("fails when cagr is null (no trades)", () => {
    const { pass } = evaluateGate({ ...baseRow, cagr: null });
    expect(pass).toBe(false);
  });
});

describe("bootstrapMeanCi95", () => {
  it("returns null for fewer than 2 values", () => {
    expect(bootstrapMeanCi95([])).toBeNull();
    expect(bootstrapMeanCi95([1])).toBeNull();
  });

  it("computes a reasonable CI for normally distributed values", () => {
    // Uniform sequence centered at 0 — CI should straddle 0
    const values = Array.from({ length: 100 }, (_, i) => (i - 50) / 10);
    const ci = bootstrapMeanCi95(values, 1000);
    expect(ci).not.toBeNull();
    expect(ci!.lo).toBeLessThan(ci!.hi);
    // Mean of this sequence is ~0, so CI should straddle 0
    expect(ci!.lo).toBeLessThan(0.5);
    expect(ci!.hi).toBeGreaterThan(-0.5);
  });
});
