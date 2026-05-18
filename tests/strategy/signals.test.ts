import { describe, expect, it } from "vitest";

import { decideSide } from "../../src/strategy/signals.js";
import type { SignalThresholds } from "../../src/strategy/types.js";

function makeCloses(length: number, start = 100, step = 0.3): number[] {
  return Array.from({ length }, (_, i) => +(start + i * step).toFixed(4));
}

function makeVolumes(length: number, base = 1_000_000): number[] {
  // Last 20 days elevated vs prior 40 in the 60d window so 20d/60d >= 1.2
  return Array.from({ length }, (_, i) =>
    i >= length - 20 ? base * 1.4 : base,
  );
}

describe("decideSide() — Exhaustion Entry", () => {
  const thresholds: SignalThresholds = {
    smaPeriod: 10, // short period so tests don't need 50+ bars
    buyRsiMax: 50,
    buyVolumeRatio: 1.2,
    exitRsiThreshold: 70,
    stopLossPct: 5,
    maxHoldDays: 20,
  };

  // --- ENTRY tests (positionOpen = false) ---

  it("returns HOLD when closes.length < 220", () => {
    const closes = makeCloses(210);
    const volumes = makeVolumes(210);
    expect(decideSide(closes, volumes, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when SMA200 slope is falling (downtrend)", () => {
    // Sharp decline: SMA200[today] < SMA200[20 bars ago]
    const closes = makeCloses(230, 200, -0.5);
    const volumes = makeVolumes(230);
    expect(decideSide(closes, volumes, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when SMA200 is flat (not rising)", () => {
    // Flat price series: SMA200[today] === SMA200[20 bars ago] → slope gate fails
    const closes = Array(230).fill(100);
    const volumes = makeVolumes(230);
    expect(decideSide(closes, volumes, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when price is above SMA200/SMA10 but RSI > buyRsiMax (too hot)", () => {
    // Steep uptrend: RSI will be well above 50
    const closes = makeCloses(230, 100, 1.5);
    const volumes = makeVolumes(230);
    expect(decideSide(closes, volumes, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when volume ratio below buyVolumeRatio", () => {
    // Flat volumes — ratio will be 1.0
    const closes = makeCloses(230, 100, 0.2);
    const volumes = Array(230).fill(1_000_000);
    expect(decideSide(closes, volumes, thresholds, false)).toBe("HOLD");
  });

  // BUY case: gentle uptrend, dip to cool RSI, then shallow multi-bar recovery so
  // price clears SMA10 while RSI stays <= buyRsiMax and rsiToday > rsiYest.
  // ≥220 bars for SMA200 slope (200 + 20 lag).
  it("returns BUY when all 5 entry conditions are met", () => {
    const base = makeCloses(220, 80, 0.25); // gentle uptrend → rising SMA200 and above SMA10
    const dip = [
      base.at(-1)! - 1.5,
      base.at(-1)! - 2.5,
      base.at(-1)! - 3.0,
      base.at(-1)! - 3.5,
      base.at(-1)! - 4.0,
    ];
    let last = dip[dip.length - 1]!;
    const recovery: number[] = [];
    for (let i = 0; i < 6; i++) {
      last = +(last + 0.08).toFixed(4);
      recovery.push(last);
    }
    const closes = [...base, ...dip, ...recovery];
    const volumes = makeVolumes(closes.length);
    expect(decideSide(closes, volumes, thresholds, false)).toBe("BUY");
  });

  // --- EXIT tests (positionOpen = true) ---

  it("returns SELL when RSI >= exitRsiThreshold (take-profit)", () => {
    // Very steep uptrend at the end: RSI will be >= 70
    const closes = makeCloses(230, 100, 2.0);
    const volumes = makeVolumes(230);
    expect(decideSide(closes, volumes, thresholds, true)).toBe("SELL");
  });

  it("returns SELL when price crosses below SMA50 (trend break)", () => {
    // Uptrend then sharp drop below SMA10 (≥220 bars for signal path)
    const base = makeCloses(228, 100, 0.3);
    const crash = [base.at(-1)! - 10, base.at(-1)! - 12]; // below SMA10
    const closes = [...base, ...crash];
    const volumes = makeVolumes(closes.length);
    expect(decideSide(closes, volumes, thresholds, true)).toBe("SELL");
  });

  it("returns HOLD for open position when no exit condition is met", () => {
    // Oscillate with mild drift: RSI mid-range, last close above SMA10
    const closes = Array.from({ length: 230 }, (_, i) =>
      +(100 + Math.sin(i * 0.35 + 1.8) * 1.2 + i * 0.015).toFixed(4),
    );
    const volumes = makeVolumes(230);
    expect(decideSide(closes, volumes, thresholds, true)).toBe("HOLD");
  });
});
