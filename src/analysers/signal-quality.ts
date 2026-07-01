/**
 * Financial Health Score — Phase 1 advisory overlay.
 *
 * Pure scoring functions: no I/O, no DB, no Yahoo fetches.
 * Takes a well-defined input shape and returns a deterministic 0-10 score
 * with sub-scores, flags, and key metrics.
 *
 * Formula (weighted):
 *   0.25 × profitability + 0.25 × cashHealth + 0.25 × valuation
 * + 0.15 × trendConfirm + 0.10 × completeness
 *
 * All sub-scores are normalised 0-1. The final score is 0-10.
 *
 * References:
 *   - docs/plan-review-and-data-audit.md §6 (score formula)
 *   - Verdict §"Score formula — adopt review §6 with one rename"
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityInputFinancials {
  trailingPE: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
  returnOnAssets: number | null;
  grossMargins: number | null;
  operatingMargins: number | null;
  profitMargins: number | null;
  operatingCashflow: number | null;
  freeCashflow: number | null;
  currentRatio: number | null;
  priceToSalesTrailing12Months: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  earningsGrowth: number | null;
  revenueGrowth: number | null;
}

export interface QualityInput {
  /** Financial metrics from Yahoo (pre-computed modules). */
  financials: QualityInputFinancials;
  /** GICS sector string (e.g. "Technology"). Null for unknown. */
  sector: string | null;
  /** Ticker symbol (for debug / flag context). */
  ticker: string;
  /**
   * Whether the latest close is above the 200-day SMA.
   * Null when not yet computed (e.g. insufficient price history).
   * Phase 1: defaults to null if omitted.
   */
  priceAboveSma200?: boolean | null;
}

export interface QualitySubscores {
  profitability: number; // 0-1
  cashHealth: number; // 0-1
  valuation: number; // 0-1
  trendConfirm: number; // 0-1
  completeness: number; // 0-1
}

export interface QualityMetrics {
  trailingPE: number | null;
  priceToSales: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  earningsGrowth: number | null;
  revenueGrowth: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  operatingMargins: number | null;
}

export interface QualityResult {
  /** Aggregate score 0-10 (higher = better). */
  financialHealthScore: number;
  /** Sub-scores by category (0-1 each). */
  subscores: QualitySubscores;
  /** Key metrics for display / LLM context. */
  metrics: QualityMetrics;
  /** Warning flags, e.g. ["HIGH_DEBT", "RICH_VS_SECTOR"]. */
  flags: string[];
  /**
   * Count of sector peers in the fundamentals cache.
   * 0 in Phase 1 (no sector-relative scoring yet).
   */
  sectorPeerCount: number;
  /** "absolute" (Phase 1) or "sector_relative" (Phase 2+). */
  valuationMode: "absolute" | "sector_relative";
  /** ISO date string when this was computed. */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Clamp a value between 0 and 1. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Normalise a ratio where higher is better, capping at `capAt` (e.g. 0.25 = 25%). */
function normaliseHigherIsBetter(value: number | null, capAt: number): number {
  if (value === null || value < 0) return 0;
  return clamp01(value / capAt);
}

/** Normalise a debt-like ratio where lower is better. */
function normaliseLowerIsBetter(value: number | null, floorAt: number): number {
  if (value === null || value < 0) return 0;
  // At or below floor → perfect score; above → decays linearly
  if (value <= floorAt) return 1;
  // Decay: score = max(0, 1 - (value - floorAt) / floorAt)
  return clamp01(1 - (value - floorAt) / floorAt);
}

// ---------------------------------------------------------------------------
// Sub-score calculators
// ---------------------------------------------------------------------------

/**
 * Profitability sub-score (0-1).
 *
 * Averages normalised ROE, ROA, gross margins, and operating margins.
 * Fewer available fields → lower weight per field but still tries to score.
 */
export function computeProfitability(financials: QualityInputFinancials): number {
  const scores: number[] = [];

  // ROE: 20%+ = full score
  scores.push(normaliseHigherIsBetter(financials.returnOnEquity, 0.2));
  // ROA: 10%+ = full score
  scores.push(normaliseHigherIsBetter(financials.returnOnAssets, 0.1));
  // Gross margins: 60%+ = full score
  scores.push(normaliseHigherIsBetter(financials.grossMargins, 0.6));
  // Operating margins: 20%+ = full score
  scores.push(normaliseHigherIsBetter(financials.operatingMargins, 0.2));
  // Profit margins: 15%+ = full score (bonus signal)
  scores.push(normaliseHigherIsBetter(financials.profitMargins, 0.15));

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Cash-health sub-score (0-1).
 *
 * Combines operating cashflow, free cashflow, leverage, and liquidity.
 */
export function computeCashHealth(financials: QualityInputFinancials): number {
  const scores: number[] = [];

  // Operating cashflow positive → 1, else 0
  if (financials.operatingCashflow !== null) {
    scores.push(financials.operatingCashflow > 0 ? 1 : 0);
  }
  // Free cashflow positive → 1, else 0
  if (financials.freeCashflow !== null) {
    scores.push(financials.freeCashflow > 0 ? 1 : 0);
  }
  // Debt-to-equity: < 0.5 ideal, decays after 1.0
  scores.push(normaliseLowerIsBetter(financials.debtToEquity, 0.5));
  // Current ratio: 1.5-3 ideal; penalise below 1 or above 5
  if (financials.currentRatio !== null) {
    const cr = financials.currentRatio;
    if (cr >= 1.5 && cr <= 3) {
      scores.push(1);
    } else if (cr >= 1 && cr <= 5) {
      scores.push(0.7);
    } else if (cr >= 0.5 && cr <= 10) {
      scores.push(0.3);
    } else {
      scores.push(0);
    }
  }

  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

/**
 * Valuation sub-score (0-1) — absolute thresholds (Phase 1).
 *
 * Uses trailing P/E, forward P/E, P/S, and P/B against fixed thresholds.
 * Sector-relative mode will be added in Phase 2 when sector-peer cache fills.
 */
export function computeValuation(financials: QualityInputFinancials): number {
  const scores: number[] = [];

  // Trailing P/E: < 15 ideal, < 25 ok, < 40 stretched
  if (financials.trailingPE !== null && financials.trailingPE > 0) {
    const pe = financials.trailingPE;
    if (pe < 15) scores.push(1);
    else if (pe < 25) scores.push(0.7);
    else if (pe < 40) scores.push(0.4);
    else scores.push(0.1);
  }

  // Forward P/E: < 15 ideal, < 25 ok
  if (financials.forwardPE !== null && financials.forwardPE > 0) {
    const fpe = financials.forwardPE;
    if (fpe < 15) scores.push(1);
    else if (fpe < 25) scores.push(0.7);
    else if (fpe < 40) scores.push(0.4);
    else scores.push(0.1);
  }

  // Price-to-sales: < 5 ideal, < 10 ok, < 20 stretched
  if (financials.priceToSalesTrailing12Months !== null && financials.priceToSalesTrailing12Months > 0) {
    const ps = financials.priceToSalesTrailing12Months;
    if (ps < 5) scores.push(1);
    else if (ps < 10) scores.push(0.7);
    else if (ps < 20) scores.push(0.4);
    else scores.push(0.1);
  }

  // Price-to-book: < 3 ideal, < 5 ok, < 10 stretched
  if (financials.priceToBook !== null && financials.priceToBook > 0) {
    const pb = financials.priceToBook;
    if (pb < 3) scores.push(1);
    else if (pb < 5) scores.push(0.7);
    else if (pb < 10) scores.push(0.4);
    else scores.push(0.1);
  }

  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5; // neutral default
}

/**
 * Trend-confirm sub-score (0-1).
 *
 * Simple binary: price above 200-day SMA → 1, else 0.
 * Returns 0 when data not available.
 */
export function computeTrendConfirm(priceAboveSma200: boolean | null | undefined): number {
  return priceAboveSma200 === true ? 1 : 0;
}

/**
 * Completeness sub-score (0-1).
 *
 * Fraction of expected fields that are non-null.
 */
export function computeCompleteness(financials: QualityInputFinancials): number {
  const fields: Array<number | null> = [
    financials.trailingPE,
    financials.returnOnEquity,
    financials.debtToEquity,
    financials.returnOnAssets,
    financials.grossMargins,
    financials.operatingMargins,
    financials.profitMargins,
    financials.operatingCashflow,
    financials.freeCashflow,
    financials.currentRatio,
    financials.priceToSalesTrailing12Months,
    financials.forwardPE,
    financials.priceToBook,
    financials.earningsGrowth,
    financials.revenueGrowth,
  ];

  const nonNull = fields.filter((f) => f !== null).length;
  return fields.length > 0 ? nonNull / fields.length : 0;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Compute warning flags based on raw financial data.
 * Phase 1: no sector-relative flags yet (sectorPeerCount < 5 → skip).
 */
export function computeFlags(financials: QualityInputFinancials): string[] {
  const flags: string[] = [];

  // High debt
  if (financials.debtToEquity !== null && financials.debtToEquity > 2) {
    flags.push("HIGH_DEBT");
  }

  // Low liquidity
  if (financials.currentRatio !== null && financials.currentRatio < 1) {
    flags.push("LOW_LIQUIDITY");
  }

  // Negative earnings growth
  if (financials.earningsGrowth !== null && financials.earningsGrowth < 0) {
    flags.push("EARNINGS_SHRINKING");
  }

  // Negative revenue growth
  if (financials.revenueGrowth !== null && financials.revenueGrowth < 0) {
    flags.push("REVENUE_SHRINKING");
  }

  // High P/E (absolute, not sector-relative yet)
  if (financials.trailingPE !== null && financials.trailingPE > 40) {
    flags.push("HIGH_PE");
  }

  // Low margins (operating)
  if (financials.operatingMargins !== null && financials.operatingMargins < 0) {
    flags.push("NEGATIVE_MARGINS");
  }

  // Negative FCF
  if (financials.freeCashflow !== null && financials.freeCashflow <= 0) {
    flags.push("NEGATIVE_FCF");
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Metrics extractor
// ---------------------------------------------------------------------------

/**
 * Extract key metrics for display / LLM context.
 * Always returns a full shape with null for missing fields.
 */
export function extractQualityMetrics(financials: QualityInputFinancials): QualityMetrics {
  return {
    trailingPE: financials.trailingPE,
    priceToSales: financials.priceToSalesTrailing12Months,
    returnOnEquity: financials.returnOnEquity,
    returnOnAssets: financials.returnOnAssets,
    debtToEquity: financials.debtToEquity,
    currentRatio: financials.currentRatio,
    earningsGrowth: financials.earningsGrowth,
    revenueGrowth: financials.revenueGrowth,
    forwardPE: financials.forwardPE,
    priceToBook: financials.priceToBook,
    operatingMargins: financials.operatingMargins,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const WEIGHTS = {
  profitability: 0.25,
  cashHealth: 0.25,
  valuation: 0.25,
  trendConfirm: 0.15,
  completeness: 0.10,
} as const;

/**
 * Compute the full Financial Health Score for a single ticker.
 *
 * Pure: no I/O, no caching, no DB access.
 *
 * @example
 * ```ts
 * const result = computeFinancialHealthScore({
 *   ticker: "MU",
 *   sector: "Technology",
 *   financials: { trailingPE: 26, returnOnEquity: 0.66, debtToEquity: 6.33, ... },
 *   priceAboveSma200: true,
 * });
 * // result.financialHealthScore → 7.2
 * // result.subscores.profitability → 0.85
 * ```
 */
export function computeFinancialHealthScore(input: QualityInput): QualityResult {
  const profitability = computeProfitability(input.financials);
  const cashHealth = computeCashHealth(input.financials);
  const valuation = computeValuation(input.financials);
  const trendConfirm = computeTrendConfirm(input.priceAboveSma200);
  const completeness = computeCompleteness(input.financials);

  const weightedScore =
    profitability * WEIGHTS.profitability +
    cashHealth * WEIGHTS.cashHealth +
    valuation * WEIGHTS.valuation +
    trendConfirm * WEIGHTS.trendConfirm +
    completeness * WEIGHTS.completeness;

  const flags = computeFlags(input.financials);

  return {
    financialHealthScore: clamp01(weightedScore) * 10,
    subscores: { profitability, cashHealth, valuation, trendConfirm, completeness },
    metrics: extractQualityMetrics(input.financials),
    flags,
    sectorPeerCount: 0, // Phase 2+
    valuationMode: "absolute", // Phase 1: no sector peers
    computedAt: new Date().toISOString().slice(0, 10),
  };
}
