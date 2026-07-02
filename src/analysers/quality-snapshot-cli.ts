/**
 * `cue quality-snapshot` — Phase 1 advisory overlay CLI.
 *
 * For each ticker (from `--ticker` args or today's BUY signals):
 *   1. Fetch fresh Yahoo data via `fetchExtendedYahooContext` (force-refresh)
 *   2. Query `daily_prices` for SMA200 (trend confirm)
 *   3. Run `computeFinancialHealthScore`
 *   4. Merge quality block into `fundamentals_cache.payload_json.quality`
 */

import Database from "better-sqlite3";

import { cueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import { getExchangeDateString } from "../config/cue-timezone.js";
import { openCueDb } from "../db/provider.js";
import {
  listBuySignalsReadyToAlert,
  upsertFundamentalsCache,
  upsertFundamentalsPayloadQuality,
} from "../db/queries.js";
import { sma } from "../enrichers/indicators.js";
import { fetchExtendedYahooContext, type YahooFundamentalsPayload } from "../llm/yahooContext.js";
import { computeFinancialHealthScore, type QualityInputFinancials } from "./signal-quality.js";

type SqliteConnection = InstanceType<typeof Database>;

/**
 * Get the most recent close and whether price > SMA200 from daily_prices.
 */
function getPriceTrend(
  db: SqliteConnection,
  ticker: string,
): { priceAboveSma200: boolean | null } {
  const rows = db
    .prepare(
      `SELECT close FROM daily_prices WHERE ticker = ? ORDER BY date DESC LIMIT 200`,
    )
    .all(ticker.toUpperCase()) as { close: number }[];

  if (rows.length < 200) {
    return { priceAboveSma200: null };
  }

  const closes: number[] = rows.map((r) => r.close).reverse();
  const lastClose = closes[closes.length - 1]!;
  const sma200 = sma(200, closes);
  return { priceAboveSma200: sma200 !== null ? lastClose > sma200 : null };
}

/**
 * Extract QualityInputFinancials from a validated YahooFundamentalsPayload.
 */
function financialsFromPayload(
  payload: YahooFundamentalsPayload,
): QualityInputFinancials {
  const f = payload.yahoo.financials;
  return {
    trailingPE: f.trailingPE,
    returnOnEquity: f.returnOnEquity,
    debtToEquity: f.debtToEquity,
    returnOnAssets: f.returnOnAssets,
    grossMargins: f.grossMargins,
    operatingMargins: f.operatingMargins,
    profitMargins: f.profitMargins,
    operatingCashflow: f.operatingCashflow,
    freeCashflow: f.freeCashflow,
    currentRatio: f.currentRatio,
    priceToSalesTrailing12Months: f.priceToSalesTrailing12Months,
    forwardPE: f.forwardPE,
    priceToBook: f.priceToBook,
    earningsGrowth: f.earningsGrowth,
    revenueGrowth: f.revenueGrowth,
  };
}

/**
 * Run quality-snapshot for one ticker:
 * fetch fresh Yahoo data → compute score → persist quality block.
 */
async function runQualitySnapshotForTicker(
  db: SqliteConnection,
  ticker: string,
  asOfDate: string,
): Promise<void> {
  cueLogger.info(`quality_snapshot_start ticker=${ticker}`);

  // 1. Fetch fresh Yahoo data (force-refresh to get latest financials)
  const payload = await fetchExtendedYahooContext(
    ticker,
    asOfDate,
    undefined,
    undefined,
    true, // forceRefresh
  );

  // 2. Persist the Yahoo payload to fundamentals_cache (disk cache is already updated
  //    by fetchExtendedYahooContext; this writes to the SQLite ledger so downstream
  //    steps like enrich-fundamentals don't overwrite the quality block).
  upsertFundamentalsCache(ticker, asOfDate, JSON.stringify(payload));

  // 3. Extract financials from the validated payload directly
  const financials = financialsFromPayload(payload);
  const sector = payload.yahoo.sector ?? null;

  // 4. Get SMA200 trend from daily_prices
  const { priceAboveSma200 } = getPriceTrend(db, ticker);

  // 5. Compute Financial Health Score
  const result = computeFinancialHealthScore({
    ticker,
    sector,
    financials,
    priceAboveSma200,
  });

  // 6. Merge quality block into fundamentals_cache.payload_json
  //    (runs after the upsertFundamentalsCache above, so the yahoo block
  //     is already in the DB — this only adds/substitutes the quality sub-object).
  upsertFundamentalsPayloadQuality(ticker, asOfDate, result as unknown as Record<string, unknown>);

  const scoreStr = result.financialHealthScore !== null ? result.financialHealthScore.toFixed(1) : "null";
  cueLogger.info(
    `quality_snapshot_done ticker=${ticker} score=${scoreStr} ` +
      `flags=${result.flags.join(",") || "none"}`,
  );
}

export interface QualitySnapshotOpts {
  /** Specific tickers to snapshot. When empty, uses today's unalerted BUY signals. */
  tickers?: string[];
}

/**
 * Main entry for `cue quality-snapshot`.
 */
export async function runQualitySnapshotCli(opts: QualitySnapshotOpts = {}): Promise<void> {
  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  const asOfDate = getExchangeDateString();

  try {
    let tickers = opts.tickers ?? [];

    if (tickers.length === 0) {
      // No explicit tickers — query today's unalerted BUY signals
      const buys = listBuySignalsReadyToAlert(db);
      tickers = [...new Set(buys.map((b) => b.ticker))];
      cueLogger.info(`quality_snapshot_from_signals count=${tickers.length}`);
    }

    if (tickers.length === 0) {
      cueLogger.info("quality_snapshot_skip no BUY signals to snapshot");
      return;
    }

    for (const t of tickers) {
      await runQualitySnapshotForTicker(db, t, asOfDate);
    }

    cueLogger.info("quality_snapshot_all_done");
  } finally {
    db.close();
  }
}
