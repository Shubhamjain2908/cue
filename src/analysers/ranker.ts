/**
 * Cross-Sectional Momentum Ranker — Jegadeesh-Titman 12-1
 * Pure functions, no I/O, no side effects.
 * Per §6.2 of Cue_Spec_v1.3.md
 */

import type { RankedTicker, RankingConfig } from "../enrichers/momentum-types.js";

/**
 * Computes the 12-1 momentum return for a single ticker's close series.
 * Index 0 = oldest, index [n-1] = most recent (today).
 *
 * Jegadeesh–Titman 12-1 (matches project-spec §3.1):
 * `momentum_12_1_return = (close[today-21] - close[today-252]) / close[today-252]`
 * with `lookbackDays=252`, `skipDays=21`.
 *
 * Returns null if the series is too short to compute.
 */
export function computeMomentumReturn(
  closes: number[],
  lookbackDays: number = 252,
  skipDays: number = 21,
): number | null {
  const n = closes.length;
  // Need at least lookbackDays bars; indices are from tail
  if (n < lookbackDays) {
    return null;
  }

  const priceStart = closes[n - lookbackDays]!; // close[today - 252]
  const priceEnd = closes[n - skipDays]!; // close[today - 21]

  if (priceStart <= 0) {
    return null;
  } // guard against bad data

  return (priceEnd - priceStart) / priceStart;
}

/**
 * Ranks the full universe by 12-1 momentum return as of a given rebalance date.
 *
 * @param priceMap  Map<ticker, closes[]> — closes arrays aligned to as-of date
 *                  (caller is responsible for slicing to the correct date window)
 * @param config    RankingConfig
 * @returns         Array sorted descending by momentumReturn; `rank` runs **1 … N**
 *                  over tickers that produced a finite score (N ≤ universe size if some series are too short).
 */
export function rankUniverse(
  priceMap: Map<string, number[]>,
  config: Pick<RankingConfig, "lookbackDays" | "skipDays" | "topN">,
): RankedTicker[] {
  const scored: { ticker: string; momentumReturn: number }[] = [];

  for (const [ticker, closes] of priceMap) {
    const score = computeMomentumReturn(closes, config.lookbackDays, config.skipDays);
    if (score !== null) {
      scored.push({ ticker, momentumReturn: score });
    }
  }

  scored.sort((a, b) => b.momentumReturn - a.momentumReturn);

  return scored.map((entry, i) => ({
    ...entry,
    rank: i + 1,
  }));
}

/**
 * Computes the updated ATR trailing stop for an open position.
 * Implements the Golden Rule: stop never moves down.
 * Per §6.3 of Cue_Spec_v1.3.md
 */
export function computeTrailingStop(
  currentStop: number,
  highestCloseSinceEntry: number,
  entryPrice: number,
  atrToday: number,
  atrMultiplierBase: number = 4,
  atrMultiplierTight: number = 1.5,
  atrTightenThresholdPct: number = 25.0,
): number {
  const unrealizedPct = ((highestCloseSinceEntry - entryPrice) / entryPrice) * 100;

  const multiplier =
    unrealizedPct >= atrTightenThresholdPct ? atrMultiplierTight : atrMultiplierBase;

  const candidate = highestCloseSinceEntry - multiplier * atrToday;

  // Golden Rule: never move the stop down
  return Math.max(candidate, currentStop);
}
