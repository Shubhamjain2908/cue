import { describe, expect, it } from "vitest";

import {
  detectRunMode,
  executionWindowEtForDate,
  isWithinExecutionWindow,
  REBALANCE_DAY_OF_WEEK,
} from "../../src/agents/daily-workflow.js";
import { schedulerRunKindForNyWeekday } from "../../src/agents/scheduler.js";

describe("schedulerRunKindForNyWeekday", () => {
  it("maps Saturday to rebalance", () => {
    expect(schedulerRunKindForNyWeekday(6)).toBe("rebalance");
  });

  it("maps Monday through Friday to weekday stop maintenance", () => {
    expect(schedulerRunKindForNyWeekday(1)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(2)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(3)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(4)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(5)).toBe("weekday");
  });

  it("returns null on Sunday only", () => {
    expect(schedulerRunKindForNyWeekday(0)).toBeNull();
  });
});

describe("detectRunMode", () => {
  it("returns rebalance on Saturday (ET calendar)", () => {
    const now = new Date("2026-01-10T14:10:00.000Z");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("rebalance");
  });

  it("returns stop on Friday (ET calendar)", () => {
    const now = new Date("2026-01-09T21:10:00.000Z");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("stop");
  });

  it("returns stop on Monday (ET calendar)", () => {
    const now = new Date("2026-01-05T21:10:00.000Z");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("stop");
  });
});

describe("isWithinExecutionWindow", () => {
  it("uses 16:05–16:15 ET on weekdays", () => {
    expect(isWithinExecutionWindow(new Date("2026-01-05T21:10:00.000Z"))).toBe(true);
    expect(isWithinExecutionWindow(new Date("2026-01-05T21:04:00.000Z"))).toBe(false);
    expect(isWithinExecutionWindow(new Date("2026-01-09T21:16:00.000Z"))).toBe(false);
  });

  it("uses 09:05–09:15 ET on Saturday rebalance day", () => {
    expect(REBALANCE_DAY_OF_WEEK).toBe(6);
    expect(isWithinExecutionWindow(new Date("2026-01-10T14:10:00.000Z"))).toBe(true);
    expect(isWithinExecutionWindow(new Date("2026-01-10T14:04:00.000Z"))).toBe(false);
    expect(isWithinExecutionWindow(new Date("2026-01-10T21:10:00.000Z"))).toBe(false);
  });

  it("executionWindowEtForDate reflects Saturday morning window", () => {
    const sat = new Date("2026-01-10T14:10:00.000Z");
    expect(executionWindowEtForDate(sat)).toEqual({ startMin: 9 * 60 + 5, endMin: 9 * 60 + 15 });
    const mon = new Date("2026-01-05T21:10:00.000Z");
    expect(executionWindowEtForDate(mon)).toEqual({ startMin: 16 * 60 + 5, endMin: 16 * 60 + 15 });
  });
});
