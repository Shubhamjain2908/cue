import { describe, expect, it } from "vitest";

import { computeDrawdownHaltMask } from "../../src/backtest/drawdown-halt.js";

describe("computeDrawdownHaltMask", () => {
  it("halts at threshold and resumes at half-threshold hysteresis", () => {
    const series = [
      { date: "2024-01-02", nav: 100 },
      { date: "2024-01-03", nav: 88 },
      { date: "2024-01-04", nav: 96 },
    ];
    const mask = computeDrawdownHaltMask(series, 10, 5);

    expect(mask).toEqual([
      { date: "2024-01-02", halted: false, drawdownPct: 0 },
      { date: "2024-01-03", halted: true, drawdownPct: 12 },
      { date: "2024-01-04", halted: false, drawdownPct: 4 },
    ]);
  });

  it("stays halted while drawdown remains above resume threshold", () => {
    const series = [
      { date: "2024-01-02", nav: 100 },
      { date: "2024-01-03", nav: 88 },
      { date: "2024-01-04", nav: 94 },
    ];
    const mask = computeDrawdownHaltMask(series, 10, 5);

    expect(mask[1]?.halted).toBe(true);
    expect(mask[2]?.halted).toBe(true);
    expect(mask[2]?.drawdownPct).toBe(6);
  });

  it("returns empty mask for empty series", () => {
    expect(computeDrawdownHaltMask([], 10, 5)).toEqual([]);
  });
});
