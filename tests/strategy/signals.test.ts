import { describe, expect, it } from "vitest";

import { generateSignal } from "../../src/strategy/signals.js";
import type { SignalThresholds } from "../../src/strategy/types.js";

const thresholds: SignalThresholds = {
  buyRsiMax: 35,
  buyMomentumMaxPct: -8,
  buyVolumeRatioMin: 1.5,
  exitRsiMin: 60,
  stopLossPct: 5,
};

function makeBars(input: {
  closes: number[];
  volumes: number[];
}): { close: number[]; volume: number[] } {
  return { close: input.closes, volume: input.volumes };
}

describe("generateSignal", () => {
  it("emits BUY when RSI, momentum, and volume ratio all pass", () => {
    const close = Array.from({ length: 40 }, (_, i) => 150 - 3 * i);
    const volume = [...Array(40).fill(60_000), ...Array(20).fill(220_000)];
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.rsi14).not.toBeNull();
    expect(metrics.momentum5dPct).not.toBeNull();
    expect(metrics.volumeRatio).not.toBeNull();
    expect(metrics.rsi14!).toBeLessThan(thresholds.buyRsiMax);
    expect(metrics.momentum5dPct!).toBeLessThan(thresholds.buyMomentumMaxPct);
    expect(metrics.volumeRatio!).toBeGreaterThan(thresholds.buyVolumeRatioMin);
    expect(signal).toBe("BUY");
  });

  it("does not emit BUY when RSI fails", () => {
    const close = Array.from({ length: 40 }, () => 100);
    const volume = Array.from({ length: 60 }, (_, i) => (i < 40 ? 80_000 : 200_000));
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.rsi14).toBe(50);
    expect(signal).toBe("HOLD");
  });

  it("does not emit BUY when momentum fails", () => {
    const close = Array.from({ length: 40 }, (_, i) => 100 + i * 0.01);
    const volume = Array.from({ length: 60 }, (_, i) => (i < 40 ? 80_000 : 200_000));
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.momentum5dPct).not.toBeNull();
    expect(metrics.momentum5dPct!).toBeGreaterThan(thresholds.buyMomentumMaxPct);
    expect(signal).toBe("HOLD");
  });

  it("does not emit BUY when volume ratio fails", () => {
    const close = Array.from({ length: 40 }, (_, i) => 100 - i * 0.5);
    const volume = Array.from({ length: 60 }, () => 100_000);
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(metrics.volumeRatio).toBeCloseTo(1, 5);
    expect(signal).toBe("HOLD");
  });

  it("emits SELL on RSI recovery when a position is open", () => {
    const close = Array.from({ length: 40 }, (_, i) => 50 + i * 2);
    const volume = Array.from({ length: 60 }, () => 200_000);
    const { signal, metrics } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
      position: { entryPrice: 40 },
    });
    expect(metrics.rsi14).not.toBeNull();
    expect(metrics.rsi14!).toBeGreaterThan(thresholds.exitRsiMin);
    expect(signal).toBe("SELL");
  });

  it("emits SELL on stop-loss when a position is open", () => {
    const close = Array.from({ length: 40 }, () => 100);
    const volume = Array.from({ length: 60 }, () => 200_000);
    const { signal } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
      position: { entryPrice: 110 },
    });
    expect(signal).toBe("SELL");
  });

  it("defaults to HOLD when not a BUY and no exit applies", () => {
    const close = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 0.2);
    const volume = Array.from({ length: 60 }, () => 120_000);
    const { signal } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
    });
    expect(signal).toBe("HOLD");
  });

  it("does not emit BUY while a position is open even if entry conditions repeat", () => {
    const close = Array.from({ length: 40 }, () => 100);
    const volume = [...Array(40).fill(60_000), ...Array(20).fill(220_000)];
    const { signal } = generateSignal({
      ...makeBars({ closes: close, volumes: volume }),
      thresholds,
      position: { entryPrice: 95 },
    });
    expect(signal).toBe("HOLD");
  });
});
