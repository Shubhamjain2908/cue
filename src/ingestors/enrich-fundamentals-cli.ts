import { fetchExtendedYahooContext } from "../llm/yahooContext.js";
import { cueLogger } from "../cli/cue-logger.js";
import { getExchangeDateString } from "../config/cue-timezone.js";
import { selectFundamentalsBatchTickers, upsertFundamentalsCache } from "../db/queries.js";
import { loadUniverseTickers } from "../universe/load-universe.js";

export interface EnrichFundamentalsOpts {
  readonly ticker?: string;
  /** When set without `--ticker`, fetch Yahoo context for the first N names (default 3). */
  readonly limit?: number;
  readonly force?: boolean;
  /** Reserved for as-of date filtering (Phase 4). */
  readonly date?: string;
}

function persistFundamentalsCacheLedger(ticker: string, asOfDate: string, yahooBundle: unknown): void {
  const serializedPayload = JSON.stringify(yahooBundle);
  try {
    upsertFundamentalsCache(ticker, asOfDate, serializedPayload);
    cueLogger.debug("fundamentals_cache persisted successfully", { ticker, asOfDate });
  } catch (error) {
    cueLogger.error("Non-critical error writing fundamentals to database ledger", {
      ticker,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Pull Yahoo `quoteSummary` / search-backed bundles into disk cache (`CACHE_DIR/yahoo/…`),
 * then best-effort upsert into SQLite `fundamentals_cache` (non-critical; failures are logged only).
 */
export async function runEnrichFundamentalsCli(opts: EnrichFundamentalsOpts): Promise<void> {
  if (opts.date !== undefined && opts.date.length > 0) {
    cueLogger.warn(`enrich_fundamentals_date_ignored date=${opts.date} (not implemented)`);
  }

  const asOfDate = getExchangeDateString();

  if (opts.ticker !== undefined && opts.ticker.trim().length > 0) {
    const t = opts.ticker.trim().toUpperCase();
    cueLogger.info(`enrich_fundamentals_ticker ticker=${t}`);
    const payload = await fetchExtendedYahooContext(t, asOfDate);
    console.log(JSON.stringify(payload, null, 2));
    persistFundamentalsCacheLedger(t, asOfDate, payload);
    cueLogger.info("enrich_fundamentals_done single_ticker");
    return;
  }

  const tickers = loadUniverseTickers();
  const batchLimit =
    opts.force === true ? tickers.length : Math.min(opts.limit ?? 3, tickers.length);
  const batchTickers =
    opts.force === true
      ? tickers.map((t) => t.toUpperCase())
      : selectFundamentalsBatchTickers(tickers, asOfDate, batchLimit);

  if (batchTickers.length === 0) {
    cueLogger.info(`enrich_fundamentals_skip all universe tickers cached for as_of_date=${asOfDate}`);
    return;
  }

  cueLogger.info(
    `enrich_fundamentals_batch count=${String(batchTickers.length)} force=${Boolean(opts.force)} as_of_date=${asOfDate}`,
  );
  for (const t of batchTickers) {
    const payload = await fetchExtendedYahooContext(t, asOfDate);
    cueLogger.info(
      `enrich_fundamentals_row ticker=${t} sector=${payload.yahoo.sector ?? "n/a"} pe=${payload.yahoo.financials.trailingPE ?? "n/a"}`,
    );
    persistFundamentalsCacheLedger(t, asOfDate, payload);
    await new Promise((r) => setTimeout(r, 200));
  }
  cueLogger.info("enrich_fundamentals_done batch");
}
