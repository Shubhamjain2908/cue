import { describe, expect, it } from "vitest";

import {
  computeMomentumReturn,
  computeTrailingStop,
  rankUniverse,
} from "../../src/strategy/ranker.js";

describe("computeMomentumReturn", () => {
  it("returns null when series is shorter than lookbackDays", () => {
    expect(computeMomentumReturn(new Array(200).fill(100), 252, 21)).toBeNull();
  });

  it("returns 0 when price is unchanged", () => {
    const closes = new Array(300).fill(100);
    expect(computeMomentumReturn(closes, 252, 21)).toBe(0);
  });

  it("returns correct positive return", () => {
    // priceStart = closes[n-252], priceEnd = closes[n-21]
    const closes = new Array(300).fill(100);
    closes[300 - 252] = 80; // start price
    closes[300 - 21] = 120; // end price
    const result = computeMomentumReturn(closes, 252, 21);
    expect(result).toBeCloseTo(0.5, 5); // (120-80)/80
  });

  it("returns null if priceStart is zero", () => {
    const closes = new Array(300).fill(100);
    closes[300 - 252] = 0;
    expect(computeMomentumReturn(closes, 252, 21)).toBeNull();
  });
});

describe("rankUniverse", () => {
  it("ranks tickers descending by momentum", () => {
    const closes300 = (start: number, end: number) => {
      const arr = new Array(300).fill(100);
      arr[300 - 252] = start;
      arr[300 - 21] = end;
      return arr;
    };
    const priceMap = new Map([
      ["AAPL", closes300(100, 150)], // +50%
      ["MSFT", closes300(100, 130)], // +30%
      ["GOOG", closes300(100, 110)], // +10%
    ]);
    const ranked = rankUniverse(priceMap, { lookbackDays: 252, skipDays: 21, topN: 3 });
    expect(ranked[0]!.ticker).toBe("AAPL");
    expect(ranked[1]!.ticker).toBe("MSFT");
    expect(ranked[2]!.ticker).toBe("GOOG");
    expect(ranked[0]!.rank).toBe(1);
  });

  it("excludes tickers with insufficient history", () => {
    const shortCloses = new Array(200).fill(100);
    const priceMap = new Map([["SHORT", shortCloses]]);
    const ranked = rankUniverse(priceMap, { lookbackDays: 252, skipDays: 21, topN: 5 });
    expect(ranked).toHaveLength(0);
  });
});

describe("computeTrailingStop", () => {
  it("never moves the stop down (Golden Rule)", () => {
    const stop = computeTrailingStop(
      150, // currentStop — already high
      155, // highestClose
      100, // entryPrice
      10, // atrToday — large ATR would produce lower candidate
      2.0,
      1.5,
      15.0,
    );
    expect(stop).toBeGreaterThanOrEqual(150);
  });

  it("tightens multiplier when unrealized >= threshold", () => {
    // entryPrice=100, highestClose=120 → unrealized=20% → tight multiplier
    const tightStop = computeTrailingStop(0, 120, 100, 5, 2.0, 1.5, 15.0);
    const normalStop = computeTrailingStop(0, 108, 100, 5, 2.0, 1.5, 15.0);
    // tight: 120 - 1.5*5 = 112.5  |  normal: 108 - 2.0*5 = 98
    expect(tightStop).toBeCloseTo(112.5, 5);
    expect(normalStop).toBeCloseTo(98, 5);
  });
});
