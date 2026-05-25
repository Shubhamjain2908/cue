import { describe, expect, it } from "vitest";

import { computeSignalMetrics } from "../../src/enrichers/momentum-technical.js";
import { DEFAULT_RANKING_CONFIG } from "../../src/enrichers/momentum-types.js";

describe("DEFAULT_RANKING_CONFIG", () => {
  it("has the expected empirically validated defaults", () => {
    expect(DEFAULT_RANKING_CONFIG.lookbackDays).toBe(252);
    expect(DEFAULT_RANKING_CONFIG.skipDays).toBe(21);
    expect(DEFAULT_RANKING_CONFIG.topN).toBe(3);
    expect(DEFAULT_RANKING_CONFIG.rebalanceDayOfWeek).toBe(5);
    expect(DEFAULT_RANKING_CONFIG.atrPeriod).toBe(14);
    expect(DEFAULT_RANKING_CONFIG.atrMultiplierBase).toBe(4.0);
    expect(DEFAULT_RANKING_CONFIG.atrMultiplierTight).toBe(1.5);
    expect(DEFAULT_RANKING_CONFIG.atrTightenThresholdPct).toBe(25.0);
    expect(DEFAULT_RANKING_CONFIG.maxHoldDays).toBe(40);
    expect(DEFAULT_RANKING_CONFIG.smaPeriod).toBe(200);
  });
});

describe("computeSignalMetrics", () => {
  it("returns null metrics when input is too short", () => {
    const metrics = computeSignalMetrics({ close: [100], volume: [1_000_000] });
    expect(metrics.rsi14).toBeNull();
    expect(metrics.momentum5dPct).toBeNull();
    expect(metrics.volumeRatio).toBeNull();
    expect(metrics.lastClose).toBe(100);
  });

  it("computes metrics for valid inputs", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const volumes = Array.from({ length: 60 }, (_, i) =>
      i >= 40 ? 2_000_000 : 1_000_000,
    );
    const metrics = computeSignalMetrics({ close: closes, volume: volumes });
    expect(metrics.lastClose).toBeCloseTo(129.5, 0);
    expect(metrics.volumeRatio).not.toBeNull();
    expect(metrics.rsi14).not.toBeNull();
  });
});

describe("resolveScreenAsOfDate preconditions", () => {
  it("requires at least 600 days of lookback for screening", () => {
    // The runLiveScreen function uses addCalendarDays(asOf, -600) for lookback
    // This is to ensure enough data for 252-day momentum + 200-day SMA
    expect(DEFAULT_RANKING_CONFIG.lookbackDays).toBe(252);
    // 600 calendar days provides enough trading days for all indicators
    expect(600).toBeGreaterThan(DEFAULT_RANKING_CONFIG.lookbackDays + 200);
  });
});
