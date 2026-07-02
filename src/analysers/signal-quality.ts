/**
 * Financial Health Score — Phase 1 advisory overlay.
 *
 * Pure scoring functions: no I/O, no DB, no Yahoo fetches.
 * Takes a well-defined input shape and returns a deterministic 0-10 score
 * with sub-scores, flags, and key metrics.
 *
 * Formula (weighted):
 *   0.40 × profitability + 0.20 × cashHealth + 0.30 × valuation
 * + 0.05 × trendConfirm + 0.05 × completeness
 *
 * Sub-scores returning null are excluded and weights are renormalized.
 * Requires ≥2 non-null sub-scores; otherwise financialHealthScore is null.
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

/** Sector median financials for sector-relative scoring (Phase 3 research). */
export interface SectorFinancialMedians {
  /** Median trailing P/E for this sector. */
  trailingPE: number;
  /** Median price-to-sales for this sector. */
  priceToSales: number;
  /** Median price-to-book for this sector. */
  priceToBook: number;
  /** Median debt-to-equity for this sector. */
  debtToEquity: number;
  /** Median return-on-equity for this sector. */
  returnOnEquity: number;
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
  /**
   * Sector median financials for sector-relative scoring (Phase 3).
   * When provided, valuation / cash health / profitability are scored
   * relative to sector peers instead of using absolute thresholds.
   * Defaults to undefined (absolute scoring).
   */
  sectorMedians?: SectorFinancialMedians;
}

export interface QualitySubscores {
  profitability: number | null; // 0-1, null when insufficient data
  cashHealth: number | null; // 0-1, null when insufficient data
  valuation: number | null; // 0-1, null when insufficient data
  trendConfirm: number; // 0-1 (always available, defaults to 0)
  completeness: number; // 0-1 (always available)
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
  /** Aggregate score 0-10 (higher = better). Null when <2 sub-scores available. */
  financialHealthScore: number | null;
  /** Sub-scores by category (0-1 each, null when unavailable). */
  subscores: QualitySubscores;
  /** Key metrics for display / LLM context. */
  metrics: QualityMetrics;
  /** Warning flags, e.g. ["HIGH_DEBT", "RICH_VS_SECTOR"]. */
  flags: string[];
  /** Count of sector peers in the fundamentals cache; 0 when no sector medians provided. */
  sectorPeerCount: number;
  /** "absolute" (no sector medians) or "sector_relative" (scored vs sector peers). */
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
 * When sectorMedians are provided, scores ROE relative to sector median.
 * Otherwise uses absolute thresholds on available fields.
 */
export function computeProfitability(
  financials: QualityInputFinancials,
  sectorMedians?: SectorFinancialMedians,
): number | null {
  const scores: number[] = [];

  // ROE: sector-relative when medians available, else absolute (20%+ = full score)
  if (financials.returnOnEquity !== null) {
    if (sectorMedians && sectorMedians.returnOnEquity > 0) {
      scores.push(scoreRoeRelative(financials.returnOnEquity, sectorMedians.returnOnEquity));
    } else {
      scores.push(normaliseHigherIsBetter(financials.returnOnEquity, 0.2));
    }
  }
  // ROA: 10%+ = full score
  if (financials.returnOnAssets !== null) {
    scores.push(normaliseHigherIsBetter(financials.returnOnAssets, 0.1));
  }
  // Gross margins: 60%+ = full score
  if (financials.grossMargins !== null) {
    scores.push(normaliseHigherIsBetter(financials.grossMargins, 0.6));
  }
  // Operating margins: 20%+ = full score
  if (financials.operatingMargins !== null) {
    scores.push(normaliseHigherIsBetter(financials.operatingMargins, 0.2));
  }
  // Profit margins: 15%+ = full score (bonus signal)
  if (financials.profitMargins !== null) {
    scores.push(normaliseHigherIsBetter(financials.profitMargins, 0.15));
  }

  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

/**
 * Score ROE relative to sector median.
 * Higher ROE than sector peers = better.
 */
function scoreRoeRelative(roe: number, medianRoe: number): number {
  if (roe >= medianRoe * 2.0) return 1;    // > 2× sector median — exceptional
  if (roe >= medianRoe * 1.5) return 0.85;  // 1.5-2× sector median — strong
  if (roe >= medianRoe * 1.0) return 0.7;   // at/below sector median
  if (roe >= medianRoe * 0.5) return 0.4;   // below median but positive
  if (roe > 0) return 0.2;                   // positive but well below median
  return 0;                                   // negative ROE
}

/**
 * Score D/E relative to sector median.
 * Lower leverage than sector peers = better.
 */
function scoreDeRelative(de: number, medianDe: number): number {
  if (de <= medianDe * 0.5) return 1;       // half the sector median — very healthy
  if (de <= medianDe * 1.0) return 0.7;      // at/below sector median
  if (de <= medianDe * 1.5) return 0.4;      // moderately above median
  return 0.1;                                  // significantly above median (high leverage)
}

/**
 * Cash-health sub-score (0-1).
 *
 * Combines operating cashflow, free cashflow, leverage, and liquidity.
 * When sectorMedians are provided, D/E is scored relative to sector median.
 */
export function computeCashHealth(
  financials: QualityInputFinancials,
  sectorMedians?: SectorFinancialMedians,
): number | null {
  const scores: number[] = [];

  // Operating cashflow positive → 1, else 0
  if (financials.operatingCashflow !== null) {
    scores.push(financials.operatingCashflow > 0 ? 1 : 0);
  }
  // Free cashflow positive → 1, else 0
  if (financials.freeCashflow !== null) {
    scores.push(financials.freeCashflow > 0 ? 1 : 0);
  }
  // Debt-to-equity: sector-relative when medians available, else absolute (< 0.5 ideal)
  if (financials.debtToEquity !== null) {
    if (sectorMedians && sectorMedians.debtToEquity > 0) {
      scores.push(scoreDeRelative(financials.debtToEquity, sectorMedians.debtToEquity));
    } else {
      scores.push(normaliseLowerIsBetter(financials.debtToEquity, 0.5));
    }
  }
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

  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

/**
 * Score a single valuation metric relative to a sector median.
 * Used by computeValuation when sector medians are available.
 */
function scoreRelativeToMedian(metric: number, median: number): number {
  if (metric <= median * 0.67) return 1;      // Significantly cheaper than sector
  if (metric <= median * 1.0) return 0.7;      // At or below sector median
  if (metric <= median * 1.5) return 0.4;      // Moderately above median
  return 0.1;                                   // Significantly above median (expensive)
}

/**
 * Score a single valuation metric against absolute thresholds.
 * Used by computeValuation as fallback when no sector medians.
 */
function scoreAbsolute(metric: number): number {
  // Accept any positive value; thresholds scale with metric category
  if (metric < 15) return 1;
  if (metric < 25) return 0.7;
  if (metric < 40) return 0.4;
  return 0.1;
}

/**
 * Valuation sub-score (0-1).
 *
 * When `sectorMedians` are provided, uses sector-relative thresholds:
 * - metric <= median * 0.67 → 1 (significantly cheaper)
 * - metric <= median * 1.0 → 0.7 (at/below median)
 * - metric <= median * 1.5 → 0.4 (moderately above)
 * - metric > median * 1.5 → 0.1 (significantly above)
 *
 * Falls back to absolute thresholds when no medians provided.
 */
export function computeValuation(
  financials: QualityInputFinancials,
  sectorMedians?: SectorFinancialMedians,
): number | null {
  const scores: number[] = [];

  const useRelative = sectorMedians !== undefined;

  // Trailing P/E
  if (financials.trailingPE !== null && financials.trailingPE > 0) {
    scores.push(
      useRelative && sectorMedians!.trailingPE > 0
        ? scoreRelativeToMedian(financials.trailingPE, sectorMedians!.trailingPE)
        : scoreAbsolute(financials.trailingPE),
    );
  }

  // Forward P/E
  if (financials.forwardPE !== null && financials.forwardPE > 0) {
    scores.push(
      useRelative && sectorMedians!.trailingPE > 0
        ? scoreRelativeToMedian(financials.forwardPE, sectorMedians!.trailingPE)
        : scoreAbsolute(financials.forwardPE),
    );
  }

  // Price-to-sales
  if (financials.priceToSalesTrailing12Months !== null && financials.priceToSalesTrailing12Months > 0) {
    const ps = financials.priceToSalesTrailing12Months;
    scores.push(
      useRelative && sectorMedians!.priceToSales > 0
        ? scoreRelativeToMedian(ps, sectorMedians!.priceToSales)
        : scoreAbsolute(ps),
    );
  }

  // Price-to-book
  if (financials.priceToBook !== null && financials.priceToBook > 0) {
    const pb = financials.priceToBook;
    scores.push(
      useRelative && sectorMedians!.priceToBook > 0
        ? scoreRelativeToMedian(pb, sectorMedians!.priceToBook)
        : scoreAbsolute(pb),
    );
  }

  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
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

/**
 * Weights for the Financial Health Score.
 *
 * Adjusted after rolling-window re-gate (Phase 5):
 * - profitability ↑ (0.40): ROE has good data coverage; best predictor of quality
 * - cashHealth (0.20): unchanged; D/E + FCF are informative
 * - valuation ↑ (0.30): P/E, P/S, P/B all available with sector-relative scoring
 * - trendConfirm ↓ (0.05): mechanically ~1 for momentum candidates (above SMA200 by construction)
 * - completeness (0.05): unchanged; mostly metadata
 */
const WEIGHTS = {
  profitability: 0.40,
  cashHealth: 0.20,
  valuation: 0.30,
  trendConfirm: 0.05,
  completeness: 0.05,
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
  const profitability = computeProfitability(input.financials, input.sectorMedians);
  const cashHealth = computeCashHealth(input.financials, input.sectorMedians);
  const valuation = computeValuation(input.financials, input.sectorMedians);
  const trendConfirm = computeTrendConfirm(input.priceAboveSma200);
  const completeness = computeCompleteness(input.financials);

  // Collect non-null sub-scores with their weights
  const pairs: Array<{ score: number; weight: number }> = [];

  if (profitability !== null) pairs.push({ score: profitability, weight: WEIGHTS.profitability });
  if (cashHealth !== null) pairs.push({ score: cashHealth, weight: WEIGHTS.cashHealth });
  if (valuation !== null) pairs.push({ score: valuation, weight: WEIGHTS.valuation });
  // trendConfirm is always 0-1 (never null)
  pairs.push({ score: trendConfirm, weight: WEIGHTS.trendConfirm });
  // completeness is always 0-1 (never null)
  pairs.push({ score: completeness, weight: WEIGHTS.completeness });

  const totalWeight = pairs.reduce((s, p) => s + p.weight, 0);

  // Require ≥2 non-null sub-scores (trendConfirm + completeness always present)
  const nonNullCount = [profitability, cashHealth, valuation].filter((s) => s !== null).length;
  const flags = computeFlags(input.financials);

  if (nonNullCount < 2 || totalWeight === 0) {
    return {
      financialHealthScore: null,
      subscores: { profitability, cashHealth, valuation, trendConfirm, completeness },
      metrics: extractQualityMetrics(input.financials),
      flags,
      sectorPeerCount: 0,
      valuationMode: "absolute",
      computedAt: new Date().toISOString().slice(0, 10),
    };
  }

  const weightedScore = pairs.reduce((sum, p) => sum + p.score * (p.weight / totalWeight), 0);

  const valuationMode = input.sectorMedians !== undefined ? "sector_relative" : "absolute";
  // sectorPeerCount is populated from medians metadata upstream, not here; keep 0

  return {
    financialHealthScore: clamp01(weightedScore) * 10,
    subscores: { profitability, cashHealth, valuation, trendConfirm, completeness },
    metrics: extractQualityMetrics(input.financials),
    flags,
    sectorPeerCount: 0,
    valuationMode,
    computedAt: new Date().toISOString().slice(0, 10),
  };
}
