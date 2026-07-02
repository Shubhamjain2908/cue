/**
 * Earnings-blackout veto research — research-only tool (Task 8).
 *
 * Loads earnings data from `earnings_events` table (populated by SEC EDGAR),
 * builds the `earningsByTicker` map, and runs the rolling-window backtest
 * grid for each earnings-blackout window size, comparing metrics vs baseline.
 *
 * Usage: pnpm run cue -- backtest-earnings-veto [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   [--days 0,1,3,5,10] [--report path] [--persist]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import { openCueDb } from "../db/provider.js";
import { initSchema } from "../db/schema.js";
import { compareIsoDate } from "../shared/date-utils.js";
import { runBacktest, persistBacktestArtifacts } from "./runner.js";
import { DEFAULT_BACKTEST_GATES } from "./types.js";
import {
  enumerateWindows,
  bootstrapMeanCi95,
} from "./rolling-gate.js";

type SqliteConnection = Database.Database;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BLACKOUT_DAYS = [0, 1, 3, 5, 10] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EarningsVetoWindowRow {
  index: number;
  fromDate: string;
  toDate: string;
  baseline: {
    cagr: number | null;
    maxDrawdown: number | null;
    sharpe: number | null;
    winRate: number | null;
    expectancy: number | null;
    trades: number;
  };
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

export function loadEarningsByTicker(
  db: SqliteConnection,
): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT ticker, report_date FROM earnings_events
       WHERE source = 'sec_edgar'
       ORDER BY ticker, report_date ASC`,
    )
    .all() as Array<{ ticker: string; report_date: string }>;

  const byTicker = new Map<string, string[]>();
  for (const r of rows) {
    const existing = byTicker.get(r.ticker) ?? [];
    existing.push(r.report_date);
    byTicker.set(r.ticker, existing);
  }

  return byTicker;
}

// ---------------------------------------------------------------------------
// Core research runner
// ---------------------------------------------------------------------------

export function runEarningsVeto(
  db: SqliteConnection,
  fromDate?: string,
  toDate?: string,
  blackoutDaysList: readonly number[] = DEFAULT_BLACKOUT_DAYS,
): { windows: EarningsVetoWindowRow[]; summary: EarningsVetoSummary } {
  const earningsByTicker = loadEarningsByTicker(db);
  const tickerCount = earningsByTicker.size;
  let totalEvents = 0;
  for (const [, dates] of earningsByTicker) totalEvents += dates.length;

  console.log(`Earnings data: ${tickerCount} tickers, ${totalEvents} events (SEC EDGAR)`);

  // Show date range
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const [, dates] of earningsByTicker) {
    if (dates.length > 0) {
      if (earliest === null || dates[0]! < earliest) earliest = dates[0]!;
      if (latest === null || dates[dates.length - 1]! > latest) latest = dates[dates.length - 1]!;
    }
  }
  if (earliest !== null) {
    console.log(`Earnings date range: ${earliest} → ${latest}`);
  }
  console.log("");

  // Enumerate windows
  const dataRange = db
    .prepare(`SELECT MIN(date) AS first, MAX(date) AS last FROM daily_prices WHERE ticker = 'QQQ'`)
    .get() as { first: string | null; last: string | null };
  if (!dataRange.first || !dataRange.last) throw new Error("No QQQ data.");

  const enumerated = enumerateWindows(dataRange.first, dataRange.last, fromDate, toDate);
  console.log(`Windows: ${enumerated.length} (QQQ ${dataRange.first} → ${dataRange.last})`);

  const windows: EarningsVetoWindowRow[] = [];
  const allExpectancies: Record<number, number[]> = {};
  for (const d of blackoutDaysList) allExpectancies[d] = [];

  for (let wi = 0; wi < enumerated.length; wi++) {
    const { from, to } = enumerated[wi]!;
    process.stdout.write(`Window ${wi}/${enumerated.length}: ${from} → ${to}... `);

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
        expectancy: computeExpectancy(baselineResult.closedTrades),
        trades: baselineResult.metrics.totalTrades,
      },
      blackouts: {},
    };

    for (const t of baselineResult.closedTrades) {
      allExpectancies[0]!.push(computeTradePnlPct(t));
    }

    for (const blackoutDays of blackoutDaysList) {
      if (blackoutDays === 0) {
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

      const expectancy = computeExpectancy(blackoutResult.closedTrades);

      let skippedBuys = 0;
      for (const [, dates] of earningsByTicker) {
        for (const ed of dates) {
          if (compareIsoDate(ed, from) >= 0 && compareIsoDate(ed, to) <= 0) {
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

      for (const t of blackoutResult.closedTrades) {
        allExpectancies[blackoutDays]!.push(computeTradePnlPct(t));
      }
    }

    process.stdout.write("done.\n");
    windows.push(windowRow);
  }

  // Summary
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
      if (!b) continue;
      if (b.cagr !== null) cagrs.push(b.cagr);
      if (b.sharpe !== null) sharpes.push(b.sharpe);
      if (b.expectancy !== null) expectanciesData.push(b.expectancy);
      totalTrades += b.trades;
      totalSkippedBuys += b.skippedBuys;

      const cagrOk = b.cagr === null || b.cagr >= DEFAULT_BACKTEST_GATES.minCagrPct;
      const ddOk = b.maxDrawdown === null || b.maxDrawdown <= DEFAULT_BACKTEST_GATES.maxDrawdownPct;
      const sharpeOk = b.sharpe === null || b.sharpe >= DEFAULT_BACKTEST_GATES.minSharpe;
      const expOk = b.expectancy === null || b.expectancy >= DEFAULT_BACKTEST_GATES.minExpectancyPct;
      if (cagrOk && ddOk && sharpeOk && expOk) passCount++;
    }

    const sortedCagr = [...cagrs].sort((a, b) => a - b);
    const sortedSharpe = [...sharpes].sort((a, b) => a - b);
    const expectancyArr = allExpectancies[d];
    const ci = expectancyArr !== undefined && expectancyArr.length > 0
      ? bootstrapMeanCi95(expectancyArr)
      : null;

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

  return { windows, summary: { totalWindows: windows.length, summaries } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeTradePnlPct(t: { entryFillPrice: number; exitFillPrice: number }): number {
  return t.entryFillPrice !== 0
    ? ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100
    : 0;
}

function computeExpectancy(
  trades: Array<{ entryFillPrice: number; exitFillPrice: number }>,
): number | null {
  if (trades.length === 0) return null;
  return trades.reduce((s, t) => s + computeTradePnlPct(t), 0) / trades.length;
}

function fmt(v: number | null | undefined, decimals: number, suffix = ""): string {
  if (v === null || v === undefined) return "N/A";
  return v.toFixed(decimals) + suffix;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatEarningsVetoReport(
  windows: EarningsVetoWindowRow[],
  summary: EarningsVetoSummary,
  blackoutDaysList: readonly number[],
): string {
  const lines: string[] = [];

  lines.push("# Earnings-Blackout Veto Research Report (SEC EDGAR)");
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Windows: ${summary.totalWindows} (2-year, 90-day steps)`);
  lines.push(`Blackout sizes: ${blackoutDaysList.join(", ")} days`);
  lines.push("");

  // Per-window comparison
  lines.push("## Per-Window Comparison");
  lines.push("");
  for (const w of windows) {
    lines.push(`### Window #${w.index}: ${w.fromDate} → ${w.toDate}\n`);
    for (const d of blackoutDaysList) {
      const b = w.blackouts[d];
      if (!b) continue;
      const label = d === 0 ? "Baseline" : `${d}d blackout`;
      const base = d > 0 ? w.blackouts[0] : undefined;

      const cagrDiff = base && b.cagr !== null && base.cagr !== null ? b.cagr - base.cagr : null;
      const sharpeDiff = base && b.sharpe !== null && base.sharpe !== null ? b.sharpe - base.sharpe : null;
      const expDiff = base && b.expectancy !== null && base.expectancy !== null ? b.expectancy - base.expectancy : null;

      const parts = [
        `  ${label.padEnd(12)}`,
        `CAGR ${fmt(b.cagr, 2, "%").padStart(7)}`,
        cagrDiff !== null ? `(${(cagrDiff >= 0 ? "+" : "") + cagrDiff.toFixed(2)}%)`.padStart(9) : "".padStart(9),
        `Sharpe ${fmt(b.sharpe, 3).padStart(6)}`,
        sharpeDiff !== null ? `(${(sharpeDiff >= 0 ? "+" : "") + sharpeDiff.toFixed(3)})`.padStart(9) : "".padStart(9),
        `Exp ${fmt(b.expectancy, 2, "%").padStart(6)}`,
        expDiff !== null ? `(${(expDiff >= 0 ? "+" : "") + expDiff.toFixed(2)}%)`.padStart(9) : "".padStart(9),
        `Trades ${String(b.trades).padStart(3)}`,
        `Skipped ${String(b.skippedBuys).padStart(3)}`,
      ];
      lines.push(parts.join("  "));
    }
    lines.push("");
  }

  // Summary table
  lines.push("## Cross-Window Summary\n");
  lines.push("| Blackout | Median CAGR | Median Sharpe | Median Expectancy | Total Trades | Skipped | Gate Pass |");
  lines.push("|----------|-------------|---------------|-------------------|-------------|---------|-----------|");
  for (const s of summary.summaries) {
    lines.push(
      `| ${String(s.blackoutDays).padEnd(8)}d | ${fmt(s.medianCagr, 2, "%").padStart(11)} | ${fmt(s.medianSharpe, 3).padStart(13)} | ${fmt(s.medianExpectancy, 2, "%").padStart(17)} | ${String(s.totalTrades).padStart(11)} | ${String(s.skippedBuys).padStart(7)} | ${s.passRatePct.toFixed(0)}% |`,
    );
  }
  lines.push("");

  // Bootstrap CI
  lines.push("## Bootstrap 95% CI on Per-Trade Expectancy\n");
  for (const s of summary.summaries) {
    const label = s.blackoutDays === 0 ? "Baseline" : `${s.blackoutDays}d blackout`;
    if (s.expectancyCi95Lo !== null && s.expectancyCi95Hi !== null) {
      lines.push(`  ${label.padEnd(16)}: [${s.expectancyCi95Lo.toFixed(3)}%, ${s.expectancyCi95Hi.toFixed(3)}%]`);
    } else {
      lines.push(`  ${label.padEnd(16)}: insufficient data`);
    }
  }
  lines.push("");

  // Verdict
  lines.push("## Preliminary Verdict\n");
  const baseline = summary.summaries.find((s) => s.blackoutDays === 0);
  const best = [...summary.summaries]
    .filter((s) => s.blackoutDays > 0)
    .sort((a, b) => (b.medianCagr ?? 0) - (a.medianCagr ?? 0))[0];

  if (best && baseline && (best.medianCagr ?? 0) > (baseline.medianCagr ?? 0)) {
    lines.push(`  ✅ Earnings blackout shows improvement at ${best.blackoutDays}d vs baseline.`);
    lines.push(`     Median CAGR: ${fmt(best.medianCagr, 2, "%")} vs ${fmt(baseline.medianCagr, 2, "%")}`);
    lines.push(`     Sharpe: ${fmt(best.medianSharpe, 3)} vs ${fmt(baseline.medianSharpe, 3)}`);
  } else if (best && baseline) {
    lines.push(`  ⚠️ No clear improvement from earnings blackout at tested sizes.`);
    lines.push(`     Best: ${best.blackoutDays}d (CAGR ${fmt(best.medianCagr, 2, "%")})`);
    lines.push(`     Baseline: ${fmt(baseline.medianCagr, 2, "%")}`);
  } else {
    lines.push("  ⚠️ Insufficient data for verdict.");
  }
  lines.push("");
  lines.push("**Data source:** SEC EDGAR submissions API (10-K and 10-Q filing dates).");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export interface EarningsVetoCliOptions {
  from?: string;
  to?: string;
  days?: string;
  persist?: boolean;
  report?: string;
}

export async function runEarningsVetoCli(opts?: EarningsVetoCliOptions): Promise<void> {
  const {
    from: fromDate,
    to: toDate,
    days = "0,1,3,5,10",
    persist = false,
    report,
  } = opts ?? {};

  const blackoutList = days.split(",").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n) && n >= 0);

  if (blackoutList.length < 2) {
    console.error("Need at least 2 blackout values (including 0 for baseline).");
    process.exitCode = 1;
    return;
  }

  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  try {
    initSchema(db);
    console.log(`\nEarnings-Blackout Veto Research (SEC EDGAR)`);
    console.log(`Blackout sizes: ${blackoutList.join(", ")} day(s)\n`);

    const { windows, summary } = runEarningsVeto(db, fromDate, toDate, blackoutList);
    console.log(formatEarningsVetoReport(windows, summary, blackoutList));

    if (persist) {
      let persisted = 0;
      for (const w of windows) {
        const r = runBacktest(db, w.fromDate, w.toDate);
        if (r.closedTrades.length > 0) {
          persistBacktestArtifacts(db, w.fromDate, w.toDate, r, "EARNINGS_VETO_RESEARCH", "EARNINGS_VETO");
          persisted++;
        }
      }
      console.log(`Persisted ${persisted} window run(s).`);
    }

    if (report) {
      const dir = path.dirname(report);
      if (dir !== ".") fs.mkdirSync(dir, { recursive: true });
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

const isMain = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");
if (isMain) runEarningsVetoCli();
