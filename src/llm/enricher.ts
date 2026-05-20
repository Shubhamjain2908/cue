import type Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import {
  getBuySignalForEnrichment,
  getEnrichmentBySignalId,
  insertEnrichment,
  type EnrichmentRow,
} from "../db/queries.js";
import { createLlmProviderFromEnv } from "./provider.js";
import { buildPrompt, calendarDaysBetweenIso, tryParseModelJson } from "./prompt.js";
import {
  EnrichmentResultSchema,
  JSON_RETRY_USER_MESSAGE,
  type EnrichmentResult,
  type LLMMessage,
  type LLMProvider,
} from "./types.js";
import { fetchYahooEnrichmentDto, type YahooFinanceHandle } from "./yahooContext.js";

type SqliteConnection = InstanceType<typeof Database>;

function assertBuyMomentumRow(
  row: import("../db/queries.js").BuySignalForEnrichmentRow,
): void {
  const checks: Array<[string, unknown]> = [
    ["momentumRank", row.momentumRank],
    ["universeRankedCount", row.universeRankedCount],
    ["momentum12_1Return", row.momentum12_1Return],
    ["atr14", row.atr14],
    ["initialAtrStop", row.initialAtrStop],
  ];
  for (const [name, v] of checks) {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
      throw new Error(`BUY signal ${row.id} is missing denormalized momentum field: ${name}`);
    }
  }
}

function earningsProximityFlag(signalDateIso: string, nextEarningsIso: string | null): number {
  if (nextEarningsIso === null) {
    return 0;
  }
  return calendarDaysBetweenIso(signalDateIso, nextEarningsIso) <= 5 ? 1 : 0;
}

function enrichmentRowToResult(row: EnrichmentRow): EnrichmentResult {
  return EnrichmentResultSchema.parse({
    sentiment: row.sentiment,
    rationale: row.rationale,
    earningsDate: row.earningsDate,
    sector: row.sector ?? "Unknown",
    confidence: row.confidence,
  });
}

function parseEnrichmentJson(raw: string): EnrichmentResult {
  const parsed = tryParseModelJson(raw);
  return EnrichmentResultSchema.parse(parsed);
}

export interface RunEnrichmentDeps {
  provider?: LLMProvider;
  yahooFinance?: YahooFinanceHandle;
  /** Override Yahoo fetch (unit tests). */
  fetchYahoo?: typeof fetchYahooEnrichmentDto;
}

/**
 * Fetches Yahoo context, calls the LLM, validates JSON, persists one `enrichments` row.
 * Idempotent: returns existing enrichment if already stored for `signalId`.
 */
export async function runEnrichment(
  db: SqliteConnection,
  signalId: number,
  deps: RunEnrichmentDeps = {},
): Promise<EnrichmentResult> {
  const existing = getEnrichmentBySignalId(db, signalId);
  if (existing !== undefined) {
    return enrichmentRowToResult(existing);
  }

  const row = getBuySignalForEnrichment(db, signalId);
  if (row === undefined) {
    throw new Error(`No BUY signal found for id ${signalId}`);
  }
  assertBuyMomentumRow(row);

  const yahoo = await (deps.fetchYahoo ?? fetchYahooEnrichmentDto)(row.ticker, deps.yahooFinance);
  const messages = buildPrompt(row.ticker, yahoo, row);
  const config = getConfig();
  const provider = deps.provider ?? createLlmProviderFromEnv();
  const maxTokens = config.LLM_MAX_TOKENS;

  let raw = await provider.complete(messages, maxTokens);
  let result: EnrichmentResult;
  try {
    result = parseEnrichmentJson(raw);
  } catch {
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: "assistant", content: raw },
      { role: "user", content: JSON_RETRY_USER_MESSAGE },
    ];
    raw = await provider.complete(retryMessages, maxTokens);
    try {
      result = parseEnrichmentJson(raw);
    } catch (secondErr) {
      throw secondErr;
    }
  }

  const earningsFlag = earningsProximityFlag(row.date, yahoo.nextEarningsDate);
  insertEnrichment(db, {
    signalId: row.id,
    sentiment: result.sentiment,
    rationale: result.rationale,
    earningsFlag,
    earningsDate: result.earningsDate,
    sector: result.sector,
    sectorTrend: null,
    headlines: JSON.stringify(yahoo.headlines),
    confidence: result.confidence,
  });

  return result;
}
