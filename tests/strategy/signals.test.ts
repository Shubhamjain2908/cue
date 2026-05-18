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

  // Dummy QQQ in bull regime — use in all non-regime tests
  const bullQqq = makeCloses(220, 300, 0.5);

  // --- ENTRY tests (positionOpen = false) ---

  it("returns HOLD when closes.length < 200", () => {
    const closes = makeCloses(150);
    const volumes = makeVolumes(150);
    expect(decideSide(closes, volumes, bullQqq, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when price is below SMA200 (downtrend)", () => {
    // Sharp decline: today always below SMA200
    const closes = makeCloses(210, 200, -0.5);
    const volumes = makeVolumes(210);
    expect(decideSide(closes, volumes, bullQqq, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when price is above SMA200/SMA10 but RSI > buyRsiMax (too hot)", () => {
    // Steep uptrend: RSI will be well above 50
    const closes = makeCloses(210, 100, 1.5);
    const volumes = makeVolumes(210);
    expect(decideSide(closes, volumes, bullQqq, thresholds, false)).toBe("HOLD");
  });

  it("returns HOLD when volume ratio below buyVolumeRatio", () => {
    // Flat volumes — ratio will be 1.0
    const closes = makeCloses(210, 100, 0.2);
    const volumes = Array(210).fill(1_000_000);
    expect(decideSide(closes, volumes, bullQqq, thresholds, false)).toBe("HOLD");
  });

  // BUY case: gentle uptrend, dip to cool RSI, then shallow multi-bar recovery so
  // price clears SMA10 while RSI stays <= buyRsiMax and rsiToday > rsiYest.
  it("returns BUY when all 5 entry conditions are met", () => {
    const base = makeCloses(200, 80, 0.25); // gentle uptrend → above SMA200 and SMA10
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
    expect(decideSide(closes, volumes, bullQqq, thresholds, false)).toBe("BUY");
  });

  // --- EXIT tests (positionOpen = true) ---

  it("returns SELL when RSI >= exitRsiThreshold (take-profit)", () => {
    // Very steep uptrend at the end: RSI will be >= 70
    const closes = makeCloses(210, 100, 2.0);
    const volumes = makeVolumes(210);
    expect(decideSide(closes, volumes, bullQqq, thresholds, true)).toBe("SELL");
  });

  it("returns HOLD for open position when no exit condition is met", () => {
    // Oscillate with mild drift: RSI mid-range, last close above SMA10 and SMA200
    const closes = Array.from({ length: 210 }, (_, i) =>
      +(100 + Math.sin(i * 0.35 + 1.8) * 1.2 + i * 0.015).toFixed(4),
    );
    const volumes = makeVolumes(210);
    expect(decideSide(closes, volumes, bullQqq, thresholds, true)).toBe("HOLD");
  });
});

describe("regime filter", () => {
  const thresholds: SignalThresholds = {
    smaPeriod: 10,
    buyRsiMax: 50,
    buyVolumeRatio: 1.2,
    exitRsiThreshold: 70,
    stopLossPct: 5,
    maxHoldDays: 20,
  };

  it("returns HOLD when QQQ is below SMA200 (bear regime)", () => {
    const bearQqq = makeCloses(220, 400, -0.4);
    const base = makeCloses(200, 80, 0.25);
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
    expect(decideSide(closes, volumes, bearQqq, thresholds, false)).toBe("HOLD");
  });

  it("returns SELL for open position even when QQQ is in bear regime", () => {
    const bearQqq = makeCloses(220, 400, -0.4);
    const closes = makeCloses(220, 100, 2.0);
    const volumes = makeVolumes(220);
    expect(decideSide(closes, volumes, bearQqq, thresholds, true)).toBe("SELL");
  });
});
