import { afterEach, describe, expect, it } from "vitest";

import {
  compareIsoDate,
  parseIsoUtcMs,
  addCalendarDays,
  isoWeekdayMon1ToFri5,
  tradingDaysHeld,
  calendarYearFraction,
  upperBoundInclusiveByDate,
  lowerBoundInclusiveByDate,
  sliceBarsThrough,
  closeMarkAsOf,
  fmtPct,
  fmtNum,
  mean,
  parseCli,
  aggregateExitBuckets,
} from "../../src/backtest/runner.js";

import type { ClosedBacktestTrade } from "../../src/backtest/types.js";

/* ── compareIsoDate ─────────────────────────────────────────── */

describe("compareIsoDate", () => {
  it("returns -1 when a < b", () => {
    expect(compareIsoDate("2024-01-01", "2024-06-15")).toBe(-1);
  });
  it("returns 1 when a > b", () => {
    expect(compareIsoDate("2024-06-15", "2024-01-01")).toBe(1);
  });
  it("returns 0 when equal", () => {
    expect(compareIsoDate("2024-01-01", "2024-01-01")).toBe(0);
  });
});

/* ── parseIsoUtcMs ──────────────────────────────────────────── */

describe("parseIsoUtcMs", () => {
  it("parses a valid ISO date to UTC ms", () => {
    const ms = parseIsoUtcMs("2024-06-15");
    expect(ms).toBe(Date.UTC(2024, 5, 15));
  });
  it("handles year boundary", () => {
    const ms = parseIsoUtcMs("2023-01-01");
    expect(ms).toBe(Date.UTC(2023, 0, 1));
  });
});

/* ── addCalendarDays ────────────────────────────────────────── */

describe("addCalendarDays", () => {
  it("adds positive days", () => {
    expect(addCalendarDays("2024-01-01", 10)).toBe("2024-01-11");
  });
  it("subtracts days", () => {
    expect(addCalendarDays("2024-06-15", -365)).toBe("2023-06-16");
  });
  it("crosses month boundary", () => {
    expect(addCalendarDays("2024-01-30", 5)).toBe("2024-02-04");
  });
  it("crosses year boundary", () => {
    expect(addCalendarDays("2023-12-25", 10)).toBe("2024-01-04");
  });
});

/* ── isoWeekdayMon1ToFri5 ──────────────────────────────────── */

describe("isoWeekdayMon1ToFri5", () => {
  it("returns 5 for Friday", () => {
    // 2024-01-05 is a Friday
    expect(isoWeekdayMon1ToFri5("2024-01-05")).toBe(5);
  });
  it("returns 0 for Saturday", () => {
    expect(isoWeekdayMon1ToFri5("2024-01-06")).toBe(0);
  });
  it("returns 0 for Sunday", () => {
    expect(isoWeekdayMon1ToFri5("2024-01-07")).toBe(0);
  });
  it("returns 1 for Monday", () => {
    expect(isoWeekdayMon1ToFri5("2024-01-01")).toBe(1);
  });
});

/* ── tradingDaysHeld ────────────────────────────────────────── */

describe("tradingDaysHeld", () => {
  const dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];

  it("counts days after entry up to asOf", () => {
    expect(tradingDaysHeld(dates, "2024-01-01", "2024-01-04")).toBe(3);
  });
  it("returns 0 when entry equals asOf", () => {
    expect(tradingDaysHeld(dates, "2024-01-03", "2024-01-03")).toBe(0);
  });
  it("counts 1 day when entry is before first date and first date <= asOf", () => {
    // entry=2023-12-31 (before all), asOf=2024-01-01 (first date)
    // The first date (2024-01-01) is after entry and not after asOf, so it counts.
    expect(tradingDaysHeld(dates, "2023-12-31", "2024-01-01")).toBe(1);
  });
  it("counts all days when asOf covers all dates after entry", () => {
    expect(tradingDaysHeld(dates, "2024-01-01", "2024-01-10")).toBe(4);
  });
});

/* ── calendarYearFraction ───────────────────────────────────── */

describe("calendarYearFraction", () => {
  it("returns ~1 for a 365-day span", () => {
    const frac = calendarYearFraction("2024-01-01", "2025-01-01");
    expect(frac).toBeCloseTo(1.0, 1);
  });
  it("returns ~0.5 for ~half-year span", () => {
    const frac = calendarYearFraction("2024-01-01", "2024-07-01");
    expect(frac).toBeCloseTo(0.5, 1);
  });
  it("is bounded >= 1e-9 for zero-width span", () => {
    const frac = calendarYearFraction("2024-01-01", "2024-01-01");
    expect(frac).toBeGreaterThanOrEqual(1e-9);
  });
});

/* ── upperBoundInclusiveByDate / lowerBoundInclusiveByDate ─── */

function makeBar(date: string) {
  return { ticker: "T", date, open: 100, high: 110, low: 90, close: 105, volume: 1_000_000 };
}

describe("upperBoundInclusiveByDate", () => {
  const bars = ["2024-01-01", "2024-01-03", "2024-01-05"].map(makeBar);

  it("finds exact date", () => {
    expect(upperBoundInclusiveByDate(bars, "2024-01-03")).toBe(1);
  });
  it("finds last index when asOf is after all", () => {
    expect(upperBoundInclusiveByDate(bars, "2024-01-10")).toBe(2);
  });
  it("returns -1 when asOf is before all", () => {
    expect(upperBoundInclusiveByDate(bars, "2023-12-31")).toBe(-1);
  });
  it("finds midpoint between dates", () => {
    expect(upperBoundInclusiveByDate(bars, "2024-01-04")).toBe(1);
  });
});

describe("lowerBoundInclusiveByDate", () => {
  const bars = ["2024-01-01", "2024-01-03", "2024-01-05"].map(makeBar);

  it("finds exact date", () => {
    expect(lowerBoundInclusiveByDate(bars, "2024-01-03")).toBe(1);
  });
  it("finds first index when from is before all", () => {
    expect(lowerBoundInclusiveByDate(bars, "2023-12-31")).toBe(0);
  });
  it("returns -1 when from is after all", () => {
    expect(lowerBoundInclusiveByDate(bars, "2024-01-10")).toBe(-1);
  });
});

/* ── sliceBarsThrough ───────────────────────────────────────── */

describe("sliceBarsThrough", () => {
  const bars = ["2024-01-01", "2024-01-03", "2024-01-05"].map(makeBar);

  it("returns slice up to asOf", () => {
    const result = sliceBarsThrough(bars, "2024-01-03");
    expect(result).toHaveLength(2);
    expect(result?.[0]?.date).toBe("2024-01-01");
    expect(result?.[1]?.date).toBe("2024-01-03");
  });
  it("returns null when asOf before first bar", () => {
    expect(sliceBarsThrough(bars, "2023-12-31")).toBeNull();
  });
  it("returns all bars when asOf is after the last", () => {
    const result = sliceBarsThrough(bars, "2024-01-10");
    expect(result).toHaveLength(3);
  });
});

/* ── closeMarkAsOf ──────────────────────────────────────────── */

describe("closeMarkAsOf", () => {
  const bars = [
    { ...makeBar("2024-01-01"), close: 100 },
    { ...makeBar("2024-01-03"), close: 102 },
    { ...makeBar("2024-01-05"), close: 105 },
  ];

  it("returns close at the exact date", () => {
    expect(closeMarkAsOf(bars, "2024-01-03")).toBe(102);
  });
  it("returns close at last bar <= asOf", () => {
    expect(closeMarkAsOf(bars, "2024-01-04")).toBe(102);
  });
  it("returns null when no bar <= asOf", () => {
    expect(closeMarkAsOf(bars, "2023-12-31")).toBeNull();
  });
});

/* ── fmtPct / fmtNum ────────────────────────────────────────── */

describe("fmtPct", () => {
  it("formats a number as percentage", () => {
    expect(fmtPct(12.345)).toBe("12.35%");
  });
  it("returns 'n/a' for null", () => {
    expect(fmtPct(null)).toBe("n/a");
  });
  it("returns 'n/a' for NaN", () => {
    expect(fmtPct(NaN)).toBe("n/a");
  });
  it("respects digit param", () => {
    expect(fmtPct(1.23456, 3)).toBe("1.235%");
  });
});

describe("fmtNum", () => {
  it("formats a number with default digits", () => {
    expect(fmtNum(1.23456)).toBe("1.235");
  });
  it("returns 'n/a' for null", () => {
    expect(fmtNum(null)).toBe("n/a");
  });
});

/* ── mean ────────────────────────────────────────────────────── */

describe("mean", () => {
  it("computes average of numbers", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
  it("returns null for empty array", () => {
    expect(mean([])).toBeNull();
  });
  it("handles single element", () => {
    expect(mean([42])).toBe(42);
  });
});

/* ── aggregateExitBuckets ───────────────────────────────────── */

describe("aggregateExitBuckets", () => {
  const baseTrade = {
    entryDate: "2024-01-01",
    exitDate: "2024-03-01",
    realizedPnlUsd: 100,
    entryFillPrice: 100,
    exitFillPrice: 110,
    ticker: "AAPL",
  };

  it("groups exit reasons into buckets", () => {
    const trades: ClosedBacktestTrade[] = [
      { ...baseTrade, exitReason: "gapOrStop" },
      { ...baseTrade, exitReason: "gapOrStop" },
      { ...baseTrade, exitReason: "maxHoldDays" },
      { ...baseTrade, exitReason: "standardTrendBreak" },
    ];
    const buckets = aggregateExitBuckets(trades);
    expect(buckets.TRAILING_STOP.count).toBe(2);
    expect(buckets.MAX_HOLD.count).toBe(1);
    expect(buckets.REBALANCE_DROP.count).toBe(1);
    expect(buckets.FORCED_CLOSE.count).toBe(0);
  });

  it("handles empty trades", () => {
    const buckets = aggregateExitBuckets([]);
    expect(buckets.TRAILING_STOP.count).toBe(0);
    expect(buckets.MAX_HOLD.count).toBe(0);
  });
});

/* ── parseCli ────────────────────────────────────────────────── */

describe("parseCli", () => {
  const origArgv = process.argv;

  afterEach(() => {
    process.argv = origArgv;
  });

  it("defaults to momentum 2021-01-01→2023-12-31", () => {
    process.argv = ["node", "runner.ts"];
    const result = parseCli();
    expect(result.strategy).toBe("momentum");
    expect(result.from).toBe("2021-01-01");
    expect(result.to).toBe("2023-12-31");
  });

  it("overrides from/to when provided", () => {
    process.argv = ["node", "runner.ts", "--from", "2020-01-01", "--to", "2024-01-01"];
    const result = parseCli();
    expect(result.from).toBe("2020-01-01");
    expect(result.to).toBe("2024-01-01");
  });

  it("uses quality-garp defaults when --strategy quality-garp", () => {
    process.argv = ["node", "runner.ts", "--strategy", "quality-garp"];
    const result = parseCli();
    expect(result.strategy).toBe("quality-garp");
    expect(result.from).toBe("2023-01-01");
    expect(result.to).toBe("2025-12-31");
  });
});
