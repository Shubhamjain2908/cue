import { describe, expect, it } from "vitest";

import { decideSide } from "../../src/strategy/signals.js";
import type { SignalThresholds } from "../../src/strategy/types.js";

function makeTrendingCloses(length: number, start = 100, step = 0.5): number[] {
  return Array.from({ length }, (_, i) => start + i * step);
}

describe("decideSide() — Option A: Trend + Pullback", () => {
  const thresholds: SignalThresholds = {
    smaPeriod: 10, // short period so tests don't need 50+ bars
    buyRsiMin: 45,
    buyRsiMax: 55,
    exitRsiThreshold: 0,
    stopLossPct: 5,
    maxHoldDays: 20,
  };

  it("returns BUY when price > SMA and RSI in [45, 55]", () => {
    // Needs ≥200 bars for SMA200; walk keeps RSI ~49 and price above SMA10 and SMA200.
    const closes: number[] = [];
    let x = 100;
    for (let i = 0; i < 230; i++) {
      x += 0.05 + Math.sin(i * 0.11) * 0.12;
      closes.push(x);
    }
    const result = decideSide(closes, [], thresholds);
    expect(result).toBe("BUY");
  });

  it("returns HOLD when price < SMA (downtrend)", () => {
    // Declining closes: today is always below SMA10
    const closes = makeTrendingCloses(30, 200, -0.8);
    const result = decideSide(closes, [], thresholds);
    expect(result).toBe("HOLD");
  });

  it("returns HOLD when price > SMA but RSI > buyRsiMax (too hot)", () => {
    // Sharp uptrend: RSI will be well above 55
    const closes = makeTrendingCloses(30, 100, 2.0);
    const result = decideSide(closes, [], thresholds);
    expect(result).toBe("HOLD");
  });

  it("returns HOLD when price > SMA but RSI < buyRsiMin (too oversold)", () => {
    // Strong uptrend then sharp 5-day drop: RSI will be < 45 but price may be
    // above SMA. This tests the lower RSI bound.
    const base = makeTrendingCloses(25, 100, 1.0);
    const drop = [
      base.at(-1)! - 2,
      base.at(-1)! - 4,
      base.at(-1)! - 6,
      base.at(-1)! - 8,
      base.at(-1)! - 10,
    ];
    const closes = [...base, ...drop];
    const result = decideSide(closes, [], thresholds);
    expect(result).toBe("HOLD");
  });

  it("returns HOLD when insufficient data for SMA200 (strict long filter)", () => {
    // SMA10 + RSI ok on 60 bars, but SMA200 undefined → HOLD
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.85) * 1.5 + i * 0.01);
    const result = decideSide(closes, [], thresholds);
    expect(result).toBe("HOLD");
  });

  it("returns HOLD when insufficient data for short SMA period", () => {
    const closes = [100, 101, 102, 103, 104];
    const result = decideSide(closes, [], thresholds);
    expect(result).toBe("HOLD");
  });
});
