import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runBacktest } from "../../src/backtest/runner.js";
import { openCueDbReadonly } from "../../src/db/provider.js";

const CUE_DB = path.resolve(process.cwd(), "db/cue.db");
const hasCueDb = fs.existsSync(CUE_DB);

const BULL_FROM = "2023-01-01";
const BULL_TO = "2025-12-31";

/** Locked MOMENTUM reference (id=82 ceremony). */
const ID_82_BASELINE = {
  totalTrades: 102,
  cagrPct: 21.82,
  maxDrawdownPct: 10.51,
  sharpeRatio: 1.198,
  expectancyPctPerTrade: 4.945,
};

describe.runIf(hasCueDb)("runBacktest drawdown-halt regression", () => {
  it("without drawdownHalt matches id=82 baseline metrics", () => {
    const db = openCueDbReadonly(CUE_DB);
    try {
      const result = runBacktest(db, BULL_FROM, BULL_TO);
      expect(result).toMatchSnapshot({
        metrics: {
          cagrPct: expect.any(Number),
          maxDrawdownPct: expect.any(Number),
          sharpeRatio: expect.any(Number),
          winRatePct: expect.any(Number),
          totalTrades: ID_82_BASELINE.totalTrades,
        },
        closedTrades: expect.any(Array),
        benchmarkCagrPct: expect.any(Number),
        yearFraction: expect.any(Number),
      });
      expect(result.metrics.cagrPct).toBeCloseTo(ID_82_BASELINE.cagrPct, 1);
      expect(result.metrics.maxDrawdownPct).toBeCloseTo(ID_82_BASELINE.maxDrawdownPct, 1);
      expect(result.metrics.sharpeRatio).toBeCloseTo(ID_82_BASELINE.sharpeRatio, 2);
    } finally {
      db.close();
    }
  });

  it("inert 100% halt threshold is identical to no halt overlay", () => {
    const db = openCueDbReadonly(CUE_DB);
    try {
      const baseline = runBacktest(db, BULL_FROM, BULL_TO);
      const inertHalt = runBacktest(db, BULL_FROM, BULL_TO, {
        drawdownHalt: { haltThresholdPct: 100, resumeThresholdPct: 50 },
      });
      expect(inertHalt.metrics).toEqual(baseline.metrics);
      expect(inertHalt.closedTrades).toEqual(baseline.closedTrades);
      expect(inertHalt.equityPoints).toEqual(baseline.equityPoints);
    } finally {
      db.close();
    }
  });
});
