import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  PIPELINE_STEPS,
  detectRunMode,
  formatEtYmd,
  getEtMinutesSinceMidnight,
  isWithinExecutionWindow,
  pnpmRunArgs,
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

describe("pnpmRunArgs", () => {
  it("forwards --force-rebalance to screen when pipeline mode is rebalance", () => {
    const screen = PIPELINE_STEPS.find((s) => s.name === "screen")!;
    expect(pnpmRunArgs(screen, "rebalance")).toEqual(["run", "screen", "--", "--force-rebalance"]);
  });

  it("does not forward args for screen when pipeline mode is stop", () => {
    const screen = PIPELINE_STEPS.find((s) => s.name === "screen")!;
    expect(pnpmRunArgs(screen, "stop")).toEqual(["run", "screen"]);
  });

  it("forwards --mode stop to alert when step includes forwardArgs from stepsForMode", () => {
    const alert = stepsForMode("stop").find((s) => s.name === "alert")!;
    expect(pnpmRunArgs(alert, "stop")).toEqual(["run", "alert", "--", "--mode", "stop"]);
  });

  it("forwards --mode rebalance to alert in rebalance pipeline mode", () => {
    const alert = stepsForMode("rebalance").find((s) => s.name === "alert")!;
    expect(pnpmRunArgs(alert, "rebalance")).toEqual(["run", "alert", "--", "--mode", "rebalance"]);
  });
});

describe("runPipeline", () => {
  it("passes --force-rebalance to screen subprocess in rebalance mode", () => {
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd, args?: readonly string[]): SpawnSyncReturns<Buffer> => {
      calls.push(args !== undefined ? [...args] : []);
      return { status: 0 } as SpawnSyncReturns<Buffer>;
    }) as unknown as typeof spawnSync;

    runPipeline("rebalance", { spawn });
    const screenCall = calls.find((a) => a[1] === "screen");
    expect(screenCall).toEqual(["run", "screen", "--", "--force-rebalance"]);
    const alertCall = calls.find((a) => a[1] === "alert");
    expect(alertCall).toEqual(["run", "alert", "--", "--mode", "rebalance"]);
  });

  it("passes --mode stop to alert subprocess in stop mode", () => {
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd, args?: readonly string[]): SpawnSyncReturns<Buffer> => {
      calls.push(args !== undefined ? [...args] : []);
      return { status: 0 } as SpawnSyncReturns<Buffer>;
    }) as unknown as typeof spawnSync;

    runPipeline("stop", { spawn });
    const alertCall = calls.find((a) => a[1] === "alert");
    expect(alertCall).toEqual(["run", "alert", "--", "--mode", "stop"]);
  });

  it("returns 1 and does not run downstream when fetch fails (critical)", () => {
    const spawn = vi.fn((_cmd, args?: readonly string[]): SpawnSyncReturns<Buffer> => {
      if (args?.[1] === "fetch") {
        return { status: 1 } as SpawnSyncReturns<Buffer>;
      }
      return { status: 0 } as SpawnSyncReturns<Buffer>;
    }) as unknown as typeof spawnSync;

    const code = runPipeline("stop", { spawn });
    expect(code).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("continues after enrich fails and still runs alert and dashboard", () => {
    const scripts: string[] = [];
    const spawn = vi.fn((_cmd, args?: readonly string[]): SpawnSyncReturns<Buffer> => {
      const script = args?.[1];
      if (script !== undefined) {
        scripts.push(script);
      }
      if (script === "enrich") {
        return { status: 1 } as SpawnSyncReturns<Buffer>;
      }
      return { status: 0 } as SpawnSyncReturns<Buffer>;
    }) as unknown as typeof spawnSync;

    const code = runPipeline("rebalance", { spawn });
    expect(code).toBe(0);
    expect(scripts).toEqual(["fetch", "screen", "enrich", "alert", "dashboard"]);
  });
});
