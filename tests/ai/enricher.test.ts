import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEnrichment } from "../../src/llm/enricher.js";
import { JSON_RETRY_USER_MESSAGE } from "../../src/llm/types.js";
import type { LLMProvider } from "../../src/llm/types.js";
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
  process.env.LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "a";
  process.env.LLM_MAX_TOKENS = "600";
}

const valid = {
  sentiment: "NEUTRAL",
  rationale: "This rationale is long enough for schema validation rules here.",
  earningsDate: null as string | null,
  sector: "Technology",
  confidence: "LOW" as const,
};

describe("runEnrichment", () => {
  beforeEach(() => {
    envForEnrich();
  });

  afterEach(() => {
    Object.assign(process.env, saved);
    resetConfigCache();
  });

  it("retries once with deterministic JSON correction message then persists", async () => {
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

    const complete = vi
      .fn()
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce(JSON.stringify(valid));

    const provider: LLMProvider = { name: "mock", complete };

    const fetchYahoo = vi.fn().mockResolvedValue({
      headlines: [],
      sector: "Technology",
      marketCap: 1000,
      nextEarningsDate: null,
    });

    const result = await runEnrichment(db, id, { provider, fetchYahoo });
    expect(result.sentiment).toBe("NEUTRAL");
    expect(complete).toHaveBeenCalledTimes(2);
    const secondMsgs = complete.mock.calls[1]![0] as import("../../src/llm/types.js").LLMMessage[];
    expect(secondMsgs[secondMsgs.length - 1]!.content).toBe(JSON_RETRY_USER_MESSAGE);
    expect(secondMsgs[secondMsgs.length - 2]!.role).toBe("assistant");
    expect(secondMsgs[secondMsgs.length - 2]!.content).toBe("not-json");

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
    const complete = vi.fn();
    const provider: LLMProvider = { name: "mock", complete };
    const result = await runEnrichment(db, id, {
      provider,
      fetchYahoo: vi.fn(),
    });
    expect(result.sentiment).toBe("BULLISH");
    expect(complete).not.toHaveBeenCalled();
    db.close();
  });
});
