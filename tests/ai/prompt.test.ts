import { describe, expect, it } from "vitest";

import { buildPrompt } from "../../src/llm/prompt.js";
import type { BuySignalForEnrichmentRow } from "../../src/db/queries.js";
import type { YahooEnrichmentDto } from "../../src/llm/yahooContext.js";

function baseSignal(over: Partial<BuySignalForEnrichmentRow> = {}): BuySignalForEnrichmentRow {
  return {
    id: 1,
    ticker: "TEST",
    date: "2024-06-01",
    signal: "BUY",
    price: 100,
    alerted: 0,
    momentumRank: 2,
    universeRankedCount: 80,
    momentum12_1Return: 0.1234,
    atr14: 2.5,
    initialAtrStop: 90,
    ...over,
  };
}

const baseYahoo = (over: Partial<YahooEnrichmentDto> = {}): YahooEnrichmentDto => ({
  headlines: [{ title: "Co beats estimates", source: "WSJ", publishedAt: "2024-05-30T12:00:00.000Z" }],
  sector: "Technology",
  marketCap: 1e12,
  nextEarningsDate: "2024-08-01",
  financials: {
    trailingPE: 20,
    returnOnEquity: 0.25,
    debtToEquity: 0.5,
    returnOnAssets: null,
    grossMargins: null,
    operatingMargins: null,
    profitMargins: null,
    operatingCashflow: null,
    freeCashflow: null,
    currentRatio: null,
    totalDebt: null,
    totalCash: null,
    priceToSalesTrailing12Months: null,
    forwardPE: null,
    priceToBook: null,
    bookValue: null,
    earningsGrowth: null,
    revenueGrowth: null,
    enterpriseValue: null,
    netIncomeToCommon: null,
  },
  ...over,
});

describe("buildPrompt", () => {
  it("returns system and user strings", () => {
    const prompt = buildPrompt("TEST", baseYahoo(), baseSignal());
    expect(prompt.system).toContain("financial signal analyst");
    expect(prompt.user).toContain("Ticker: TEST");
  });

  it("includes earnings risk clause when earnings within 5 days", () => {
    const prompt = buildPrompt(
      "TEST",
      baseYahoo({ nextEarningsDate: "2024-06-03" }),
      baseSignal({ date: "2024-06-01" }),
    );
    expect(prompt.system).toContain("earnings event risk");
  });
});
