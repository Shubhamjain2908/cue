/**
 * Rolling-window re-gate harness — research-only strategy viability assessment.
 *
 * Enumerates 2-year windows stepped by 3 months across available daily_prices
 * history, runs the existing runBacktest engine on each, and emits a comparison
 * table with pass/fail vs DEFAULT_BACKTEST_GATES, summary statistics, and a
 * bootstrap 95% CI on pooled per-trade expectancy.
 *
 * ## Survivorship-bias caveat
 * The current-constituent Nasdaq-100 universe is used for all windows, which
 * inflates results. Tracked as a known upper bound.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { addCalendarDays, calendarYearFraction, compareIsoDate } from "../shared/date-utils.js";
import { sma } from "../enrichers/indicators.js";
import { runBacktest, persistBacktestArtifacts } from "./runner.js";
import {
  BACKTEST_WARMUP_CALENDAR_DAYS,
  DEFAULT_BACKTEST_GATES,
  type BacktestGateThresholds,
  type RunBacktestResult,
} from "./types.js";
import { DEFAULT_RANKING_CONFIG } from "../enrichers/momentum-types.js";
import { openCueDb } from "../db/provider.js";
import { initSchema } from "../db/schema.js";
import { loadUniverseTickers } from "../universe/load-universe.js";

type SqliteConnection = InstanceType<typeof Database>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @default `MOMENTUM_ROLLING_RESEARCH` — strategy label for window runs. */
export const ROLLING_STRATEGY_LABEL = "MOMENTUM_ROLLING_RESEARCH";

/** @default 730 — 2-year window width in calendar days. */
export const WINDOW_CALENDAR_DAYS = 730;

/** @default 90 — window step in calendar days (3 months). */
export const WINDOW_STEP_CALENDAR_DAYS = 90;

/** @default 10_000 — bootstrap resamples for confidence intervals. */
export const BOOTSTRAP_RESAMPLES = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RollingWindowRow {
  /** 0-based index within the enumerated windows. */
  index: number;
  fromDate: string;
  toDate: string;
  /** Calendar years spanned (trading days). */
  years: number;
  /** Strategy CAGR percentage (null if no trades). */
  cagr: number | null;
  /** Max drawdown percentage. */
  maxDrawdown: number | null;
  /** Sharpe ratio. */
  sharpe: number | null;
  /** Win rate percentage. */
  winRate: number | null;
  /** Mean per-trade return percentage. */
  expectancy: number | null;
  /** Number of closed round-trip trades. */
  trades: number;
  /** QQQ buy-and-hold CAGR percentage for the same window. */
  benchmarkCagr: number | null;
  /** Fraction of days QQQ close > SMA200 (0–1). Null when data insufficient. */
  regimeFraction: number | null;
  /** Whether the window passes all DEFAULT_BACKTEST_GATES. */
  gatePass: boolean;
  /** Which gate thresholds failed (empty when pass). */
  gateFailures: string[];
}

export interface RollingGateSummary {
  totalWindows: number;
  passCount: number;
  passRatePct: number;
  medianCagr: number | null;
  medianSharpe: number | null;
  p10Sharpe: number | null;
  worstCagrWindow: RollingWindowRow | null;
  worstMaxDdWindow: RollingWindowRow | null;
  bestCagrWindow: RollingWindowRow | null;
  /** Bootstrap 95% CI on pooled expectancy across all trades. */
  expectancyCi95Lo: number | null;
  expectancyCi95Hi: number | null;
}

export interface PerturbationResult {
  label: string;
  topN: number;
  atrBase: number;
  passRatePct: number;
}

// ---------------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------------

/** QQQ first and last date from daily_prices. */
export function getQqqDateRange(db: SqliteConnection): { first: string | null; last: string | null } {
  const row = db
    .prepare(`SELECT MIN(date) AS first, MAX(date) AS last FROM daily_prices WHERE ticker = 'QQQ'`)
    .get() as { first: string | null; last: string | null };
  return row;
}

/**
 * Enumerate 2-year windows stepped by 3 months that fit within available data.
 * First window starts at `earliestStart` (max of dataFirst + warmup and explicit fromDate).
 * Windows are emitted forward until the end date exceeds available data.
 */
export function enumerateWindows(
  dataFirst: string,
  dataLast: string,
  fromDate?: string,
  toDate?: string,
): Array<{ from: string; to: string }> {
  const earliestPossibleStart = addCalendarDays(dataFirst, BACKTEST_WARMUP_CALENDAR_DAYS);

  // Clamp to user-specified range if provided
  const effectiveFrom = fromDate ?? earliestPossibleStart;
  const effectiveTo = toDate ?? dataLast;

  if (compareIsoDate(effectiveFrom, effectiveTo) > 0) {
    return [];
  }

  const windows: Array<{ from: string; to: string }> = [];
  let cursor = effectiveFrom;

  while (true) {
    const windowEnd = addCalendarDays(cursor, WINDOW_CALENDAR_DAYS);
    if (compareIsoDate(windowEnd, effectiveTo) > 0) {
      break;
    }
    windows.push({ from: cursor, to: windowEnd });
    cursor = addCalendarDays(cursor, WINDOW_STEP_CALENDAR_DAYS);
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Regime label
// ---------------------------------------------------------------------------

/**
 * Compute the fraction of trading days in a window where QQQ close > SMA200.
 * Returns null when insufficient data for SMA200 calculation.
 */
export function computeRegimeFraction(
  db: SqliteConnection,
  fromDate: string,
  toDate: string,
): number | null {
  const dataFrom = addCalendarDays(fromDate, -200); // need prior 200 bars for SMA

  const rows = db
    .prepare(
      `SELECT date, close FROM daily_prices
       WHERE ticker = 'QQQ' AND date >= ? AND date <= ?
       ORDER BY date ASC`,
    )
    .all(dataFrom, toDate) as Array<{ date: string; close: number }>;

  if (rows.length < 200) {
    return null;
  }

  // Compute SMA200 for each day in the window using existing sma() helper
  let daysAbove = 0;
  let totalDays = 0;

  for (let i = 199; i < rows.length; i++) {
    const bar = rows[i]!;
    if (compareIsoDate(bar.date, fromDate) < 0) {
      continue; // still in warmup
    }
    const closes = rows.slice(0, i + 1).map((r) => r.close);
    const smaVal = sma(200, closes);
    if (smaVal !== null && bar.close > smaVal) {
      daysAbove++;
    }
    totalDays++;
  }

  return totalDays > 0 ? daysAbove / totalDays : null;
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

/** Check a window result against gate thresholds. */
export function evaluateGate(
  row: RollingWindowRow,
  gates: BacktestGateThresholds = DEFAULT_BACKTEST_GATES,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (row.cagr === null || row.cagr < gates.minCagrPct) {
    failures.push(`CAGR ${row.cagr !== null ? row.cagr.toFixed(1) + "%" : "null"} < ${gates.minCagrPct}%`);
  }
  if (row.maxDrawdown !== null && row.maxDrawdown > gates.maxDrawdownPct) {
    failures.push(`MaxDD ${row.maxDrawdown.toFixed(1)}% > ${gates.maxDrawdownPct}%`);
  }
  if (row.sharpe === null || row.sharpe < gates.minSharpe) {
    failures.push(`Sharpe ${row.sharpe !== null ? row.sharpe.toFixed(3) : "null"} < ${gates.minSharpe}`);
  }
  if (row.expectancy === null || row.expectancy < gates.minExpectancyPct) {
    failures.push(`Expectancy ${row.expectancy !== null ? row.expectancy.toFixed(2) + "%" : "null"} < ${gates.minExpectancyPct}%`);
  }
  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Bootstrap CI
// ---------------------------------------------------------------------------

/** Draw a simple random sample with replacement from an array. */
function sampleWithReplacement<T>(arr: readonly T[]): T[] {
  const out: T[] = [];
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.floor(Math.random() * n)]!);
  }
  return out;
}

/** Bootstrap 95% CI on the mean of an array of numbers. */
export function bootstrapMeanCi95(
  values: readonly number[],
  resamples: number = BOOTSTRAP_RESAMPLES,
): { lo: number; hi: number } | null {
  if (values.length < 2) {
    return null;
  }
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample = sampleWithReplacement(values);
    const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
    means.push(mean);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor(resamples * 0.025);
  const hiIdx = Math.floor(resamples * 0.975);
  return {
    lo: means[loIdx]!,
    hi: means[hiIdx]!,
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Run the rolling-window backtest grid.
 * @returns Array of result rows plus a summary.
 */
export function runRollingGate(
  db: SqliteConnection,
  fromDate?: string,
  toDate?: string,
): { windows: RollingWindowRow[]; summary: RollingGateSummary; results: RunBacktestResult[] } {
  const { first, last } = getQqqDateRange(db);
  if (first === null || last === null) {
    throw new Error("rolling-gate: no QQQ data in daily_prices");
  }

  const enumerated = enumerateWindows(first, last, fromDate, toDate);
  if (enumerated.length === 0) {
    throw new Error(
      `rolling-gate: no windows fit within data range ${first} → ${last} ` +
        `(need at least ${String(BACKTEST_WARMUP_CALENDAR_DAYS + WINDOW_CALENDAR_DAYS)} days of QQQ data)`,
    );
  }

  const windows: RollingWindowRow[] = [];
  const results: RunBacktestResult[] = [];
  const allExpectancies: number[] = [];

  for (let i = 0; i < enumerated.length; i++) {
    const { from, to } = enumerated[i]!;
    const years = calendarYearFraction(from, to);

    const result: RunBacktestResult = runBacktest(db, from, to);
    results.push(result);

    // Compute per-trade expectancy %
    const expectancyPct =
      result.closedTrades.length > 0
        ? result.closedTrades.reduce((s, t) => {
            const pnlPct =
              t.entryFillPrice !== 0
                ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
                : 0;
            return s + pnlPct;
          }, 0) / result.closedTrades.length
        : null;

    // Collect for bootstrap
    for (const t of result.closedTrades) {
      const pnlPct =
        t.entryFillPrice !== 0
          ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
          : 0;
      allExpectancies.push(pnlPct);
    }

    const regimeFraction = computeRegimeFraction(db, from, to);

    const row: RollingWindowRow = {
      index: i,
      fromDate: from,
      toDate: to,
      years,
      cagr: result.metrics.cagrPct,
      maxDrawdown: result.metrics.maxDrawdownPct,
      sharpe: result.metrics.sharpeRatio,
      winRate: result.metrics.winRatePct,
      expectancy: expectancyPct,
      trades: result.metrics.totalTrades,
      benchmarkCagr: result.benchmarkCagrPct,
      regimeFraction,
      gatePass: false,
      gateFailures: [],
    };

    const { pass, failures } = evaluateGate(row);
    row.gatePass = pass;
    row.gateFailures = failures;

    windows.push(row);
  }

  // ---- Summary statistics ----
  const cagrs = windows.map((w) => w.cagr).filter((v): v is number => v !== null);
  const sharpes = windows.map((w) => w.sharpe).filter((v): v is number => v !== null);
  const passCount = windows.filter((w) => w.gatePass).length;

  const sortedCagr = [...cagrs].sort((a, b) => a - b);
  const sortedSharpe = [...sharpes].sort((a, b) => a - b);

  const median = (sorted: number[]): number | null =>
    sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null;

  const worstCagrWindow =
    windows.length > 0
      ? windows.reduce((a, b) => ((a.cagr ?? -Infinity) < (b.cagr ?? -Infinity) ? a : b))
      : null;

  const worstMaxDdWindow =
    windows.length > 0
      ? windows.reduce((a, b) => ((a.maxDrawdown ?? -Infinity) > (b.maxDrawdown ?? -Infinity) ? a : b))
      : null;

  const bestCagrWindow =
    windows.length > 0
      ? windows.reduce((a, b) => ((a.cagr ?? -Infinity) > (b.cagr ?? -Infinity) ? a : b))
      : null;

  // Bootstrap CI on pooled per-trade expectancy
  const expectancyCi = allExpectancies.length > 0 ? bootstrapMeanCi95(allExpectancies) : null;

  const summary: RollingGateSummary = {
    totalWindows: windows.length,
    passCount,
    passRatePct: windows.length > 0 ? (passCount / windows.length) * 100 : 0,
    medianCagr: median(sortedCagr),
    medianSharpe: median(sortedSharpe),
    p10Sharpe:
      sortedSharpe.length > 0
        ? sortedSharpe[Math.floor(sortedSharpe.length * 0.1)]!
        : null,
    worstCagrWindow,
    worstMaxDdWindow,
    bestCagrWindow,
    expectancyCi95Lo: expectancyCi?.lo ?? null,
    expectancyCi95Hi: expectancyCi?.hi ?? null,
  };

  return { windows, summary, results };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist each window result to backtest_runs with strategy=MOMENTUM_ROLLING_RESEARCH,
 * window_label='ROLLING', locked=0 (research).
 */
export function persistRollingWindows(
  db: SqliteConnection,
  windows: RollingWindowRow[],
  results: RunBacktestResult[],
): { persisted: number } {
  let persisted = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const result = results[i]!;
    if (result.closedTrades.length === 0) {
      continue; // skip empty windows
    }
    persistBacktestArtifacts(
      db,
      w.fromDate,
      w.toDate,
      result,
      ROLLING_STRATEGY_LABEL,
      "ROLLING",
      0, // not locked
    );
    persisted++;
  }
  return { persisted };
}

// ---------------------------------------------------------------------------
// Perturbation mode
// ---------------------------------------------------------------------------

/** Perturbation grid values. */
const PERTURB_TOP_N = [2, 3, 4] as const;
const PERTURB_ATR_BASE = [3.5, 4.0, 4.5] as const;

/**
 * Re-run the full rolling grid for each combination of topN and atrBase,
 * and report pass-rate sensitivity.
 */
export function runPerturbationGrid(
  db: SqliteConnection,
  fromDate?: string,
  toDate?: string,
): PerturbationResult[] {
  const results: PerturbationResult[] = [];
  const savedTopN = DEFAULT_RANKING_CONFIG.topN;
  const savedAtrBase = DEFAULT_RANKING_CONFIG.atrMultiplierBase;

  for (const topN of PERTURB_TOP_N) {
    for (const atrBase of PERTURB_ATR_BASE) {
      DEFAULT_RANKING_CONFIG.topN = topN;
      DEFAULT_RANKING_CONFIG.atrMultiplierBase = atrBase;

      // Re-run the full grid
      let passCount = 0;
      let totalWindows = 0;

      try {
        const { windows } = runRollingGate(db, fromDate, toDate);
        totalWindows = windows.length;
        passCount = windows.filter((w) => w.gatePass).length;
      } catch {
        // Window may be empty at some parameter combos
      }

      results.push({
        label: `topN=${topN} atr=${atrBase}`,
        topN,
        atrBase,
        passRatePct: totalWindows > 0 ? (passCount / totalWindows) * 100 : 0,
      });
    }
  }

  // Restore original values
  DEFAULT_RANKING_CONFIG.topN = savedTopN;
  DEFAULT_RANKING_CONFIG.atrMultiplierBase = savedAtrBase;

  return results;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/** Format a single value for the comparison table. */
function fmt(v: number | null | undefined, decimals: number, suffix = ""): string {
  if (v === null || v === undefined) return "N/A";
  return v.toFixed(decimals) + suffix;
}

/** Build the rolling-window comparison table as a string. */
export function formatRollingTable(windows: RollingWindowRow[]): string {
  if (windows.length === 0) return "No windows to report.";

  const lines: string[] = [];

  // Table header
  const colWidths = {
    idx: 3,
    from: 12,
    to: 12,
    cagr: 9,
    maxDd: 8,
    sharpe: 8,
    winRate: 8,
    expct: 9,
    trades: 7,
    bench: 9,
    regime: 8,
    gate: 6,
  };

  const hdr = [
    "#".padStart(colWidths.idx),
    "From".padStart(colWidths.from),
    "To".padStart(colWidths.to),
    "CAGR".padStart(colWidths.cagr),
    "MaxDD".padStart(colWidths.maxDd),
    "Sharpe".padStart(colWidths.sharpe),
    "WinRate".padStart(colWidths.winRate),
    "Expct".padStart(colWidths.expct),
    "Trades".padStart(colWidths.trades),
    "Bench".padStart(colWidths.bench),
    "Regime".padStart(colWidths.regime),
    "Gate".padStart(colWidths.gate),
  ].join("  ");
  lines.push(hdr);
  lines.push("-".repeat(hdr.length));

  for (const w of windows) {
    const regimeStr =
      w.regimeFraction !== null ? (w.regimeFraction * 100).toFixed(0) + "%" : "N/A";
    lines.push(
      [
        String(w.index).padStart(colWidths.idx),
        w.fromDate.padStart(colWidths.from),
        w.toDate.padStart(colWidths.to),
        fmt(w.cagr, 2, "%").padStart(colWidths.cagr),
        fmt(w.maxDrawdown, 2, "%").padStart(colWidths.maxDd),
        fmt(w.sharpe, 3).padStart(colWidths.sharpe),
        fmt(w.winRate, 1, "%").padStart(colWidths.winRate),
        fmt(w.expectancy, 2, "%").padStart(colWidths.expct),
        String(w.trades).padStart(colWidths.trades),
        fmt(w.benchmarkCagr, 2, "%").padStart(colWidths.bench),
        regimeStr.padStart(colWidths.regime),
        (w.gatePass ? "PASS" : "FAIL").padStart(colWidths.gate),
      ].join("  "),
    );
  }

  return lines.join("\n");
}

/** Format summary statistics. */
export function formatRollingSummary(summary: RollingGateSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(60));
  lines.push("Rolling-Window Re-Gate Summary");
  lines.push("=".repeat(60));
  lines.push(`  Windows:           ${String(summary.totalWindows)}`);
  lines.push(`  Gate pass rate:    ${summary.passRatePct.toFixed(1)}% (${String(summary.passCount)}/${String(summary.totalWindows)})`);
  lines.push(`  Median CAGR:       ${fmt(summary.medianCagr, 2, "%")}`);
  lines.push(`  Median Sharpe:     ${fmt(summary.medianSharpe, 3)}`);
  lines.push(`  P10 Sharpe:        ${fmt(summary.p10Sharpe, 3)}`);
  lines.push("");
  lines.push(`  Worst CAGR window: #${summary.worstCagrWindow?.index ?? "?"} ` +
    `${summary.worstCagrWindow?.fromDate ?? "?"}→${summary.worstCagrWindow?.toDate ?? "?"} ` +
    `${fmt(summary.worstCagrWindow?.cagr, 2, "%")}`);
  lines.push(`  Worst MaxDD window:#${summary.worstMaxDdWindow?.index ?? "?"} ` +
    `${summary.worstMaxDdWindow?.fromDate ?? "?"}→${summary.worstMaxDdWindow?.toDate ?? "?"} ` +
    `${fmt(summary.worstMaxDdWindow?.maxDrawdown, 2, "%")}`);
  lines.push(`  Best CAGR window:  #${summary.bestCagrWindow?.index ?? "?"} ` +
    `${summary.bestCagrWindow?.fromDate ?? "?"}→${summary.bestCagrWindow?.toDate ?? "?"} ` +
    `${fmt(summary.bestCagrWindow?.cagr, 2, "%")}`);
  lines.push("");
  if (summary.expectancyCi95Lo !== null && summary.expectancyCi95Hi !== null) {
    lines.push(`  Bootstrap 95% CI on per-trade P&L:`);
    lines.push(`    Expectancy: [${summary.expectancyCi95Lo.toFixed(3)}%, ${summary.expectancyCi95Hi.toFixed(3)}%]`);
  }
  return lines.join("\n");
}

/** Format perturbation results table. */
export function formatPerturbationTable(results: PerturbationResult[]): string {
  if (results.length === 0) return "No perturbation results.";
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(55));
  lines.push("Perturbation — Pass Rate Sensitivity");
  lines.push("=".repeat(55));
  lines.push("  Config".padEnd(22) + "Pass Rate".padStart(12));
  lines.push("  " + "-".repeat(32));
  for (const r of results) {
    lines.push(
      `  ${r.label.padEnd(20)} ${r.passRatePct.toFixed(1).padStart(6)}%`,
    );
  }
  return lines.join("\n");
}

/** Structured CLI options — also used by Commander wrapper in cli.ts. */
export interface RollingGateCliOptions {
  from?: string;
  to?: string;
  perturb?: boolean;
  persist?: boolean;
  /** Path to write the report file (default: no file). */
  report?: string;
}

/** Full CLI entry point. */
export function runRollingGateCli(opts?: RollingGateCliOptions): void {
  const {
    from: fromDate,
    to: toDate,
    perturb = false,
    persist = false,
    report,
  } = opts ?? {};

  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    initSchema(db);

    const { first, last } = getQqqDateRange(db);
    console.log(`\nData range: QQQ ${first ?? "N/A"} → ${last ?? "N/A"}`);
    console.log(`Universe: ${loadUniverseTickers().length} tickers`);

    if (perturb) {
      console.log("\nRunning perturbation grid (topN×atrBase)...");
      const perturbResults = runPerturbationGrid(db, fromDate, toDate);
      console.log(formatPerturbationTable(perturbResults));
      return;
    }

    console.log("\nRunning rolling-window backtest...");
    const { windows, summary, results } = runRollingGate(db, fromDate, toDate);

    console.log(formatRollingTable(windows));
    console.log(formatRollingSummary(summary));

    // Survivorship bias caveat
    console.log("");
    console.log("-".repeat(60));
    console.log("NOTE: Current-constituent universe creates survivorship bias.");
    console.log("Results are an upper bound on achievable returns.");
    console.log("-".repeat(60));
    console.log("");

    if (persist) {
      const { persisted } = persistRollingWindows(db, windows, results);
      console.log(`Persisted ${persisted} window run(s) to backtest_runs.`);
    }

    // Write report file if requested
    if (report) {
      const reportLines: string[] = [
        `# Rolling-Window Re-Gate Report`,
        `Generated: ${new Date().toISOString().slice(0, 10)}`,
        `Data range: QQQ ${first ?? "N/A"} → ${last ?? "N/A"}`,
        `Universe: ${loadUniverseTickers().length} tickers`,
        `Window: ${WINDOW_CALENDAR_DAYS}d, step: ${WINDOW_STEP_CALENDAR_DAYS}d`,
        `Gates: CAGR≥${DEFAULT_BACKTEST_GATES.minCagrPct}%, MaxDD≤${DEFAULT_BACKTEST_GATES.maxDrawdownPct}%, Sharpe≥${DEFAULT_BACKTEST_GATES.minSharpe}, Expectancy≥${DEFAULT_BACKTEST_GATES.minExpectancyPct}%`,
        ``,
        formatRollingTable(windows),
        formatRollingSummary(summary),
        ``,
        `Note: Current-constituent universe creates survivorship bias. Results are an upper bound.`,
      ];
      const dir = path.dirname(report);
      if (dir !== ".") {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(report, reportLines.join("\n") + "\n", "utf-8");
      console.log(`Report written to ${report}`);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  runRollingGateCli();
}
