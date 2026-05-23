import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEnrichment } from "../../src/llm/enricher.js";
import { EnrichmentResultSchema, type EnrichmentResult } from "../../src/llm/enrichment.js";
import type { LlmProvider } from "../../src/llm/types.js";
import { resetConfigCache } from "../../src/config/index.js";
import { insertSignal } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

const saved = { ...process.env };

function envForEnrich(): void {
  resetConfigCache();
  Object.assign(process.env, saved);
  process.env.POLYGON_API_KEY = "p";
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "c";
  process.env.LLM_PROVIDER = "mock";
  process.env.LLM_MAX_TOKENS = "600";
}

const valid: EnrichmentResult = {
  sentiment: "NEUTRAL",
  rationale: "This rationale is long enough for schema validation rules here.",
  earningsDate: null,
  sector: "Technology",
  confidence: "LOW",
};

describe("runEnrichment", () => {
  beforeEach(() => {
    envForEnrich();
  });

  afterEach(() => {
    Object.assign(process.env, saved);
    resetConfigCache();
  });

  it("calls generateJson with enrichment schema and persists", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    insertSignal(db, {
      ticker: "ZZZ",
      date: "2024-06-10",
      signal: "BUY",
      price: 50,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.05,
      atr14: 1,
      initialAtrStop: 45,
    });
    const { id } = db.prepare(`SELECT id FROM signals WHERE ticker = 'ZZZ'`).get() as { id: number };

    const generateJson = vi.fn().mockResolvedValue({
      data: valid,
      raw: JSON.stringify(valid),
      model: "mock-model",
      usage: { durationMs: 1 },
    });

    const provider: LlmProvider = {
      name: "mock",
      model: "mock-model",
      generateText: vi.fn(),
      generateJson,
    };

    const fetchYahoo = vi.fn().mockResolvedValue({
      headlines: [],
      sector: "Technology",
      marketCap: 1000,
      nextEarningsDate: null,
      financials: { trailingPE: null, returnOnEquity: null, debtToEquity: null },
    });

    const result = await runEnrichment(db, id, { provider, fetchYahoo });
    expect(result.sentiment).toBe("NEUTRAL");
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(generateJson.mock.calls[0]![0].schema).toBe(EnrichmentResultSchema);
    expect(generateJson.mock.calls[0]![0].maxRetries).toBe(1);

    const row = db.prepare(`SELECT sentiment, confidence FROM enrichments WHERE signal_id = ?`).get(id) as {
      sentiment: string;
      confidence: string;
    };
    expect(row.sentiment).toBe("NEUTRAL");
    expect(row.confidence).toBe("LOW");
    db.close();
  });

  it("is idempotent when enrichment already exists", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    insertSignal(db, {
      ticker: "ZZZ",
      date: "2024-06-10",
      signal: "BUY",
      price: 50,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.05,
      atr14: 1,
      initialAtrStop: 45,
    });
    const { id } = db.prepare(`SELECT id FROM signals WHERE ticker = 'ZZZ'`).get() as { id: number };
    db.prepare(
      `
      INSERT INTO enrichments (signal_id, sentiment, rationale, headlines, confidence)
      VALUES (?, 'BULLISH', 'This rationale is long enough for schema validation rules here.', '[]', 'HIGH')
    `,
    ).run(id);
    const generateJson = vi.fn();
    const provider: LlmProvider = {
      name: "mock",
      model: "mock-model",
      generateText: vi.fn(),
      generateJson,
    };
    const result = await runEnrichment(db, id, {
      provider,
      fetchYahoo: vi.fn(),
    });
    expect(result.sentiment).toBe("BULLISH");
    expect(generateJson).not.toHaveBeenCalled();
    db.close();
  });
});
