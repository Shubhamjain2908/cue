import { describe, expect, it } from "vitest";

import { schedulerRunKindForNyWeekday } from "../src/agents/scheduler.js";

describe("schedulerRunKindForNyWeekday", () => {
  it("maps Friday to rebalance", () => {
    expect(schedulerRunKindForNyWeekday(5)).toBe("rebalance");
  });

  it("maps Monday through Thursday to weekday maintenance", () => {
    expect(schedulerRunKindForNyWeekday(1)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(2)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(3)).toBe("weekday");
    expect(schedulerRunKindForNyWeekday(4)).toBe("weekday");
  });

  it("returns null on weekend", () => {
    expect(schedulerRunKindForNyWeekday(0)).toBeNull();
    expect(schedulerRunKindForNyWeekday(6)).toBeNull();
  });
});
