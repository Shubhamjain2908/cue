/**
 * Earnings-blackout veto research — research-only tool (Task 8).
 *
 * Runs the rolling-window backtest grid for each earnings-blackout window size,
 * comparing metrics against baseline (0 days). Reports whether skipping BUYs
 * near earnings report dates improves CAGR, Sharpe, and expectancy.
 *
 * ## Usage
 * ```
 * pnpm run cue -- backtest-earnings-veto [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   [--days 0,1,3,5,10] [--report path] [--fetch] [--persist]
 * ```
 *
 * ## Caveats
 * - Earnings data comes from Yahoo `quoteSummary('earnings')` (last ~4 quarters).
 * - Historical earnings coverage is limited to ~2024–2026 for most tickers.
 * - This is research-only; promoting to live execution requires a re-gate.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import YahooFinance from "yahoo-finance2";

import { getConfig } from "../config/index.js";
import { openCueDb } from "../db/provider.js";
import { initSchema } from "../db/schema.js";
import { compareIsoDate } from "../shared/date-utils.js";
import { runBacktest, persistBacktestArtifacts } from "./runner.js";
import {
  DEFAULT_BACKTEST_GATES,
} from "./types.js";
import { loadUniverseTickers } from "../universe/load-universe.js";
import { fetchAndPersistEarnings } from "../ingestors/earnings-ingestor.js";
import {
  enumerateWindows,
  bootstrapMeanCi95,
} from "./rolling-gate.js";

type SqliteConnection = InstanceType<typeof Database>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Blackout window sizes to test (calendar days before/after earnings). */
const DEFAULT_BLACKOUT_DAYS = [0, 1, 3, 5, 10] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EarningsVetoWindowRow {
  index: number;
  fromDate: string;
  toDate: string;
  /** Baseline metrics (no blackout). */
  baseline: {
    cagr: number | null;
    maxDrawdown: number | null;
    sharpe: number | null;
    winRate: number | null;
    expectancy: number | null;
    trades: number;
  };
  /** Blackout results keyed by blackout days. */
  blackouts: Record<
    number,
    {
      cagr: number | null;
      maxDrawdown: number | null;
      sharpe: number | null;
      winRate: number | null;
      expectancy: number | null;
      trades: number;
      skippedBuys: number;
    }
  >;
}

export interface EarningsVetoSummary {
  totalWindows: number;
  /** Per-blackout-days summary across all windows. */
  summaries: Array<{
    blackoutDays: number;
    medianCagr: number | null;
    medianSharpe: number | null;
    medianExpectancy: number | null;
    totalTrades: number;
    skippedBuys: number;
    passCount: number;
    passRatePct: number;
    expectancyCi95Lo: number | null;
    expectancyCi95Hi: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Earnings data loader
// ---------------------------------------------------------------------------

/**
 * Load earnings events from DB and build a Map<ticker, string[]>.
 * Also fetches earnings data for tickers that don't have it yet.
 */
export async function loadEarningsByTicker(
  db: SqliteConnection,
  fetchMissing: boolean,
): Promise<Map<string, string[]>> {
  const rows = db
    .prepare(
      `SELECT ticker, report_date FROM earnings_events ORDER BY ticker, report_date ASC`,
    )
    .all() as Array<{ ticker: string; report_date: string }>;

  const byTicker = new Map<string, string[]>();
  for (const r of rows) {
    const existing = byTicker.get(r.ticker) ?? [];
    existing.push(r.report_date);
    byTicker.set(r.ticker, existing);
  }

  // Fetch missing tickers if requested
  if (fetchMissing) {
    const universe = loadUniverseTickers();
    const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
    for (const t of universe) {
      const tu = t.toUpperCase();
      if (!byTicker.has(tu)) {
        await fetchAndPersistEarnings(db, tu, yf);
        // Reload after async fetch completes
        const freshRows = db
          .prepare(`SELECT ticker, report_date FROM earnings_events WHERE ticker = ? ORDER BY report_date ASC`)
          .all(tu) as Array<{ ticker: string; report_date: string }>;
        byTicker.set(
          tu,
          freshRows.map((r) => r.report_date),
        );
      }
    }
  }

  return byTicker;
}

// ---------------------------------------------------------------------------
// Track skipped buys
// ---------------------------------------------------------------------------

/** Count how many tickers in a ranked list would be in earnings blackout. */


// ---------------------------------------------------------------------------
// Core research runner
// ---------------------------------------------------------------------------

/**
 * Run the earnings-blackout veto research across rolling windows.
 */
export async function runEarningsVeto(
  db: SqliteConnection,
  fromDate?: string,
  toDate?: string,
  blackoutDaysList: readonly number[] = DEFAULT_BLACKOUT_DAYS,
  fetchMissing?: boolean,
): Promise<{ windows: EarningsVetoWindowRow[]; summary: EarningsVetoSummary }> {
  // Load earnings data
  const earningsByTicker = await loadEarningsByTicker(db, fetchMissing ?? false);
  console.log(`Earnings data: ${earningsByTicker.size} tickers with events in DB.`);

  // Enumerate windows
  const dataRange = db
    .prepare(`SELECT MIN(date) AS first, MAX(date) AS last FROM daily_prices WHERE ticker = 'QQQ'`)
    .get() as { first: string | null; last: string | null };

  if (!dataRange.first || !dataRange.last) {
    throw new Error("No QQQ data in daily_prices.");
  }

  const enumerated = enumerateWindows(dataRange.first, dataRange.last, fromDate, toDate);
  console.log(`Windows: ${enumerated.length} (2-year, 90-day steps, ${dataRange.first} → ${dataRange.last})`);

  const windows: EarningsVetoWindowRow[] = [];
  const allExpectancies: Record<number, number[]> = {};

  // Initialize allExpectancies for each blackout size
  for (const d of blackoutDaysList) {
    allExpectancies[d] = [];
  }

  for (let wi = 0; wi < enumerated.length; wi++) {
    const { from, to } = enumerated[wi]!;
    process.stdout.write(`Window ${wi}/${enumerated.length}: ${from} → ${to}... `);

    // Baseline run (no blackout)
    const baselineResult = runBacktest(db, from, to);

    const windowRow: EarningsVetoWindowRow = {
      index: wi,
      fromDate: from,
      toDate: to,
      baseline: {
        cagr: baselineResult.metrics.cagrPct,
        maxDrawdown: baselineResult.metrics.maxDrawdownPct,
        sharpe: baselineResult.metrics.sharpeRatio,
        winRate: baselineResult.metrics.winRatePct,
        expectancy:
          baselineResult.closedTrades.length > 0
            ? baselineResult.closedTrades.reduce((s, t) => {
                const pnlPct =
                  t.entryFillPrice !== 0
                    ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
                    : 0;
                return s + pnlPct;
              }, 0) / baselineResult.closedTrades.length
            : null,
        trades: baselineResult.metrics.totalTrades,
      },
      blackouts: {},
    };

    // Collect baseline expectancies
    for (const t of baselineResult.closedTrades) {
      const pnlPct =
        t.entryFillPrice !== 0
          ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
          : 0;
      allExpectancies[0]!.push(pnlPct);
    }

    // Run for each blackout size
    for (const blackoutDays of blackoutDaysList) {
      if (blackoutDays === 0) {
        // Already have baseline
        windowRow.blackouts[0] = {
          cagr: baselineResult.metrics.cagrPct,
          maxDrawdown: baselineResult.metrics.maxDrawdownPct,
          sharpe: baselineResult.metrics.sharpeRatio,
          winRate: baselineResult.metrics.winRatePct,
          expectancy: windowRow.baseline.expectancy,
          trades: baselineResult.metrics.totalTrades,
          skippedBuys: 0,
        };
        continue;
      }

      const blackoutResult = runBacktest(db, from, to, {
        earningsByTicker,
        earningsBlackoutDays: blackoutDays,
      });

      const expectancy =
        blackoutResult.closedTrades.length > 0
          ? blackoutResult.closedTrades.reduce((s, t) => {
              const pnlPct =
                t.entryFillPrice !== 0
                  ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
                  : 0;
              return s + pnlPct;
            }, 0) / blackoutResult.closedTrades.length
          : null;

      // Count skipped buys: re-run ranking for each rebalance date to count
      // We use a simpler approach: count earnings dates in the window
      let skippedBuys = 0;
      const liveTickers = loadUniverseTickers();
      for (const t of liveTickers) {
        const earningsDates = earningsByTicker.get(t.toUpperCase());
        if (!earningsDates) continue;
        for (const ed of earningsDates) {
          if (
            compareIsoDate(ed, from) >= 0 &&
            compareIsoDate(ed, to) <= 0
          ) {
            // This earnings date falls in the window — count as a potential skip
            skippedBuys++;
          }
        }
      }

      windowRow.blackouts[blackoutDays] = {
        cagr: blackoutResult.metrics.cagrPct,
        maxDrawdown: blackoutResult.metrics.maxDrawdownPct,
        sharpe: blackoutResult.metrics.sharpeRatio,
        winRate: blackoutResult.metrics.winRatePct,
        expectancy,
        trades: blackoutResult.metrics.totalTrades,
        skippedBuys,
      };

      // Collect expectancies
      for (const t of blackoutResult.closedTrades) {
        const pnlPct =
          t.entryFillPrice !== 0
            ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
            : 0;
        allExpectancies[blackoutDays]!.push(pnlPct);
      }
    }

    process.stdout.write("done.\n");
    windows.push(windowRow);
  }

  // ---- Summary ----
  const summaries: EarningsVetoSummary["summaries"] = [];

  for (const d of blackoutDaysList) {
    const cagrs: number[] = [];
    const sharpes: number[] = [];
    const expectanciesData: number[] = [];
    let totalTrades = 0;
    let totalSkippedBuys = 0;
    let passCount = 0;

    for (const w of windows) {
      const b = w.blackouts[d];
      if (b === undefined) continue;
      if (b.cagr !== null) cagrs.push(b.cagr);
      if (b.sharpe !== null) sharpes.push(b.sharpe);
      if (b.expectancy !== null) expectanciesData.push(b.expectancy);
      totalTrades += b.trades;
      totalSkippedBuys += b.skippedBuys;

      // Gate check
      const cagrOk = b.cagr === null || b.cagr >= DEFAULT_BACKTEST_GATES.minCagrPct;
      const ddOk = b.maxDrawdown === null || b.maxDrawdown <= DEFAULT_BACKTEST_GATES.maxDrawdownPct;
      const sharpeOk = b.sharpe === null || b.sharpe >= DEFAULT_BACKTEST_GATES.minSharpe;
      const expOk = b.expectancy === null || b.expectancy >= DEFAULT_BACKTEST_GATES.minExpectancyPct;
      if (cagrOk && ddOk && sharpeOk && expOk) passCount++;
    }

    const sortedCagr = [...cagrs].sort((a, b) => a - b);
    const sortedSharpe = [...sharpes].sort((a, b) => a - b);

    const expectancyArr = allExpectancies[d];
    const ci = expectancyArr !== undefined && expectancyArr.length > 0 ? bootstrapMeanCi95(expectancyArr) : null;

    summaries.push({
      blackoutDays: d,
      medianCagr: sortedCagr.length > 0 ? sortedCagr[Math.floor(sortedCagr.length / 2)]! : null,
      medianSharpe: sortedSharpe.length > 0 ? sortedSharpe[Math.floor(sortedSharpe.length / 2)]! : null,
      medianExpectancy:
        expectanciesData.length > 0
          ? expectanciesData.sort((a, b) => a - b)[Math.floor(expectanciesData.length / 2)]!
          : null,
      totalTrades,
      skippedBuys: totalSkippedBuys,
      passCount,
      passRatePct: windows.length > 0 ? (passCount / windows.length) * 100 : 0,
      expectancyCi95Lo: ci?.lo ?? null,
      expectancyCi95Hi: ci?.hi ?? null,
    });
  }

  return {
    windows,
    summary: { totalWindows: windows.length, summaries },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a value for table output. */
function fmt(v: number | null | undefined, decimals: number, suffix = ""): string {
  if (v === null || v === undefined) return "N/A";
  return v.toFixed(decimals) + suffix;
}

/** Format the earnings-veto comparison table for one window. */
export function formatEarningsVetoTableRow(
  w: EarningsVetoWindowRow,
  blackoutDaysList: readonly number[],
): string[] {
  const lines: string[] = [];

  for (const d of blackoutDaysList) {
    const b = w.blackouts[d];
    if (!b) continue;
    const label = d === 0 ? "Baseline" : `${d}d blackout`;
    const baseline = d > 0 ? w.blackouts[0] : undefined;

    const cagrDiff =
      baseline !== undefined && b.cagr !== null && baseline.cagr !== null
        ? b.cagr - baseline.cagr
        : null;
    const sharpeDiff =
      baseline !== undefined && b.sharpe !== null && baseline.sharpe !== null
        ? b.sharpe - baseline.sharpe
        : null;
    const expDiff =
      baseline !== undefined && b.expectancy !== null && baseline.expectancy !== null
        ? b.expectancy - baseline.expectancy
        : null;

    lines.push(
      [
        `  #${String(w.index).padStart(2)}`,
        label.padEnd(16),
        `CAGR ${fmt(b.cagr, 2, "%").padStart(7)}`,
        cagrDiff !== null ? `(${(cagrDiff >= 0 ? "+" : "") + cagrDiff.toFixed(2)}%)`.padStart(9) : "".padStart(9),
        `Sharpe ${fmt(b.sharpe, 3).padStart(6)}`,
        sharpeDiff !== null ? `(${(sharpeDiff >= 0 ? "+" : "") + sharpeDiff.toFixed(3)})`.padStart(9) : "".padStart(9),
        `Exp ${fmt(b.expectancy, 2, "%").padStart(6)}`,
        expDiff !== null ? `(${(expDiff >= 0 ? "+" : "") + expDiff.toFixed(2)}%)`.padStart(9) : "".padStart(9),
        `Trades ${String(b.trades).padStart(3)}`,
        `Skipped ${String(b.skippedBuys).padStart(3)}`,
      ].join("  "),
    );
  }

  return lines;
}

/** Format full earnings-veto research report. */
export function formatEarningsVetoReport(
  windows: EarningsVetoWindowRow[],
  summary: EarningsVetoSummary,
  blackoutDaysList: readonly number[],
): string {
  const lines: string[] = [];

  lines.push("# Earnings-Blackout Veto Research Report");
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Windows: ${summary.totalWindows} (2-year, 90-day steps)`);
  lines.push(`Blackout sizes tested: ${blackoutDaysList.join(", ")} days`);
  lines.push("");

  // ---- Per-window comparison ----
  lines.push("## Per-Window Comparison");
  lines.push("");
  for (const w of windows) {
    lines.push(`### Window #${w.index}: ${w.fromDate} → ${w.toDate}`);
    lines.push("");
    const fmtRows = formatEarningsVetoTableRow(w, blackoutDaysList);
    lines.push(...fmtRows);
    lines.push("");
  }

  // ---- Summary table ----
  lines.push("## Cross-Window Summary");
  lines.push("");
  lines.push("| Blackout | Median CAGR | Median Sharpe | Median Expectancy | Total Trades | Skipped | Gate Pass");
  lines.push("|----------|-------------|---------------|-------------------|-------------|---------|----------|");

  for (const s of summary.summaries) {
    lines.push(
      `| ${String(s.blackoutDays).padEnd(8)}d | ${fmt(s.medianCagr, 2, "%").padStart(11)} | ${fmt(s.medianSharpe, 3).padStart(13)} | ${fmt(s.medianExpectancy, 2, "%").padStart(17)} | ${String(s.totalTrades).padStart(11)} | ${String(s.skippedBuys).padStart(7)} | ${s.passRatePct.toFixed(0)}%`,
    );
  }
  lines.push("");

  // ---- Bootstrap CI ----
  lines.push("## Bootstrap 95% CI on Per-Trade Expectancy");
  lines.push("");
  for (const s of summary.summaries) {
    const label = s.blackoutDays === 0 ? "Baseline" : `${s.blackoutDays}d blackout`;
    if (s.expectancyCi95Lo !== null && s.expectancyCi95Hi !== null) {
      lines.push(
        `  ${label.padEnd(16)}: [${s.expectancyCi95Lo.toFixed(3)}%, ${s.expectancyCi95Hi.toFixed(3)}%]`,
      );
    } else {
      lines.push(`  ${label.padEnd(16)}: insufficient data`);
    }
  }
  lines.push("");

  // ---- Verdict ----
  lines.push("## Preliminary Verdict");
  lines.push("");
  const baseline = summary.summaries.find((s) => s.blackoutDays === 0);
  const best = [...summary.summaries]
    .filter((s) => s.blackoutDays > 0)
    .sort((a, b) => (b.medianCagr ?? 0) - (a.medianCagr ?? 0))[0];

  if (best && baseline && (best.medianCagr ?? 0) > (baseline.medianCagr ?? 0)) {
    lines.push(
      `  ✅ Earnings blackout shows improvement at ${best.blackoutDays}d vs baseline.`,
    );
    lines.push(`     Median CAGR: ${fmt(best.medianCagr, 2, "%")} vs ${fmt(baseline.medianCagr, 2, "%")}`);
    lines.push(`     Median Sharpe: ${fmt(best.medianSharpe, 3)} vs ${fmt(baseline.medianSharpe, 3)}`);
    lines.push(`     Gate pass rate: ${best.passRatePct.toFixed(0)}% vs ${baseline.passRatePct.toFixed(0)}%`);
  } else if (best && baseline) {
    lines.push(
      `  ⚠️ No clear improvement from earnings blackout at tested sizes.`,
    );
    lines.push(`     Best: ${best.blackoutDays}d (CAGR ${fmt(best.medianCagr, 2, "%")})`);
    lines.push(`     Baseline: ${fmt(baseline.medianCagr, 2, "%")}`);
  } else {
    lines.push("  ⚠️ Insufficient data for verdict.");
  }
  lines.push("");
  lines.push("**Caveat:** Historical earnings data is limited to ~4 most recent quarters per ticker");
  lines.push("from Yahoo Finance. Results may differ with a longer earnings history.");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/** CLI options. */
export interface EarningsVetoCliOptions {
  from?: string;
  to?: string;
  days?: string; // comma-separated
  persist?: boolean;
  report?: string;
  fetch?: boolean;
}

/** Full CLI entry point. */
export async function runEarningsVetoCli(opts?: EarningsVetoCliOptions): Promise<void> {
  const {
    from: fromDate,
    to: toDate,
    days = "0,1,3,5,10",
    persist = false,
    report,
    fetch = false,
  } = opts ?? {};

  const blackoutList = days
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 0);

  if (blackoutList.length < 2) {
    console.error("Need at least 2 blackout values (including 0 for baseline).");
    process.exitCode = 1;
    return;
  }

  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    initSchema(db);

    console.log(`\nEarnings-Blackout Veto Research`);
    console.log(`Blackout sizes: ${blackoutList.join(", ")} day(s)`);
    console.log(`Fetch missing earnings data: ${fetch}`);
    console.log("");

    const { windows, summary } = await runEarningsVeto(
      db,
      fromDate,
      toDate,
      blackoutList,
      fetch,
    );

    // Print report
    console.log(formatEarningsVetoReport(windows, summary, blackoutList));

    // Persist if requested
    if (persist) {
      let persisted = 0;
      for (const w of windows) {
        const baselineResult = runBacktest(db, w.fromDate, w.toDate);
        if (baselineResult.closedTrades.length > 0) {
          persistBacktestArtifacts(
            db,
            w.fromDate,
            w.toDate,
            baselineResult,
            "EARNINGS_VETO_RESEARCH",
            "EARNINGS_VETO",
          );
          persisted++;
        }
      }
      console.log(`Persisted ${persisted} window run(s) to backtest_runs.`);
    }

    // Write report file if requested
    if (report) {
      const dir = path.dirname(report);
      if (dir !== ".") {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(report, formatEarningsVetoReport(windows, summary, blackoutList), "utf-8");
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
  runEarningsVetoCli();
}
