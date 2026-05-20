import { fetchYahooEnrichmentDto } from "../llm/yahooContext.js";
import { cueLogger } from "../cli/cue-logger.js";
import { loadUniverseTickers } from "../universe/load-universe.js";

export interface EnrichFundamentalsOpts {
  readonly ticker?: string;
  /** When set without `--ticker`, fetch Yahoo context for the first N names (default 3). */
  readonly limit?: number;
  readonly force?: boolean;
  /** Reserved for as-of date filtering (Phase 4). */
  readonly date?: string;
}

/**
 * Phase 4 placeholder: pull Yahoo `quoteSummary` / search-backed bundles into disk cache.
 * `fundamentals_cache` table wiring can follow in a later migration.
 */
export async function runEnrichFundamentalsCli(opts: EnrichFundamentalsOpts): Promise<void> {
  if (opts.date !== undefined && opts.date.length > 0) {
    cueLogger.warn(`enrich_fundamentals_date_ignored date=${opts.date} (not implemented)`);
  }

  if (opts.ticker !== undefined && opts.ticker.trim().length > 0) {
    const t = opts.ticker.trim().toUpperCase();
    cueLogger.info(`enrich_fundamentals_ticker ticker=${t}`);
    const dto = await fetchYahooEnrichmentDto(t);
    console.log(JSON.stringify({ ticker: t, yahoo: dto }, null, 2));
    cueLogger.info("enrich_fundamentals_done single_ticker");
    return;
  }

  const tickers = loadUniverseTickers();
  const n =
    opts.force === true
      ? tickers.length
      : Math.min(opts.limit ?? 3, tickers.length);
  cueLogger.info(`enrich_fundamentals_batch count=${n} force=${Boolean(opts.force)}`);
  for (const t of tickers.slice(0, n)) {
    const dto = await fetchYahooEnrichmentDto(t);
    cueLogger.info(`enrich_fundamentals_row ticker=${t} sector=${dto.sector ?? "n/a"}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  cueLogger.info("enrich_fundamentals_done batch");
}
