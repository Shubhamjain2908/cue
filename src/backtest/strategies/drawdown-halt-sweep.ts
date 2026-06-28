/**
 * Drawdown-halt research sweep — portfolio-level BUY suppression overlay.
 * Does not read or write live screener / signals state.
 */

import path from "node:path";

import type Database from "better-sqlite3";

import { getConfig } from "../../config/index.js";
import { persistBacktestArtifacts, runBacktest } from "../runner.js";
import {
  DEFAULT_BACKTEST_GATES,
  DRAWDOWN_HALT_RESEARCH_STRATEGY,
  DRAWDOWN_HALT_THRESHOLDS,
  DRAWDOWN_HALT_WINDOW_BULL,
  DRAWDOWN_HALT_WINDOW_EXTENDED,
  type BacktestGateThresholds,
  type DrawdownHaltThreshold,
  type RunBacktestResult,
} from "../types.js";

type SqliteConnection = InstanceType<typeof Database>;

const BULL_FROM = "2023-01-01";
const BULL_TO = "2025-12-31";
const EXTENDED_FROM = "2022-01-01";
const EXTENDED_TO = "2025-12-31";

function mean(nums: readonly number[]): number | null {
  if (nums.length === 0) {
    return null;
  }
  let s = 0;
  for (const n of nums) {
    s += n;
  }
  return s / nums.length;
}

function expectancyPctPerTrade(result: RunBacktestResult): number | null {
  return mean(
    result.closedTrades.map((t) =>
      t.entryFillPrice !== 0
        ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
        : 0,
    ),
  );
}

function allGatesPass(
  result: RunBacktestResult,
  expectancyPct: number | null,
  gates: BacktestGateThresholds,
): boolean {
  const cagr = result.metrics.cagrPct;
  const maxDd = result.metrics.maxDrawdownPct;
  const sharpe = result.metrics.sharpeRatio;
  return (
    cagr !== null &&
    cagr > gates.minCagrPct &&
    maxDd !== null &&
    maxDd < gates.maxDrawdownPct &&
    sharpe !== null &&
    sharpe > gates.minSharpe &&
    expectancyPct !== null &&
    expectancyPct > gates.minExpectancyPct
  );
}

interface SweepRow {
  threshold: DrawdownHaltThreshold;
  windowLabel: string;
  fromDate: string;
  toDate: string;
  result: RunBacktestResult;
  expectancyPct: number | null;
  runId: bigint;
}

function printDrawdownHaltSweepTable(
  rows: readonly SweepRow[],
  gates: BacktestGateThresholds,
  baselines: { label: string; cagr: number; maxDd: number; sharpe: number; expectancy: number }[],
): void {
  console.log("");
  console.log("Drawdown-halt research sweep");
  console.log("Gates: CAGR > 12% | MaxDD < 20% | Sharpe > 1.0 | Expectancy > 0%");
  console.log("-".repeat(108));
  console.log(
    [
      "Window".padEnd(22),
      "Halt%".padStart(6),
      "CAGR".padStart(8),
      "MaxDD".padStart(8),
      "Sharpe".padStart(8),
      "Expect".padStart(9),
      "Trades".padStart(7),
      "Verdict".padStart(8),
    ].join(" "),
  );
  console.log("-".repeat(108));

  for (const b of baselines) {
    console.log(
      [
        b.label.padEnd(22),
        "—".padStart(6),
        `${b.cagr.toFixed(2)}%`.padStart(8),
        `${b.maxDd.toFixed(2)}%`.padStart(8),
        b.sharpe.toFixed(3).padStart(8),
        `${b.expectancy.toFixed(3)}%`.padStart(9),
        "—".padStart(7),
        "BASE".padStart(8),
      ].join(" "),
    );
  }

  for (const row of rows) {
    const { metrics } = row.result;
    const cagr = metrics.cagrPct;
    const maxDd = metrics.maxDrawdownPct;
    const sharpe = metrics.sharpeRatio;
    const exp = row.expectancyPct;
    const pass = allGatesPass(row.result, exp, gates);
    console.log(
      [
        row.windowLabel.padEnd(22),
        String(row.threshold).padStart(6),
        (cagr === null ? "n/a" : `${cagr.toFixed(2)}%`).padStart(8),
        (maxDd === null ? "n/a" : `${maxDd.toFixed(2)}%`).padStart(8),
        (sharpe === null ? "n/a" : sharpe.toFixed(3)).padStart(8),
        (exp === null ? "n/a" : `${exp.toFixed(3)}%`).padStart(9),
        String(metrics.totalTrades).padStart(7),
        (pass ? "PASS" : "FAIL").padStart(8),
      ].join(" "),
    );
  }
  console.log("-".repeat(108));
  console.log("");
}

/**
 * Run momentum backtest with drawdown-halt overlay for each threshold × window,
 * print comparison table (including MOMENTUM baselines), persist unlocked rows.
 */
export function runDrawdownHaltSweep(
  db: SqliteConnection,
  gates: BacktestGateThresholds = DEFAULT_BACKTEST_GATES,
): SweepRow[] {
  const windows = [
    { fromDate: BULL_FROM, toDate: BULL_TO, label: DRAWDOWN_HALT_WINDOW_BULL },
    { fromDate: EXTENDED_FROM, toDate: EXTENDED_TO, label: DRAWDOWN_HALT_WINDOW_EXTENDED },
  ] as const;

  const rows: SweepRow[] = [];

  for (const win of windows) {
    for (const threshold of DRAWDOWN_HALT_THRESHOLDS) {
      const result = runBacktest(db, win.fromDate, win.toDate, {
        drawdownHalt: {
          haltThresholdPct: threshold,
          resumeThresholdPct: threshold / 2,
        },
      });
      const expectancyPct = expectancyPctPerTrade(result);
      const { runId } = persistBacktestArtifacts(
        db,
        win.fromDate,
        win.toDate,
        result,
        DRAWDOWN_HALT_RESEARCH_STRATEGY,
        win.label,
        0,
      );
      rows.push({
        threshold,
        windowLabel: win.label,
        fromDate: win.fromDate,
        toDate: win.toDate,
        result,
        expectancyPct,
        runId,
      });
    }
  }

  const bullBaseline = runBacktest(db, BULL_FROM, BULL_TO);
  const extendedBaseline = runBacktest(db, EXTENDED_FROM, EXTENDED_TO);

  printDrawdownHaltSweepTable(rows, gates, [
    {
      label: `${DRAWDOWN_HALT_WINDOW_BULL} (id=82)`,
      cagr: bullBaseline.metrics.cagrPct ?? 0,
      maxDd: bullBaseline.metrics.maxDrawdownPct ?? 0,
      sharpe: bullBaseline.metrics.sharpeRatio ?? 0,
      expectancy: expectancyPctPerTrade(bullBaseline) ?? 0,
    },
    {
      label: `${DRAWDOWN_HALT_WINDOW_EXTENDED} (id=80)`,
      cagr: extendedBaseline.metrics.cagrPct ?? 0,
      maxDd: extendedBaseline.metrics.maxDrawdownPct ?? 0,
      sharpe: extendedBaseline.metrics.sharpeRatio ?? 0,
      expectancy: expectancyPctPerTrade(extendedBaseline) ?? 0,
    },
  ]);

  const dbAbsPath = path.resolve(process.cwd(), getConfig().DB_PATH);
  console.log(
    `Saved ${String(rows.length)} drawdown-halt sweep runs to SQLite (strategy=${DRAWDOWN_HALT_RESEARCH_STRATEGY}, locked=0, file=${dbAbsPath}).`,
  );
  for (const row of rows) {
    const pass = allGatesPass(row.result, row.expectancyPct, gates);
    console.log(
      `  id=${row.runId.toString()} ${row.windowLabel} halt=${String(row.threshold)}% ${pass ? "ALL GATES PASS" : "gates not cleared"}`,
    );
  }
  console.log("");

  return rows;
}
