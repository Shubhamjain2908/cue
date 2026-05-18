import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  detectRunMode,
  formatEtYmd,
  getEtMinutesSinceMidnight,
  isWithinExecutionWindow,
  REBALANCE_DAY_OF_WEEK,
  runPipeline,
  stepsForMode,
  weekdayUtcForNyCalendarDate,
} from "../src/pipeline.js";

describe("weekdayUtcForNyCalendarDate", () => {
  it("maps 2026-01-09 (Fri) to Friday (5)", () => {
    expect(weekdayUtcForNyCalendarDate(2026, 1, 9)).toBe(REBALANCE_DAY_OF_WEEK);
  });

  it("maps 2026-01-05 (Mon) to Monday (1)", () => {
    expect(weekdayUtcForNyCalendarDate(2026, 1, 5)).toBe(1);
  });
});

describe("detectRunMode", () => {
  it("returns rebalance on Friday (ET calendar)", () => {
    const now = new Date("2026-01-09T16:10:00-05:00");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("rebalance");
  });

  it("returns stop on Monday (ET calendar)", () => {
    const now = new Date("2026-01-05T16:10:00-05:00");
    expect(detectRunMode({ now, argv: ["node", "pipeline"] })).toBe("stop");
  });

  it("returns rebalance when --force-rebalance is present", () => {
    const now = new Date("2026-01-05T16:10:00-05:00");
    expect(detectRunMode({ now, argv: ["node", "pipeline", "--force-rebalance"] })).toBe("rebalance");
  });
});

describe("stepsForMode", () => {
  it("excludes enrich for stop mode", () => {
    expect(stepsForMode("stop").map((s) => s.name)).toEqual([
      "fetch",
      "screen",
      "alert",
      "dashboard",
    ]);
  });

  it("includes enrich for rebalance mode", () => {
    expect(stepsForMode("rebalance").map((s) => s.name)).toEqual([
      "fetch",
      "screen",
      "enrich",
      "alert",
      "dashboard",
    ]);
  });
});

describe("isWithinExecutionWindow", () => {
  it("is true for 16:10 ET", () => {
    expect(isWithinExecutionWindow(new Date("2026-01-05T16:10:00-05:00"))).toBe(true);
  });

  it("is false at 16:04 ET", () => {
    expect(isWithinExecutionWindow(new Date("2026-01-05T16:04:00-05:00"))).toBe(false);
  });

  it("is false at 16:16 ET", () => {
    expect(isWithinExecutionWindow(new Date("2026-01-05T16:16:00-05:00"))).toBe(false);
  });
});

describe("formatEtYmd / getEtMinutesSinceMidnight", () => {
  it("formats ET civil date from offset instant", () => {
    expect(formatEtYmd(new Date("2026-01-05T16:10:00-05:00"))).toBe("2026-01-05");
  });

  it("reports minutes since midnight in ET", () => {
    expect(getEtMinutesSinceMidnight(new Date("2026-01-05T16:10:00-05:00"))).toBe(16 * 60 + 10);
  });
});

describe("runPipeline", () => {
  it("returns 1 and does not run downstream when fetch fails (critical)", () => {
    const spawn = vi.fn((_cmd, args?: readonly string[]): SpawnSyncReturns => {
      if (args?.[1] === "fetch") {
        return { status: 1 } as SpawnSyncReturns;
      }
      return { status: 0 } as SpawnSyncReturns;
    }) as unknown as typeof spawnSync;

    const code = runPipeline("stop", { spawn });
    expect(code).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("continues after enrich fails and still runs alert and dashboard", () => {
    const scripts: string[] = [];
    const spawn = vi.fn((_cmd, args?: readonly string[]): SpawnSyncReturns => {
      const script = args?.[1];
      if (script !== undefined) {
        scripts.push(script);
      }
      if (script === "enrich") {
        return { status: 1 } as SpawnSyncReturns;
      }
      return { status: 0 } as SpawnSyncReturns;
    }) as unknown as typeof spawnSync;

    const code = runPipeline("rebalance", { spawn });
    expect(code).toBe(0);
    expect(scripts).toEqual(["fetch", "screen", "enrich", "alert", "dashboard"]);
  });
});
