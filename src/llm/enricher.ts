import type Database from "better-sqlite3";

import { getConfig } from "../config/index.js";
import {
  getBuySignalForEnrichment,
  getEnrichmentBySignalId,
  insertEnrichment,
  type EnrichmentRow,
} from "../db/queries.js";
import { EnrichmentResultSchema, type EnrichmentResult } from "./enrichment.js";
import { getLlmProvider } from "./factory.js";
import { buildPrompt, calendarDaysBetweenIso } from "./prompt.js";
import type { LlmProvider } from "./types.js";
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

export interface RunEnrichmentDeps {
  provider?: LlmProvider;
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
  const { system, user } = buildPrompt(row.ticker, yahoo, row);
  const config = getConfig();
  const llm = deps.provider ?? getLlmProvider();

  const result = await llm.generateJson({
    system,
    user,
    schema: EnrichmentResultSchema,
    maxOutputTokens: config.LLM_MAX_TOKENS,
    maxRetries: 1,
    temperature: 0.2,
  });

  const earningsFlag = earningsProximityFlag(row.date, yahoo.nextEarningsDate);
  insertEnrichment(db, {
    signalId: row.id,
    sentiment: result.data.sentiment,
    rationale: result.data.rationale,
    earningsFlag,
    earningsDate: result.data.earningsDate,
    sector: result.data.sector,
    sectorTrend: null,
    headlines: JSON.stringify(yahoo.headlines),
    confidence: result.data.confidence,
  });

  return result.data;
}
