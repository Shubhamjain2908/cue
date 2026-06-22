/**
 * P7-G — VIX secondary regime research (isolated backtest only).
 * Stacks `VIX_close <= threshold` on QQQ SMA(200) for new BUY suppression.
 * Does not read or write live `signals` / screener state.
 */

import path from "node:path";

import YahooFinance from "yahoo-finance2";
import type Database from "better-sqlite3";

import { getConfig } from "../../config/index.js";
import { addCalendarDays } from "../../shared/date-utils.js";
import { persistBacktestArtifacts, runBacktest } from "../runner.js";
import {
  BACKTEST_WARMUP_CALENDAR_DAYS,
  DEFAULT_BACKTEST_GATES,
  VIX_MOMENTUM_RESEARCH_STRATEGY,
  VIX_MOMENTUM_THRESHOLDS,
  type BacktestGateThresholds,
  type RunBacktestResult,
  type VixMomentumThreshold,
} from "../types.js";

type SqliteConnection = InstanceType<typeof Database>;

const VIX_TICKER = "^VIX";

/** Calendar padding before `fromDate` so rebalance sessions align with VIX history (reuses BACKTEST_WARMUP_CALENDAR_DAYS). */

type YahooFinanceHandle = InstanceType<typeof YahooFinance>;

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

/**
 * Fetch ^VIX daily closes from Yahoo; keys are ISO `YYYY-MM-DD` (UTC slice).
 * Pattern mirrors `corporate-actions.ts` date normalization.
 */
export async function fetchVixClosesByDate(
  fromDate: string,
  toDate: string,
  yf: YahooFinanceHandle = new YahooFinance({ suppressNotices: ["yahooSurvey"] }),
): Promise<Map<string, number>> {
  const period1 = addCalendarDays(fromDate, -BACKTEST_WARMUP_CALENDAR_DAYS);
  const chart = await yf.chart(VIX_TICKER, {
    period1,
    period2: toDate,
    interval: "1d",
  });

  const map = new Map<string, number>();
  for (const quote of chart.quotes ?? []) {
    if (quote.date === undefined || quote.close === undefined || quote.close === null) {
      continue;
    }
    const ymd = new Date(quote.date).toISOString().slice(0, 10);
    map.set(ymd, quote.close);
  }
  return map;
}

interface SweepRow {
  threshold: VixMomentumThreshold;
  result: RunBacktestResult;
  expectancyPct: number | null;
  runId: bigint;
}

function printVixSweepTable(
  fromDate: string,
  toDate: string,
  rows: readonly SweepRow[],
  gates: BacktestGateThresholds,
): void {
  console.log("");
  console.log(`VIX momentum research sweep  ${fromDate} → ${toDate}`);
  console.log(
    "Gates: CAGR > 12% | MaxDD < 20% | Sharpe > 1.0 | Expectancy > 0%",
  );
  console.log("-".repeat(96));
  console.log(
    [
      "VIX<=".padEnd(6),
      "CAGR".padStart(8),
      "MaxDD".padStart(8),
      "Sharpe".padStart(8),
      "Expect".padStart(9),
      "Trades".padStart(7),
      "Verdict".padStart(8),
    ].join(" "),
  );
  console.log("-".repeat(96));

  for (const row of rows) {
    const { metrics } = row.result;
    const cagr = metrics.cagrPct;
    const maxDd = metrics.maxDrawdownPct;
    const sharpe = metrics.sharpeRatio;
    const exp = row.expectancyPct;
    const pass = allGatesPass(row.result, exp, gates);
    console.log(
      [
        String(row.threshold).padEnd(6),
        (cagr === null ? "n/a" : `${cagr.toFixed(2)}%`).padStart(8),
        (maxDd === null ? "n/a" : `${maxDd.toFixed(2)}%`).padStart(8),
        (sharpe === null ? "n/a" : sharpe.toFixed(3)).padStart(8),
        (exp === null ? "n/a" : `${exp.toFixed(3)}%`).padStart(9),
        String(metrics.totalTrades).padStart(7),
        (pass ? "PASS" : "FAIL").padStart(8),
      ].join(" "),
    );
  }
  console.log("-".repeat(96));
  console.log("");
}

/**
 * Run momentum backtest four times (VIX thresholds 25 / 28 / 30 / 35),
 * print gate comparison table, persist unlocked rows to `backtest_runs`.
 */
export async function runVixMomentumSweep(
  db: SqliteConnection,
  fromDate: string,
  toDate: string,
  gates: BacktestGateThresholds = DEFAULT_BACKTEST_GATES,
): Promise<SweepRow[]> {
  const vixByDate = await fetchVixClosesByDate(fromDate, toDate);
  console.log(
    `vix-momentum: loaded ${String(vixByDate.size)} ^VIX sessions (${fromDate} → ${toDate} window)`,
  );

  const rows: SweepRow[] = [];

  for (const threshold of VIX_MOMENTUM_THRESHOLDS) {
    const result = runBacktest(db, fromDate, toDate, {
      vixGate: { vixByDate, maxVix: threshold },
    });
    const expectancyPct = expectancyPctPerTrade(result);
    const { runId } = persistBacktestArtifacts(
      db,
      fromDate,
      toDate,
      result,
      VIX_MOMENTUM_RESEARCH_STRATEGY,
      `VIX<=${String(threshold)}`,
      0,
    );
    rows.push({ threshold, result, expectancyPct, runId });
  }

  printVixSweepTable(fromDate, toDate, rows, gates);

  const dbAbsPath = path.resolve(process.cwd(), getConfig().DB_PATH);
  console.log(
    `Saved ${String(rows.length)} VIX sweep runs to SQLite (strategy=${VIX_MOMENTUM_RESEARCH_STRATEGY}, locked=0, file=${dbAbsPath}).`,
  );
  for (const row of rows) {
    const pass = allGatesPass(row.result, row.expectancyPct, gates);
    console.log(
      `  id=${row.runId.toString()} VIX<=${String(row.threshold)} ${pass ? "ALL GATES PASS" : "gates not cleared"}`,
    );
  }
  console.log("");

  return rows;
}
