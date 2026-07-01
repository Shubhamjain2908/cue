/**
 * Yahoo Finance enrichment context with disk cache.
 * Optional small backoff on HTTP 429 is acceptable but not required for typical topN batch sizes.
 * `quoteSummary` with multiple modules is a single library call per fetch path.
 */

import fs from "node:fs";
import path from "node:path";

import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import { MS_PER_DAY } from "../shared/constants.js";

import { getConfig } from "../config/index.js";

export type YahooFinanceHandle = InstanceType<typeof YahooFinance>;

const NEWS_TTL_MS = 24 * 60 * 60 * 1000;
const CALENDAR_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const cachedNewsBundleSchema = z.object({
  ticker: z.string(),
  fetchedAt: z.number(),
  headlines: z.array(
    z.object({
      title: z.string(),
      source: z.string().optional(),
      publishedAt: z.string().optional(),
    }),
  ),
});

const cachedCalendarBundleSchema = z.object({
  ticker: z.string(),
  fetchedAt: z.number(),
  nextEarningsDate: z.string().nullable(),
});

const cachedFinancialsSchema = z.object({
  trailingPE: z.number().nullable(),
  returnOnEquity: z.number().nullable(),
  debtToEquity: z.number().nullable(),
  // Extended fields (Phase 1 quality-score; required like original 3 — old cache files
  // missing these will fail validation and be re-fetched within 7-day PROFILE_TTL_MS).
  returnOnAssets: z.number().nullable(),
  grossMargins: z.number().nullable(),
  operatingMargins: z.number().nullable(),
  profitMargins: z.number().nullable(),
  operatingCashflow: z.number().nullable(),
  freeCashflow: z.number().nullable(),
  currentRatio: z.number().nullable(),
  totalDebt: z.number().nullable(),
  totalCash: z.number().nullable(),
  priceToSalesTrailing12Months: z.number().nullable(),
  forwardPE: z.number().nullable(),
  priceToBook: z.number().nullable(),
  bookValue: z.number().nullable(),
  earningsGrowth: z.number().nullable(),
  revenueGrowth: z.number().nullable(),
  enterpriseValue: z.number().nullable(),
  netIncomeToCommon: z.number().nullable(),
});

const cachedProfileBundleSchema = z.object({
  ticker: z.string(),
  fetchedAt: z.number(),
  sector: z.string().nullable(),
  marketCap: z.number().nullable(),
  /** Present on bundles written after fundamentals metrics were added. */
  financials: cachedFinancialsSchema.optional(),
});

const headlineForLedgerSchema = z.object({
  title: z.string(),
  source: z.string().optional().default(""),
  publishedAt: z.string().optional().default(""),
});

export const yahooFundamentalsPayloadSchema = z.object({
  ticker: z.string(),
  /** Exchange session calendar date `YYYY-MM-DD` (caller supplies `getExchangeDateString()`). */
  asOf: z.string(),
  yahoo: z.object({
    headlines: z.array(headlineForLedgerSchema),
    financials: cachedFinancialsSchema,
    sector: z.string().nullable().optional(),
    marketCap: z.number().nullable().optional(),
    nextEarningsDate: z.string().nullable().optional(),
  }),
});

export type YahooFundamentalsPayload = z.infer<typeof yahooFundamentalsPayloadSchema>;

export type YahooEnrichmentDto = {
  headlines: Array<{ title: string; source?: string; publishedAt?: string }>;
  sector: string | null;
  marketCap: number | null;
  nextEarningsDate: string | null;
  financials: {
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
    totalDebt: number | null;
    totalCash: number | null;
    priceToSalesTrailing12Months: number | null;
    forwardPE: number | null;
    priceToBook: number | null;
    bookValue: number | null;
    earningsGrowth: number | null;
    revenueGrowth: number | null;
    enterpriseValue: number | null;
    netIncomeToCommon: number | null;
  };
};

function resolveCacheRoot(cacheDir: string): string {
  return path.isAbsolute(cacheDir) ? cacheDir : path.resolve(process.cwd(), cacheDir);
}

function sanitizeTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
}

function isFresh(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs < ttlMs;
}

function readJsonCache<T>(
  filePath: string,
  ttlMs: number,
  schema: z.ZodType<T>,
): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!isFresh(stat.mtimeMs, ttlMs)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const r = schema.safeParse(parsed);
  return r.success ? r.data : null;
}

function writeJsonCache(filePath: string, dir: string, payload: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function filterHeadlinesLast7Days(
  items: Array<{ title: string; source?: string; publishedAt?: string }>,
  nowMs: number,
): Array<{ title: string; source?: string; publishedAt?: string }> {
  const cutoff = nowMs - 7 * MS_PER_DAY;
  return items.filter((h) => {
    if (!h.publishedAt) {
      return true;
    }
    const t = Date.parse(h.publishedAt);
    if (Number.isNaN(t)) {
      return true;
    }
    return t >= cutoff;
  });
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const searchNewsItemSchema = z.object({
  title: z.string(),
  publisher: z.string().optional(),
  providerPublishTime: z.union([z.date(), z.string(), z.number()]).optional(),
});

const searchNewsResultSchema = z.object({
  news: z.array(searchNewsItemSchema).optional().default([]),
});

function parseSearchNews(raw: unknown): Array<{
  title: string;
  source?: string;
  publishedAt?: string;
}> {
  const parsed = searchNewsResultSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.news.map((n) => ({
    title: n.title,
    source: n.publisher,
    publishedAt:
      n.providerPublishTime instanceof Date
        ? n.providerPublishTime.toISOString()
        : n.providerPublishTime !== undefined
          ? new Date(n.providerPublishTime).toISOString()
          : undefined,
  }));
}

function extractFinancialsFromQuoteSummary(qs: {
  summaryDetail?: { trailingPE?: unknown };
  financialData?: {
    returnOnEquity?: unknown;
    debtToEquity?: unknown;
    returnOnAssets?: unknown;
    grossMargins?: unknown;
    operatingMargins?: unknown;
    profitMargins?: unknown;
    operatingCashflow?: unknown;
    freeCashflow?: unknown;
    currentRatio?: unknown;
    totalDebt?: unknown;
    totalCash?: unknown;
    priceToSalesTrailing12Months?: unknown;
    earningsGrowth?: unknown;
    revenueGrowth?: unknown;
    enterpriseValue?: unknown;
    netIncomeToCommon?: unknown;
  };
  defaultKeyStatistics?: {
    priceToBook?: unknown;
    bookValue?: unknown;
    forwardPE?: unknown;
    enterpriseValue?: unknown;
    netIncomeToCommon?: unknown;
  };
}): YahooEnrichmentDto["financials"] {
  const fd = qs.financialData ?? {};
  const dk = qs.defaultKeyStatistics ?? {};
  return {
    trailingPE: numOrNull(qs.summaryDetail?.trailingPE),
    returnOnEquity: numOrNull(fd.returnOnEquity),
    debtToEquity: numOrNull(fd.debtToEquity),
    returnOnAssets: numOrNull(fd.returnOnAssets),
    grossMargins: numOrNull(fd.grossMargins),
    operatingMargins: numOrNull(fd.operatingMargins),
    profitMargins: numOrNull(fd.profitMargins),
    operatingCashflow: numOrNull(fd.operatingCashflow),
    freeCashflow: numOrNull(fd.freeCashflow),
    currentRatio: numOrNull(fd.currentRatio),
    totalDebt: numOrNull(fd.totalDebt),
    totalCash: numOrNull(fd.totalCash),
    priceToSalesTrailing12Months: numOrNull(fd.priceToSalesTrailing12Months),
    forwardPE: numOrNull(dk.forwardPE),
    priceToBook: numOrNull(dk.priceToBook),
    bookValue: numOrNull(dk.bookValue),
    earningsGrowth: numOrNull(fd.earningsGrowth),
    revenueGrowth: numOrNull(fd.revenueGrowth),
    enterpriseValue: numOrNull(dk.enterpriseValue ?? fd.enterpriseValue),
    netIncomeToCommon: numOrNull(dk.netIncomeToCommon ?? fd.netIncomeToCommon),
  };
}

/**
 * Validates the ledger row shape for `fundamentals_cache.payload_json` (headlines + financials + optional overview fields).
 */
export function buildValidatedFundamentalsPayload(
  ticker: string,
  asOf: string,
  dto: YahooEnrichmentDto,
): YahooFundamentalsPayload {
  return yahooFundamentalsPayloadSchema.parse({
    ticker: sanitizeTicker(ticker),
    asOf,
    yahoo: {
      headlines: dto.headlines.map((h) => ({
        title: h.title,
        source: h.source ?? "",
        publishedAt: h.publishedAt ?? "",
      })),
      financials: dto.financials,
      sector: dto.sector,
      marketCap: dto.marketCap,
      nextEarningsDate: dto.nextEarningsDate,
    },
  });
}

/**
 * Full Yahoo enrichment DTO plus Zod-validated fundamentals ledger fields (`asOf`, structured `yahoo`).
 */
export async function fetchExtendedYahooContext(
  ticker: string,
  exchangeDate: string,
  yf: YahooFinanceHandle = new YahooFinance({ suppressNotices: ["yahooSurvey"] }),
  nowMs: number = Date.now(),
): Promise<YahooFundamentalsPayload> {
  const dto = await fetchYahooEnrichmentDto(ticker, yf, nowMs);
  return buildValidatedFundamentalsPayload(ticker, exchangeDate, dto);
}

export async function fetchYahooEnrichmentDto(
  ticker: string,
  yf: YahooFinanceHandle = new YahooFinance({ suppressNotices: ["yahooSurvey"] }),
  nowMs: number = Date.now(),
): Promise<YahooEnrichmentDto> {
  const config = getConfig();
  const root = path.join(resolveCacheRoot(config.CACHE_DIR), "yahoo");
  const safe = sanitizeTicker(ticker);
  const newsPath = path.join(root, `${safe}_news.json`);
  const calPath = path.join(root, `${safe}_calendar.json`);
  const profPath = path.join(root, `${safe}_profile.json`);

  let headlines =
    readJsonCache(newsPath, NEWS_TTL_MS, cachedNewsBundleSchema)?.headlines ?? null;
  if (headlines === null) {
    // Quotes are unused; skip quote validation (Yahoo `typeDisp` casing drifts vs library schema).
    const search = await yf.search(
      ticker,
      { newsCount: 10, quotesCount: 0 },
      { validateResult: false },
    );
    const rawNews = parseSearchNews(search);
    headlines = filterHeadlinesLast7Days(rawNews, nowMs);
    writeJsonCache(newsPath, root, {
      ticker: safe,
      fetchedAt: nowMs,
      headlines,
    });
  }

  let nextEarningsDate: string | null;
  const calCached = readJsonCache(calPath, CALENDAR_TTL_MS, cachedCalendarBundleSchema);
  if (calCached !== null) {
    nextEarningsDate = calCached.nextEarningsDate;
  } else {
    const qs = await yf.quoteSummary(ticker, { modules: ["calendarEvents"] });
    const dates = qs.calendarEvents?.earnings?.earningsDate ?? [];
    const first = dates[0];
    nextEarningsDate =
      first instanceof Date ? formatIsoDate(first) : first != null ? String(first).slice(0, 10) : null;
    writeJsonCache(calPath, root, {
      ticker: safe,
      fetchedAt: nowMs,
      nextEarningsDate,
    });
  }

  let profile = readJsonCache(profPath, PROFILE_TTL_MS, cachedProfileBundleSchema);
  if (profile !== null && profile.financials === undefined) {
    profile = null;
  }

  if (profile === null) {
    const qs = await yf.quoteSummary(ticker, {
      modules: ["assetProfile", "summaryDetail", "financialData", "defaultKeyStatistics"],
    });
    const sector = qs.assetProfile?.sector ?? qs.assetProfile?.sectorDisp ?? null;
    const marketCap =
      typeof qs.summaryDetail?.marketCap === "number" ? qs.summaryDetail.marketCap : null;
    const financials = extractFinancialsFromQuoteSummary(qs);
    profile = {
      ticker: safe,
      fetchedAt: nowMs,
      sector,
      marketCap,
      financials,
    };
    writeJsonCache(profPath, root, profile);
  }

  const financials = profile.financials ?? {
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
  };

  return {
    headlines,
    sector: profile.sector ?? null,
    marketCap: profile.marketCap ?? null,
    nextEarningsDate,
    financials,
  };
}
