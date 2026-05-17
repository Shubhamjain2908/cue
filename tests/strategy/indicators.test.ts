import { describe, expect, it } from "vitest";

import { momentum5d, rsi14, volumeRatio } from "../../src/strategy/indicators.js";

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
