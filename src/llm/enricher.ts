import type Database from "better-sqlite3";
import { ZodError } from "zod";

import { cueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import {
  deleteEnrichmentForSignal,
  getBuySignalForEnrichment,
  getEnrichmentBySignalId,
  insertEnrichment,
  insertEnrichmentStub,
  type EnrichmentRow,
  type EnrichmentStatus,
} from "../db/queries.js";
import { LLMTimeoutError } from "../errors.js";
import { EnrichmentResultSchema, type EnrichmentResult } from "./enrichment.js";
import { getLlmProvider } from "./factory.js";
import { LlmJsonValidationError } from "./json.js";
import { buildPrompt, calendarDaysBetweenIso } from "./prompt.js";
import type { LlmProvider } from "./types.js";
import { fetchYahooEnrichmentDto, type YahooFinanceHandle } from "./yahooContext.js";

type SqliteConnection = InstanceType<typeof Database>;

function assertEnrichableMomentumRow(
  row: import("../db/queries.js").BuySignalForEnrichmentRow,
): void {
  const checks: Array<[string, unknown]> = [
    ["momentumRank", row.momentumRank],
    ["universeRankedCount", row.universeRankedCount],
    ["momentum12_1Return", row.momentum12_1Return],
    ["atr14", row.atr14],
  ];
  if (row.signal === "BUY") {
    checks.push(["initialAtrStop", row.initialAtrStop]);
  }
  for (const [name, v] of checks) {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
      throw new Error(`${row.signal} signal ${row.id} is missing denormalized momentum field: ${name}`);
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

function classifyEnrichmentError(error: unknown): EnrichmentStatus {
  if (error instanceof LLMTimeoutError) {
    return "TIMEOUT";
  }
  if (error instanceof ZodError) {
    return "SCHEMA_FAIL";
  }
  if (error instanceof LlmJsonValidationError && error.cause instanceof ZodError) {
    return "SCHEMA_FAIL";
  }
  return "LLM_FAIL";
}

async function generateJsonWithTimeout<T>(
  signalId: number,
  timeoutMs: number,
  run: () => Promise<{ data: T }>,
): Promise<{ data: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new LLMTimeoutError(signalId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface RunEnrichmentDeps {
  provider?: LlmProvider;
  yahooFinance?: YahooFinanceHandle;
  /** Override Yahoo fetch (unit tests). */
  fetchYahoo?: typeof fetchYahooEnrichmentDto;
}

/**
 * Fetches Yahoo context, calls the LLM, validates JSON, persists one `enrichments` row.
 * Idempotent: returns existing enrichment if already stored for `signalId` with status OK.
 */
export async function runEnrichment(
  db: SqliteConnection,
  signalId: number,
  deps: RunEnrichmentDeps = {},
): Promise<EnrichmentResult> {
  const existing = getEnrichmentBySignalId(db, signalId);
  if (existing !== undefined) {
    if (existing.status === "OK") {
      return enrichmentRowToResult(existing);
    }
    deleteEnrichmentForSignal(db, signalId);
  }

  const row = getBuySignalForEnrichment(db, signalId);
  if (row === undefined) {
    throw new Error(`No enrichable signal found for id ${signalId}`);
  }
  assertEnrichableMomentumRow(row);

  try {
    const yahoo = await (deps.fetchYahoo ?? fetchYahooEnrichmentDto)(row.ticker, deps.yahooFinance);
    const { system, user } = buildPrompt(row.ticker, yahoo, row);
    const config = getConfig();
    const llm = deps.provider ?? getLlmProvider();
    const timeoutMs = config.VERTEX_TIMEOUT_MS;

    const result = await generateJsonWithTimeout(signalId, timeoutMs, () =>
      llm.generateJson({
        system,
        user,
        schema: EnrichmentResultSchema,
        maxOutputTokens: config.LLM_MAX_TOKENS,
        maxRetries: 1,
        temperature: 0.2,
      }),
    );

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
  } catch (error) {
    const status = classifyEnrichmentError(error);
    insertEnrichmentStub(db, { signalId: row.id, status });
    cueLogger.warn(
      `enrichment failed — signalId=${String(row.id)} ticker=${row.ticker} ` +
        `status=${status} error=${String(error)}`,
    );
    throw error;
  }
}
