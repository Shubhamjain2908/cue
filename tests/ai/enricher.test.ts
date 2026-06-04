import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEnrichment } from "../../src/llm/enricher.js";
import { EnrichmentResultSchema, type EnrichmentResult } from "../../src/llm/enrichment.js";
import { LlmJsonValidationError } from "../../src/llm/json.js";
import type { LlmProvider } from "../../src/llm/types.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  insertEnrichment,
  insertEnrichmentStub,
  insertSignal,
} from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";
import { LLMTimeoutError } from "../../src/errors.js";
import { ZodError } from "zod";

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

    const row = db.prepare(`SELECT sentiment, confidence, status FROM enrichments WHERE signal_id = ?`).get(id) as {
      sentiment: string;
      confidence: string;
      status: string;
    };
    expect(row.sentiment).toBe("NEUTRAL");
    expect(row.confidence).toBe("LOW");
    expect(row.status).toBe("OK");
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
      INSERT INTO enrichments (signal_id, status, sentiment, rationale, headlines, confidence)
      VALUES (?, 'OK', 'BULLISH', 'This rationale is long enough for schema validation rules here.', '[]', 'HIGH')
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

  it("persists TIMEOUT stub and rethrows on LLM timeout", async () => {
    process.env.VERTEX_TIMEOUT_MS = "50";
    resetConfigCache();

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    insertSignal(db, {
      ticker: "TO",
      date: "2024-06-10",
      signal: "BUY",
      price: 50,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.05,
      atr14: 1,
      initialAtrStop: 45,
    });
    const { id } = db.prepare(`SELECT id FROM signals WHERE ticker = 'TO'`).get() as { id: number };

    const generateJson = vi.fn(() => new Promise<never>(() => {}));
    const provider: LlmProvider = {
      name: "mock",
      model: "mock-model",
      generateText: vi.fn(),
      generateJson,
    };

    await expect(
      runEnrichment(db, id, {
        provider,
        fetchYahoo: vi.fn().mockResolvedValue({
          headlines: [],
          sector: "Technology",
          marketCap: 1000,
          nextEarningsDate: null,
          financials: { trailingPE: null, returnOnEquity: null, debtToEquity: null },
        }),
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);

    const row = db.prepare(`SELECT status, rationale FROM enrichments WHERE signal_id = ?`).get(id) as {
      status: string;
      rationale: string;
    };
    expect(row.status).toBe("TIMEOUT");
    expect(row.rationale).toBe("[enrichment unavailable]");
    db.close();
  });

  it("persists SCHEMA_FAIL stub on Zod validation failure", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    insertSignal(db, {
      ticker: "ZD",
      date: "2024-06-10",
      signal: "BUY",
      price: 50,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.05,
      atr14: 1,
      initialAtrStop: 45,
    });
    const { id } = db.prepare(`SELECT id FROM signals WHERE ticker = 'ZD'`).get() as { id: number };

    const zodErr = new ZodError([]);
    const generateJson = vi.fn().mockRejectedValue(new LlmJsonValidationError("{}", zodErr));
    const provider: LlmProvider = {
      name: "mock",
      model: "mock-model",
      generateText: vi.fn(),
      generateJson,
    };

    await expect(
      runEnrichment(db, id, {
        provider,
        fetchYahoo: vi.fn().mockResolvedValue({
          headlines: [],
          sector: "Technology",
          marketCap: 1000,
          nextEarningsDate: null,
          financials: { trailingPE: null, returnOnEquity: null, debtToEquity: null },
        }),
      }),
    ).rejects.toBeInstanceOf(LlmJsonValidationError);

    const row = db.prepare(`SELECT status FROM enrichments WHERE signal_id = ?`).get(id) as {
      status: string;
    };
    expect(row.status).toBe("SCHEMA_FAIL");
    db.close();
  });

  it("does not overwrite OK enrichment with stub insert", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    insertSignal(db, {
      ticker: "OK",
      date: "2024-06-10",
      signal: "BUY",
      price: 50,
      momentumRank: 1,
      universeRankedCount: 10,
      momentum12_1Return: 0.05,
      atr14: 1,
      initialAtrStop: 45,
    });
    const { id } = db.prepare(`SELECT id FROM signals WHERE ticker = 'OK'`).get() as { id: number };
    insertEnrichment(db, {
      signalId: id,
      sentiment: valid.sentiment,
      rationale: valid.rationale,
      earningsFlag: 0,
      earningsDate: null,
      sector: valid.sector,
      sectorTrend: null,
      headlines: "[]",
      confidence: valid.confidence,
    });
    insertEnrichmentStub(db, { signalId: id, status: "TIMEOUT" });
    const row = db.prepare(`SELECT status FROM enrichments WHERE signal_id = ?`).get(id) as {
      status: string;
    };
    expect(row.status).toBe("OK");
    db.close();
  });

  it("persists stub for WATCHLIST enrichment failure", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    insertSignal(db, {
      ticker: "WL",
      date: "2024-06-10",
      signal: "WATCHLIST",
      price: 50,
      momentumRank: 4,
      universeRankedCount: 10,
      momentum12_1Return: 0.05,
      atr14: 1,
    });
    const { id } = db.prepare(`SELECT id FROM signals WHERE ticker = 'WL'`).get() as { id: number };

    const generateJson = vi.fn().mockRejectedValue(new Error("provider down"));
    const provider: LlmProvider = {
      name: "mock",
      model: "mock-model",
      generateText: vi.fn(),
      generateJson,
    };

    await expect(
      runEnrichment(db, id, {
        provider,
        fetchYahoo: vi.fn().mockResolvedValue({
          headlines: [],
          sector: "Technology",
          marketCap: 1000,
          nextEarningsDate: null,
          financials: { trailingPE: null, returnOnEquity: null, debtToEquity: null },
        }),
      }),
    ).rejects.toThrow("provider down");

    const row = db.prepare(`SELECT status FROM enrichments WHERE signal_id = ?`).get(id) as {
      status: string;
    };
    expect(row.status).toBe("LLM_FAIL");
    db.close();
  });
});
