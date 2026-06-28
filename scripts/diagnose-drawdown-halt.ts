/**
 * One-off: verify drawdown-halt overlay fired relative to MaxDD window (run id=86 sanity check).
 * Usage: pnpm tsx scripts/diagnose-drawdown-halt.ts
 */

import { isoWeekdayMon1ToFri5 } from "../src/shared/date-utils.js";
import { computeDrawdownHaltMask } from "../src/backtest/drawdown-halt.js";
import { findMaxDrawdownWindow, maxDrawdownPct } from "../src/backtest/metrics.js";
import { runBacktest } from "../src/backtest/runner.js";
import { getConfig } from "../src/config/index.js";
import { openCueDbReadonly } from "../src/db/provider.js";
import type { DrawdownHaltSessionTrace, EquityPoint } from "../src/backtest/types.js";

const EXTENDED_FROM = "2022-01-01";
const EXTENDED_TO = "2025-12-31";
const HALT_PCT = 10;
const RESUME_PCT = 5;
const CONTEXT_DAYS = 30;

function tradingDaysBetween(sortedDates: readonly string[], from: string, to: string): number {
  let count = 0;
  for (const d of sortedDates) {
    if (d < from) {
      continue;
    }
    if (d > to) {
      break;
    }
    count++;
  }
  return count;
}

function datesNear(sortedDates: readonly string[], center: string, radius: number): Set<string> {
  const idx = sortedDates.indexOf(center);
  if (idx < 0) {
    return new Set([center]);
  }
  const out = new Set<string>();
  for (let i = Math.max(0, idx - radius); i <= Math.min(sortedDates.length - 1, idx + radius); i++) {
    out.add(sortedDates[i]!);
  }
  return out;
}

function fridaysInRange(trace: readonly DrawdownHaltSessionTrace[]): DrawdownHaltSessionTrace[] {
  return trace.filter((t) => isoWeekdayMon1ToFri5(t.date) === 5);
}

function summarizeTrace(label: string, trace: readonly DrawdownHaltSessionTrace[], points: readonly EquityPoint[]): void {
  const ddWindow = findMaxDrawdownWindow(points);
  const maxDd = maxDrawdownPct(points.map((p) => p.equityUsd));
  const haltedSessions = trace.filter((t) => t.halted);
  const haltedFridays = fridaysInRange(trace).filter((t) => t.halted);

  console.log(`\n=== ${label} ===`);
  console.log(`MaxDD (EOD equity): ${maxDd?.toFixed(4)}%`);
  if (ddWindow) {
    console.log(
      `MaxDD window: peak ${ddWindow.peakDate} ($${ddWindow.peakNav.toFixed(2)}) → trough ${ddWindow.troughDate} ($${ddWindow.troughNav.toFixed(2)}) = ${ddWindow.drawdownPct.toFixed(4)}%`,
    );
  }
  console.log(`Halt sessions (total): ${haltedSessions.length} / ${trace.length}`);
  console.log(`Halt Fridays (BUY gate): ${haltedFridays.length} / ${fridaysInRange(trace).length}`);

  if (ddWindow) {
    const sortedDates = trace.map((t) => t.date);
    const nearPeak = datesNear(sortedDates, ddWindow.peakDate, CONTEXT_DAYS);
    const nearTrough = datesNear(sortedDates, ddWindow.troughDate, CONTEXT_DAYS);
    const nearWindow = new Set([...nearPeak, ...nearTrough]);

    const haltedNearWindow = haltedSessions.filter((t) => nearWindow.has(t.date));
    const haltedAtTrough = trace.find((t) => t.date === ddWindow.troughDate);
    const haltedAtPeak = trace.find((t) => t.date === ddWindow.peakDate);

    console.log(`\nNear MaxDD window (±${CONTEXT_DAYS} sessions around peak/trough):`);
    console.log(`  Halted sessions in window: ${haltedNearWindow.length}`);
    console.log(
      `  At peak (${ddWindow.peakDate}): halted=${haltedAtPeak?.halted ?? "n/a"} dd@check=${haltedAtPeak?.drawdownPctAtCheck.toFixed(2) ?? "n/a"}%`,
    );
    console.log(
      `  At trough (${ddWindow.troughDate}): halted=${haltedAtTrough?.halted ?? "n/a"} dd@check=${haltedAtTrough?.drawdownPctAtCheck.toFixed(2) ?? "n/a"}%`,
    );

    if (haltedNearWindow.length > 0) {
      console.log("  Halted dates near window:");
      for (const t of haltedNearWindow) {
        const fri = isoWeekdayMon1ToFri5(t.date) === 5 ? " FRI" : "";
        console.log(
          `    ${t.date}${fri}: dd@check=${t.drawdownPctAtCheck.toFixed(2)}% nav@check=$${t.navAtHaltCheck.toFixed(2)} eod=$${t.eodNav.toFixed(2)}`,
        );
      }
    }
  }

  const maskFromEod = computeDrawdownHaltMask(
    points.map((p) => ({ date: p.date, nav: p.equityUsd })),
    HALT_PCT,
    RESUME_PCT,
  );
  const haltedEodMask = maskFromEod.filter((m) => m.halted);
  console.log(`\nPost-hoc halt mask on EOD NAV (sanity — not the BUY gate series): ${haltedEodMask.length} sessions`);
  if (haltedEodMask.length > 0 && haltedEodMask.length <= 12) {
    for (const m of haltedEodMask) {
      console.log(`    ${m.date}: dd=${m.drawdownPct.toFixed(2)}%`);
    }
  }
}

function diffEquityCurves(
  baseline: readonly EquityPoint[],
  overlay: readonly EquityPoint[],
): { firstDivergence: string | null; maxAbsDiff: number; maxDiffDate: string | null } {
  const byDate = new Map(baseline.map((p) => [p.date, p.equityUsd]));
  let firstDivergence: string | null = null;
  let maxAbsDiff = 0;
  let maxDiffDate: string | null = null;
  for (const p of overlay) {
    const b = byDate.get(p.date);
    if (b === undefined) {
      continue;
    }
    const diff = Math.abs(p.equityUsd - b);
    if (diff > 1e-6 && firstDivergence === null) {
      firstDivergence = p.date;
    }
    if (diff > maxAbsDiff) {
      maxAbsDiff = diff;
      maxDiffDate = p.date;
    }
  }
  return { firstDivergence, maxAbsDiff, maxDiffDate };
}

function main(): void {
  const db = openCueDbReadonly(getConfig().DB_PATH);
  try {
    const baseline = runBacktest(db, EXTENDED_FROM, EXTENDED_TO);
    const trace: DrawdownHaltSessionTrace[] = [];
    const halted = runBacktest(db, EXTENDED_FROM, EXTENDED_TO, {
      drawdownHalt: { haltThresholdPct: HALT_PCT, resumeThresholdPct: RESUME_PCT },
      sessionTrace: trace,
    });

    console.log("Drawdown-halt diagnostic — extended window, halt=10% (backtest_runs id=86)");
    console.log(`Window: ${EXTENDED_FROM} → ${EXTENDED_TO}`);

    summarizeTrace("Baseline (no halt)", [], baseline.equityPoints);
    summarizeTrace("Halt=10% overlay (id=86 path)", trace, halted.equityPoints);

    const diff = diffEquityCurves(baseline.equityPoints, halted.equityPoints);
    console.log("\n=== Baseline vs halt=10% equity divergence ===");
    console.log(`First NAV divergence: ${diff.firstDivergence ?? "none"}`);
    console.log(
      `Max |ΔNAV|: $${diff.maxAbsDiff.toFixed(2)}${diff.maxDiffDate ? ` on ${diff.maxDiffDate}` : ""}`,
    );
    console.log(`Trades: baseline=${baseline.metrics.totalTrades} halt=${halted.metrics.totalTrades}`);
    console.log(
      `Metrics: baseline Sharpe=${baseline.metrics.sharpeRatio?.toFixed(3)} halt=${halted.metrics.sharpeRatio?.toFixed(3)}`,
    );
    console.log(
      `         baseline MaxDD=${baseline.metrics.maxDrawdownPct?.toFixed(4)}% halt=${halted.metrics.maxDrawdownPct?.toFixed(4)}%`,
    );

    const baseWindow = findMaxDrawdownWindow(baseline.equityPoints);
    const haltWindow = findMaxDrawdownWindow(halted.equityPoints);
    if (baseWindow && haltWindow) {
      const sameWindow =
        baseWindow.peakDate === haltWindow.peakDate &&
        baseWindow.troughDate === haltWindow.troughDate;
      console.log(`\nMaxDD window identical across runs: ${sameWindow ? "YES" : "NO"}`);
      if (!sameWindow) {
        console.log(
          `  Baseline: ${baseWindow.peakDate} → ${baseWindow.troughDate} (${baseWindow.drawdownPct.toFixed(4)}%)`,
        );
        console.log(
          `  Halt:     ${haltWindow.peakDate} → ${haltWindow.troughDate} (${haltWindow.drawdownPct.toFixed(4)}%)`,
        );
      }
    }

    const haltedFridays = fridaysInRange(trace).filter((t) => t.halted);
    if (haltedFridays.length > 0) {
      console.log("\nAll halted Fridays (BUY suppression active):");
      for (const t of haltedFridays) {
        console.log(
          `  ${t.date}: dd@check=${t.drawdownPctAtCheck.toFixed(2)}% nav@check=$${t.navAtHaltCheck.toFixed(2)}`,
        );
      }
    }

    const ddWindow = findMaxDrawdownWindow(baseline.equityPoints);
    if (ddWindow && trace.length > 0) {
      const sortedDates = trace.map((t) => t.date);
      const daysPeakToTrough = tradingDaysBetween(
        sortedDates,
        ddWindow.peakDate,
        ddWindow.troughDate,
      );
      const haltBeforeTrough = trace.some(
        (t) => t.halted && t.date < ddWindow.troughDate,
      );
      const haltedFridaysBeforeTrough = fridaysInRange(trace).filter(
        (t) => t.halted && t.date < ddWindow.troughDate,
      );
      const navMismatches = trace.filter(
        (t) => Math.abs(t.navAtHaltCheck - t.eodNav) >= 0.01,
      );
      const troughTrace = trace.find((t) => t.date === ddWindow.troughDate);
      console.log("\n=== Conclusion hint ===");
      console.log(`Trading days peak→trough: ${daysPeakToTrough}`);
      console.log(`Halt active before trough session: ${haltBeforeTrough}`);
      console.log(`Halted Fridays before trough: ${haltedFridaysBeforeTrough.length}`);
      console.log(
        `navAtHaltCheck vs eodNav mismatches: ${navMismatches.length} (MaxDD trough match: ${
          troughTrace && Math.abs(troughTrace.navAtHaltCheck - troughTrace.eodNav) < 0.01
            ? "yes"
            : "no"
        })`,
      );
      if (navMismatches.length === 1) {
        console.log(`  Sole mismatch: ${navMismatches[0]!.date} (forced-close session)`);
      }
      if (!haltBeforeTrough && (navMismatches.length <= 1)) {
        console.log(
          "→ (1) Legitimate: halt engages at/after the trough (peak is day-1 cash); BUY gate cannot retroactively alter MaxDD.",
        );
      } else if (haltBeforeTrough && navMismatches.length <= 1) {
        console.log(
          "→ Halt fired before trough but MaxDD unchanged — overlay bound too late (Friday-only) or wrong peak anchor.",
        );
      } else if (navMismatches.length > 1) {
        console.log("→ (2) Suspect: halt-check NAV diverges from EOD equity on multiple sessions.");
      }
    }
  } finally {
    db.close();
  }
}

main();
