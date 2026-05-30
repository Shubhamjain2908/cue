import { describe, expect, it, vi } from "vitest";

import { allowNewBuysForVixSession } from "../../src/backtest/runner.js";

describe("allowNewBuysForVixSession", () => {
  it("returns true when no VIX gate is configured", () => {
    expect(allowNewBuysForVixSession("2024-06-07")).toBe(true);
  });

  it("returns true when VIX close is at or below threshold", () => {
    const vixByDate = new Map([["2024-06-07", 24.5]]);
    expect(allowNewBuysForVixSession("2024-06-07", { vixByDate, maxVix: 25 })).toBe(true);
  });

  it("returns false when VIX close exceeds threshold", () => {
    const vixByDate = new Map([["2024-06-07", 26]]);
    expect(allowNewBuysForVixSession("2024-06-07", { vixByDate, maxVix: 25 })).toBe(false);
  });

  it("warns and returns true when session date is missing from VIX map", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(allowNewBuysForVixSession("2024-06-07", { vixByDate: new Map(), maxVix: 25 })).toBe(
      true,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2024-06-07"));
    warn.mockRestore();
  });
});
