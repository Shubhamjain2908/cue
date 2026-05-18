import { describe, expect, it } from "vitest";

import {
  atr,
  momentum5d,
  rsi14,
  sma,
  volumeRatio,
} from "../../src/strategy/indicators.js";

describe("rsi14", () => {
  it("returns null when fewer than 28 closes", () => {
    const closes = Array.from({ length: 27 }, () => 100);
    expect(rsi14(closes)).toBeNull();
  });

  it("returns 50 for perfectly flat prices (all deltas zero)", () => {
    const closes = Array.from({ length: 30 }, () => 42.5);
    expect(rsi14(closes)).toBe(50);
  });

  it("approaches 100 for sustained gains", () => {
    const start = 100;
    const closes = [start];
    for (let i = 1; i < 40; i++) {
      closes.push(closes[closes.length - 1]! + 1);
    }
    const v = rsi14(closes);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(90);
  });

  it("approaches 0 for sustained losses", () => {
    const closes = [200];
    for (let i = 1; i < 40; i++) {
      closes.push(closes[closes.length - 1]! - 1);
    }
    const v = rsi14(closes);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(15);
  });

  it("is low on a prolonged selloff", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 150 - 3 * i);
    const v = rsi14(closes);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(35);
  });
});

describe("momentum5d", () => {
  it("returns null when fewer than 6 closes", () => {
    expect(momentum5d([1, 2, 3, 4, 5])).toBeNull();
  });

  it("computes positive momentum", () => {
    expect(momentum5d([100, 100, 100, 100, 100, 110])).toBeCloseTo(10, 5);
  });

  it("computes negative momentum", () => {
    expect(momentum5d([100, 100, 100, 100, 100, 90])).toBeCloseTo(-10, 5);
  });

  it("returns null when base close is zero", () => {
    expect(momentum5d([0, 0, 0, 0, 0, 5])).toBeNull();
  });
});

describe("volumeRatio", () => {
  it("returns null when fewer than 60 volumes", () => {
    expect(volumeRatio(Array.from({ length: 59 }, () => 100_000))).toBeNull();
  });

  it("computes ratio for liquid names", () => {
    const vols = Array.from({ length: 60 }, (_, i) => (i < 40 ? 50_000 : 200_000));
    expect(volumeRatio(vols)).toBeCloseTo(2, 5);
  });

  it("returns null when 20d average volume is below 50k guard", () => {
    const vols = Array.from({ length: 60 }, (_, i) => (i < 40 ? 100_000 : 40_000));
    expect(volumeRatio(vols)).toBeNull();
  });

  it("returns null when 60d average volume is zero", () => {
    const vols = Array.from({ length: 60 }, () => 0);
    expect(volumeRatio(vols)).toBeNull();
  });
});

describe("sma()", () => {
  it("returns correct average for exact window", () => {
    expect(sma(3, [10, 20, 30])).toBeCloseTo(20);
  });

  it("uses only the last `period` values from a longer array", () => {
    // mean of [30, 40, 50] = 40; first two values ignored
    expect(sma(3, [10, 20, 30, 40, 50])).toBeCloseTo(40);
  });

  it("returns null when closes.length < period", () => {
    expect(sma(5, [10, 20])).toBeNull();
  });

  it("returns the single value when period === 1", () => {
    expect(sma(1, [42])).toBeCloseTo(42);
  });

  it("handles all identical values", () => {
    expect(sma(4, [7, 7, 7, 7])).toBeCloseTo(7);
  });
});

describe("atr", () => {
  it("returns null when insufficient data", () => {
    const arr10 = new Array(10).fill(100);
    expect(atr(arr10, arr10, arr10, 14)).toBeNull();
  });

  it("returns a positive number for valid OHLCV data", () => {
    const n = 50;
    const highs = Array.from({ length: n }, (_, i) => 100 + i * 0.5 + 2);
    const lows = Array.from({ length: n }, (_, i) => 100 + i * 0.5 - 2);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.5);
    const result = atr(highs, lows, closes, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });
});
