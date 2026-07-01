import { describe, expect, it } from "vitest";

import {
  computeFinancialHealthScore,
  computeProfitability,
  computeCashHealth,
  computeValuation,
  computeTrendConfirm,
  computeCompleteness,
  computeFlags,
  type QualityInputFinancials,
} from "../../src/analysers/signal-quality.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * MU-like (high-quality): strong profitability, healthy cash flows,
 * moderate valuation, strong momentum.
 * Based on probe data: ROE=0.67, ROA=0.35, gross=0.73, op margins=0.80,
 * OCF=$51.4B, FCF=$7.6B, D/E=6.33, current=3.4, P/E=26, P/S=14.5.
 */
const MU_LIKE: QualityInputFinancials = {
  trailingPE: 26.3,
  returnOnEquity: 0.666,
  debtToEquity: 6.33,
  returnOnAssets: 0.349,
  grossMargins: 0.726,
  operatingMargins: 0.804,
  profitMargins: 0.559,
  operatingCashflow: 51_432_001_536,
  freeCashflow: 7_639_499_776,
  currentRatio: 3.425,
  priceToSalesTrailing12Months: 14.55,
  forwardPE: 7.77,
  priceToBook: 18.1,
  earningsGrowth: 13.685,
  revenueGrowth: 3.457,
};

/**
 * INTC-like (lower quality): weak profitability (recent turnaround),
 * high debt, low growth, rich valuation on forward basis.
 */
const INTC_LIKE: QualityInputFinancials = {
  trailingPE: 35.0,
  returnOnEquity: 0.05,
  debtToEquity: 1.5,
  returnOnAssets: 0.02,
  grossMargins: 0.45,
  operatingMargins: 0.08,
  profitMargins: 0.06,
  operatingCashflow: 10_000_000_000,
  freeCashflow: -5_000_000_000,
  currentRatio: 1.2,
  priceToSalesTrailing12Months: 8.0,
  forwardPE: 22.0,
  priceToBook: 2.5,
  earningsGrowth: -0.15,
  revenueGrowth: -0.05,
};

/** Sparse data: most fields null — tests completeness edge case. */
const SPARSE: QualityInputFinancials = {
  trailingPE: null,
  returnOnEquity: null,
  debtToEquity: null,
  returnOnAssets: null,
  grossMargins: null,
  operatingMargins: null,
  profitMargins: null,
  operatingCashflow: null,
  freeCashflow: null,
  currentRatio: null,
  priceToSalesTrailing12Months: 12.0,
  forwardPE: null,
  priceToBook: null,
  earningsGrowth: null,
  revenueGrowth: null,
};

/** Optimal values — ideal company for scoring. */
const PERFECT: QualityInputFinancials = {
  trailingPE: 12,
  returnOnEquity: 0.30,
  debtToEquity: 0.3,
  returnOnAssets: 0.15,
  grossMargins: 0.70,
  operatingMargins: 0.30,
  profitMargins: 0.20,
  operatingCashflow: 100_000_000_000,
  freeCashflow: 50_000_000_000,
  currentRatio: 2.0,
  priceToSalesTrailing12Months: 3.0,
  forwardPE: 10,
  priceToBook: 2.0,
  earningsGrowth: 0.25,
  revenueGrowth: 0.20,
};

// ---------------------------------------------------------------------------
// Profitability
// ---------------------------------------------------------------------------

describe("computeProfitability", () => {
  it("scores MU-like company highly", () => {
    const score = computeProfitability(MU_LIKE);
    expect(score).toBeGreaterThan(0.6);
  });

  it("scores INTC-like company lower", () => {
    const score = computeProfitability(INTC_LIKE);
    // Low ROE (0.05/0.20=0.25), low margins
    expect(score).toBeLessThan(0.5);
  });

  it("returns 0 for all-null input", () => {
    const allNull: QualityInputFinancials = {
      trailingPE: null,
      returnOnEquity: null,
      debtToEquity: null,
      returnOnAssets: null,
      grossMargins: null,
      operatingMargins: null,
      profitMargins: null,
      operatingCashflow: null,
      freeCashflow: null,
      currentRatio: null,
      priceToSalesTrailing12Months: null,
      forwardPE: null,
      priceToBook: null,
      earningsGrowth: null,
      revenueGrowth: null,
    };
    expect(computeProfitability(allNull)).toBe(0);
  });

  it("scores perfect company at or near 1.0", () => {
    expect(computeProfitability(PERFECT)).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// Cash Health
// ---------------------------------------------------------------------------

describe("computeCashHealth", () => {
  it("MU-like has strong cash metrics", () => {
    // MU: OCF positive, FCF positive, high current ratio
    // But D/E of 6.33 penalises
    const score = computeCashHealth(MU_LIKE);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(1);
  });

  it("INTC-like penalised by negative FCF", () => {
    const score = computeCashHealth(INTC_LIKE);
    // Negative FCF → 0 for that component
    expect(score).toBeLessThan(0.6);
  });

  it("returns 0 for all-null input", () => {
    const allNull: QualityInputFinancials = {
      trailingPE: null,
      returnOnEquity: null,
      debtToEquity: null,
      returnOnAssets: null,
      grossMargins: null,
      operatingMargins: null,
      profitMargins: null,
      operatingCashflow: null,
      freeCashflow: null,
      currentRatio: null,
      priceToSalesTrailing12Months: null,
      forwardPE: null,
      priceToBook: null,
      earningsGrowth: null,
      revenueGrowth: null,
    };
    expect(computeCashHealth(allNull)).toBe(0);
  });

  it("perfect gets near-1.0", () => {
    expect(computeCashHealth(PERFECT)).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

describe("computeValuation", () => {
  it("MU's moderate P/E with high P/S scores moderate", () => {
    // MU: P/E=26 → 0.7, P/E forward=7.8 → 1.0, P/S=14.5 → 0.4, P/B=18.1 → 0.1
    // Average ≈ 0.55
    const score = computeValuation(MU_LIKE);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.8);
  });

  it("INTC's valuation scores moderate", () => {
    const score = computeValuation(INTC_LIKE);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns 0.5 neutral default for all-null input", () => {
    const allNull: QualityInputFinancials = {
      trailingPE: null,
      returnOnEquity: null,
      debtToEquity: null,
      returnOnAssets: null,
      grossMargins: null,
      operatingMargins: null,
      profitMargins: null,
      operatingCashflow: null,
      freeCashflow: null,
      currentRatio: null,
      priceToSalesTrailing12Months: null,
      forwardPE: null,
      priceToBook: null,
      earningsGrowth: null,
      revenueGrowth: null,
    };
    expect(computeValuation(allNull)).toBe(0.5);
  });

  it("perfect company scores near-1.0", () => {
    // P/E=12 → 1.0, forward P/E=10 → 1.0, P/S=3 → 1.0, P/B=2 → 1.0 → avg 1.0
    expect(computeValuation(PERFECT)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Trend Confirm
// ---------------------------------------------------------------------------

describe("computeTrendConfirm", () => {
  it("returns 1 when price above SMA200", () => {
    expect(computeTrendConfirm(true)).toBe(1);
  });

  it("returns 0 when price below SMA200", () => {
    expect(computeTrendConfirm(false)).toBe(0);
  });

  it("returns 0 when data not available", () => {
    expect(computeTrendConfirm(null)).toBe(0);
    expect(computeTrendConfirm(undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

describe("computeCompleteness", () => {
  it("MU-like has all 15 fields non-null → 1.0", () => {
    expect(computeCompleteness(MU_LIKE)).toBe(1);
  });

  it("sparse input has 1/15 fields → ~0.067", () => {
    // Only priceToSalesTrailing12Months is non-null
    expect(computeCompleteness(SPARSE)).toBeGreaterThan(0.05);
    expect(computeCompleteness(SPARSE)).toBeLessThan(0.1);
  });

  it("all-null returns 0", () => {
    const allNull: QualityInputFinancials = {
      trailingPE: null,
      returnOnEquity: null,
      debtToEquity: null,
      returnOnAssets: null,
      grossMargins: null,
      operatingMargins: null,
      profitMargins: null,
      operatingCashflow: null,
      freeCashflow: null,
      currentRatio: null,
      priceToSalesTrailing12Months: null,
      forwardPE: null,
      priceToBook: null,
      earningsGrowth: null,
      revenueGrowth: null,
    };
    expect(computeCompleteness(allNull)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe("computeFlags", () => {
  it("flags MU-like for high debt", () => {
    const flags = computeFlags(MU_LIKE);
    expect(flags).toContain("HIGH_DEBT");
  });

  it("flags INTC-like for negative growth and FCF", () => {
    const flags = computeFlags(INTC_LIKE);
    expect(flags).toContain("EARNINGS_SHRINKING");
    expect(flags).toContain("REVENUE_SHRINKING");
    expect(flags).toContain("NEGATIVE_FCF");
  });

  it("produces no flags for perfect company", () => {
    expect(computeFlags(PERFECT)).toEqual([]);
  });

  it("handles all-null gracefully", () => {
    const allNull: QualityInputFinancials = {
      trailingPE: null,
      returnOnEquity: null,
      debtToEquity: null,
      returnOnAssets: null,
      grossMargins: null,
      operatingMargins: null,
      profitMargins: null,
      operatingCashflow: null,
      freeCashflow: null,
      currentRatio: null,
      priceToSalesTrailing12Months: null,
      forwardPE: null,
      priceToBook: null,
      earningsGrowth: null,
      revenueGrowth: null,
    };
    expect(computeFlags(allNull)).toEqual([]);
  });

  it("flags negative margins", () => {
    const negMargins: QualityInputFinancials = {
      ...MU_LIKE,
      operatingMargins: -0.05,
    };
    const flags = computeFlags(negMargins);
    expect(flags).toContain("NEGATIVE_MARGINS");
  });

  it("flags high P/E", () => {
    const highPe: QualityInputFinancials = {
      ...MU_LIKE,
      trailingPE: 50,
    };
    const flags = computeFlags(highPe);
    expect(flags).toContain("HIGH_PE");
  });

  it("flags low liquidity", () => {
    const lowLiq: QualityInputFinancials = {
      ...MU_LIKE,
      currentRatio: 0.8,
    };
    const flags = computeFlags(lowLiq);
    expect(flags).toContain("LOW_LIQUIDITY");
  });
});

// ---------------------------------------------------------------------------
// Integration: computeFinancialHealthScore
// ---------------------------------------------------------------------------

describe("computeFinancialHealthScore", () => {
  it("MU-like scores 5-8 out of 10", () => {
    const result = computeFinancialHealthScore({
      ticker: "MU",
      sector: "Technology",
      financials: MU_LIKE,
      priceAboveSma200: true,
    });
    // MU: strong profitability, decent cash, moderate valuation, strong trend, full data
    expect(result.financialHealthScore).toBeGreaterThanOrEqual(5);
    expect(result.financialHealthScore).toBeLessThanOrEqual(8);
    expect(result.subscores.profitability).toBeGreaterThan(0.5);
    expect(result.valuationMode).toBe("absolute");
    expect(result.sectorPeerCount).toBe(0);
  });

  it("INTC-like scores lower than MU-like", () => {
    const muResult = computeFinancialHealthScore({
      ticker: "MU",
      sector: "Technology",
      financials: MU_LIKE,
      priceAboveSma200: true,
    });
    const intcResult = computeFinancialHealthScore({
      ticker: "INTC",
      sector: "Technology",
      financials: INTC_LIKE,
      priceAboveSma200: false,
    });
    expect(intcResult.financialHealthScore).toBeLessThan(muResult.financialHealthScore);
  });

  it("sparse input scores low due to completeness penalty", () => {
    const result = computeFinancialHealthScore({
      ticker: "SPARSE",
      sector: null,
      financials: SPARSE,
    });
    // Only P/S available → valuation ~0.7, completeness ~0.07, everything else 0
    // 0.25*0 + 0.25*0 + 0.25*0.7 + 0.15*0 + 0.10*0.07 = 0.182 → 1.8/10
    expect(result.financialHealthScore).toBeLessThan(4);
    expect(result.flags).toEqual([]);
  });

  it("perfect company scores 9+", () => {
    const result = computeFinancialHealthScore({
      ticker: "PERFECT",
      sector: "Technology",
      financials: PERFECT,
      priceAboveSma200: true,
    });
    expect(result.financialHealthScore).toBeGreaterThanOrEqual(9);
    expect(result.flags).toEqual([]);
  });

  it("sets computedAt to today's ISO date", () => {
    const result = computeFinancialHealthScore({
      ticker: "TEST",
      sector: null,
      financials: MU_LIKE,
    });
    expect(result.computedAt).toBe(new Date().toISOString().slice(0, 10));
  });

  it("includes all metrics in output", () => {
    const result = computeFinancialHealthScore({
      ticker: "MU",
      sector: "Technology",
      financials: MU_LIKE,
    });
    expect(result.metrics.trailingPE).toBe(26.3);
    expect(result.metrics.priceToSales).toBe(14.55);
    expect(result.metrics.returnOnEquity).toBe(0.666);
    expect(result.metrics.returnOnAssets).toBe(0.349);
    expect(result.metrics.operatingMargins).toBe(0.804);
  });

  it("trendConfirm is 0 when missing and penalises score vs same with trend", () => {
    const withTrend = computeFinancialHealthScore({
      ticker: "MU",
      sector: "Technology",
      financials: MU_LIKE,
      priceAboveSma200: true,
    });
    const withoutTrend = computeFinancialHealthScore({
      ticker: "MU",
      sector: "Technology",
      financials: MU_LIKE,
      priceAboveSma200: false,
    });
    expect(withoutTrend.financialHealthScore).toBeLessThan(withTrend.financialHealthScore);
    // Difference should be at most 0.15 * 10 = 1.5
    expect(withTrend.financialHealthScore - withoutTrend.financialHealthScore).toBeLessThanOrEqual(1.6);
  });
});
