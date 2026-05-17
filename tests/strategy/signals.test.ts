import { describe, expect, it } from "vitest";

import { generateSignal } from "../../src/strategy/signals.js";
import type { SignalThresholds } from "../../src/strategy/types.js";

const thresholds: SignalThresholds = {
  buyRsiMin: 60,
  buyMomentumMinPct: 3,
  buyVolumeRatioMin: 1.3,
  exitRsiMax: 45,
  stopLossPct: 5,
};

function makeBars(input: {
  closes: number[];
  volumes: number[];
}): { close: number[]; volume: number[] } {
  return { close: input.closes, volume: input.volumes };
}

describe("generateSignal", () => {
  it("emits BUY when RSI, momentum, and volume ratio all pass (momentum breakout)", () => {
    const base = Array.from({ length: 50 }, (_, i) => 100 + i * 0.08);
    const ramp = Array.from({ length: 10 }, (_, i) => 104 + i * 2.8);
    const close = [...base, ...ramp];
    const volume = [...Array(40).fill(70_000), ...Array(20).fill(240_000)];
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.rsi14).not.toBeNull();
    expect(metrics.momentum5dPct).not.toBeNull();
    expect(metrics.volumeRatio).not.toBeNull();
    expect(metrics.rsi14!).toBeGreaterThan(thresholds.buyRsiMin);
    expect(metrics.momentum5dPct!).toBeGreaterThan(thresholds.buyMomentumMinPct);
    expect(metrics.volumeRatio!).toBeGreaterThan(thresholds.buyVolumeRatioMin);
    expect(signal).toBe("BUY");
  });

  it("does not emit BUY when RSI fails", () => {
    const close = Array.from({ length: 60 }, () => 100);
    const volume = [...Array(40).fill(80_000), ...Array(20).fill(200_000)];
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.rsi14).toBe(50);
    expect(signal).toBe("HOLD");
  });

  it("does not emit BUY when momentum fails", () => {
    const rally = Array.from({ length: 40 }, (_, i) => 100 + i * 1.4);
    const flat = Array(20).fill(rally[rally.length - 1]!);
    const close = [...rally, ...flat];
    const volume = [...Array(40).fill(80_000), ...Array(20).fill(200_000)];
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.momentum5dPct).not.toBeNull();
    expect(metrics.momentum5dPct!).toBeLessThanOrEqual(thresholds.buyMomentumMinPct);
    expect(signal).toBe("HOLD");
  });

  it("does not emit BUY when volume ratio fails", () => {
    const base = Array.from({ length: 50 }, (_, i) => 100 + i * 0.08);
    const ramp = Array.from({ length: 10 }, (_, i) => 104 + i * 2.8);
    const close = [...base, ...ramp];
    const volume = Array.from({ length: 60 }, () => 100_000);
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.volumeRatio).toBeCloseTo(1, 5);
    expect(signal).toBe("HOLD");
  });

  it("emits SELL on RSI fade when a position is open", () => {
    const rise = Array.from({ length: 35 }, (_, i) => 50 + i * 3);
    const fall = Array.from({ length: 25 }, (_, i) => 155 - i * 4.5);
    const close = [...rise, ...fall];
    const volume = Array.from({ length: 60 }, () => 200_000);
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
      position: { entryPrice: 50 },
    });
    expect(metrics.rsi14).not.toBeNull();
    expect(metrics.rsi14!).toBeLessThan(thresholds.exitRsiMax);
    expect(signal).toBe("SELL");
  });

  it("emits SELL on stop-loss when a position is open", () => {
    const close = Array.from({ length: 60 }, () => 100);
    const volume = Array.from({ length: 60 }, () => 200_000);
    const { signal } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
      position: { entryPrice: 110 },
    });
    expect(signal).toBe("SELL");
  });

  it("defaults to HOLD when not a BUY and no exit applies", () => {
    const close = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 0.2);
    const volume = Array.from({ length: 60 }, () => 120_000);
    const { signal } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(signal).toBe("HOLD");
  });

  it("does not emit BUY while a position is open even if entry conditions repeat", () => {
    const base = Array.from({ length: 50 }, (_, i) => 100 + i * 0.08);
    const ramp = Array.from({ length: 10 }, (_, i) => 104 + i * 2.8);
    const close = [...base, ...ramp];
    const volume = [...Array(40).fill(70_000), ...Array(20).fill(240_000)];
    const { signal } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
      position: { entryPrice: 95 },
    });
    expect(signal).toBe("HOLD");
  });
});
