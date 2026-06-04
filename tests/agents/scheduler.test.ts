import { describe, expect, it } from "vitest";

import {
  detectRunMode,
  executionWindowEtForDate,
  isWithinExecutionWindow,
  REBALANCE_DAY_OF_WEEK,
} from "../../src/agents/daily-workflow.js";
import { schedulerRunKindForNyWeekday } from "../../src/agents/scheduler.js";

describe("schedulerRunKindForNyWeekday", () => {
  it("maps Sunday to rebalance", () => {
    expect(schedulerRunKindForNyWeekday(0)).toBe("rebalance");
  });

  it("maps Tuesday through Saturday to weekday stop maintenance", () => {
    expect(schedulerRunKindForNyWeekday(2)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(3)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(4)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(5)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(6)).toBe("weekday");
  });

  it("returns null on Monday only", () => {
    expect(schedulerRunKindForNyWeekday(1)).toBeNull();
  });
});

describe("detectRunMode", () => {
  it("returns rebalance on Sunday (ET calendar)", () => {
    const now = new Date("2026-01-11T11:05:00.000Z");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("rebalance");
  });

  it("returns stop on Saturday (ET calendar)", () => {
    const now = new Date("2026-01-10T11:05:00.000Z");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("stop");
  });

  it("returns stop on Tuesday (ET calendar)", () => {
    const now = new Date("2026-01-06T11:05:00.000Z");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("stop");
  });
});

describe("isWithinExecutionWindow", () => {
  it("uses 06:00–06:10 ET on weekdays", () => {
    expect(isWithinExecutionWindow(new Date("2026-01-06T11:05:00.000Z"))).toBe(true);
    expect(isWithinExecutionWindow(new Date("2026-01-06T10:59:00.000Z"))).toBe(false);
    expect(isWithinExecutionWindow(new Date("2026-01-10T11:11:00.000Z"))).toBe(false);
  });

  it("uses 06:00–06:10 ET on Sunday rebalance day", () => {
    expect(REBALANCE_DAY_OF_WEEK).toBe(0);
    expect(isWithinExecutionWindow(new Date("2026-01-11T11:05:00.000Z"))).toBe(true);
    expect(isWithinExecutionWindow(new Date("2026-01-11T10:59:00.000Z"))).toBe(false);
    expect(isWithinExecutionWindow(new Date("2026-01-11T11:11:00.000Z"))).toBe(false);
  });

  it("executionWindowEtForDate reflects 06:00 windows", () => {
    const sun = new Date("2026-01-11T11:05:00.000Z");
    expect(executionWindowEtForDate(sun)).toEqual({ startMin: 6 * 60, endMin: 6 * 60 + 10 });
    const tue = new Date("2026-01-06T11:05:00.000Z");
    expect(executionWindowEtForDate(tue)).toEqual({ startMin: 6 * 60, endMin: 6 * 60 + 10 });
  });
});
