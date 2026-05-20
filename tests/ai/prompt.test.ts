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
  financials: { trailingPE: 20, returnOnEquity: 0.25, debtToEquity: 0.5 },
  ...over,
});

describe("buildPrompt", () => {
  it("returns system then user messages", () => {
    const msgs = buildPrompt("TEST", baseYahoo(), baseSignal());
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("displays 12-1 return as percent (raw fraction × 100)", () => {
    const user = buildPrompt("TEST", baseYahoo(), baseSignal({ momentum12_1Return: 0.1 }))[1]!.content;
    expect(user).toContain("10.00%");
  });

  it("includes confidence rubric in system prompt", () => {
    const sys = buildPrompt("TEST", baseYahoo(), baseSignal())[0]!.content;
    expect(sys).toContain("HIGH:");
    expect(sys).toContain("MEDIUM:");
    expect(sys).toContain("LOW:");
  });

  it("adds earnings risk clause when next earnings within 5 calendar days of signal date", () => {
    const sys = buildPrompt("TEST", baseYahoo({ nextEarningsDate: "2024-06-04" }), baseSignal({ date: "2024-06-01" }))[0]!
      .content;
    expect(sys).toContain("MUST explicitly acknowledge earnings event risk");
  });

  it("omits earnings risk clause when earnings far from signal date", () => {
    const sys = buildPrompt("TEST", baseYahoo({ nextEarningsDate: "2024-12-31" }), baseSignal({ date: "2024-06-01" }))[0]!
      .content;
    expect(sys).not.toContain("MUST explicitly acknowledge earnings event risk");
  });
});
