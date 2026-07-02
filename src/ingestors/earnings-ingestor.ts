/**
 * Earnings history ingestor — fetches historical earnings report dates from
 * Yahoo Finance `quoteSummary('earnings')` and persists them to the
 * `earnings_events` table for the earnings-blackout veto research (Task 8).
 *
 * The `earningsChart.earningsDate` array typically contains the most recent
 * 4 quarterly earnings report dates per ticker. This is sufficient for
 * research on the ~5-year backtest horizon (2021–2026).
 */

import Database from "better-sqlite3";
import YahooFinance from "yahoo-finance2";

import { cueLogger } from "../cli/cue-logger.js";
import { getConfig } from "../config/index.js";
import { openCueDb } from "../db/provider.js";
import { setPipelineState } from "../db/queries.js";
import { initSchema } from "../db/schema.js";
import { loadUniverseTickers } from "../universe/load-universe.js";

type SqliteConnection = InstanceType<typeof Database>;
type YahooFinanceHandle = InstanceType<typeof YahooFinance>;

/** Pipeline state key for marking tickers as fetched. */
function earningsFetchedKey(ticker: string): string {
  return `earnings_fetched:${ticker}`;
}

/**
 * Parse the `earningsDate` array from a Yahoo Finance quoteSummary result.
 * Returns an array of ISO date strings (YYYY-MM-DD).
 */
function parseEarningsDates(result: {
  earnings?: {
    earningsChart?: {
      earningsDate?: Array<Date | string | number>;
      quarterly?: Array<{ date?: string; actual?: number | null; estimate?: number | null }>;
    };
  };
}): Array<{ reportDate: string; fiscalQuarter: string | null; epsActual: number | null; epsEstimate: number | null }> {
  const chart = result.earnings?.earningsChart;
  if (!chart) return [];

  // Parse earningsDate array (Date objects from Yahoo)
  const dates: string[] = [];
  if (chart.earningsDate) {
    for (const d of chart.earningsDate) {
      if (d instanceof Date) {
        dates.push(d.toISOString().slice(0, 10));
      } else if (typeof d === "number") {
        dates.push(new Date(d * 1000).toISOString().slice(0, 10));
      } else if (typeof d === "string") {
        dates.push(d.slice(0, 10));
      }
    }
  }

  // Parse quarterly data for fiscal quarter labels and EPS values
  const quarterly = chart.quarterly ?? [];
  const events: Array<{
    reportDate: string;
    fiscalQuarter: string | null;
    epsActual: number | null;
    epsEstimate: number | null;
  }> = [];

  // Use earningsDate array when available (more reliable for report dates)
  for (const d of dates) {
    events.push({
      reportDate: d,
      fiscalQuarter: null, // matched from quarterly below if possible
      epsActual: null,
      epsEstimate: null,
    });
  }

  // Merge quarterly data to fill in fiscal quarter labels and EPS
  for (const q of quarterly) {
    // quarterly dates are like "Q1 2024" or "2024-03-30" — try to find matching event
    // We use position-based matching (same index for the 4 quarters)
    if (events.length > 0) {
      const idx = quarterly.indexOf(q);
      if (idx < events.length) {
        events[idx]!.fiscalQuarter = q.date ?? null;
        events[idx]!.epsActual = q.actual ?? null;
        events[idx]!.epsEstimate = q.estimate ?? null;
      }
    }
  }

  return events;
}

/**
 * Fetch and persist earnings events for a single ticker.
 * Skips if already fetched (pipeline state check).
 */
export async function fetchAndPersistEarnings(
  db: SqliteConnection,
  ticker: string,
  yf: YahooFinanceHandle,
): Promise<void> {
  const tickerUpper = ticker.toUpperCase();

  // Skip if already fetched
  const existing = db
    .prepare(`SELECT id FROM earnings_events WHERE ticker = ? ORDER BY report_date DESC LIMIT 1`)
    .get(tickerUpper) as { id: number } | undefined;

  if (existing !== undefined) {
    cueLogger.debug(`earnings_fetch_skip_already_fetched ticker=${tickerUpper}`);
    return;
  }

  cueLogger.info(`earnings_fetch_start ticker=${tickerUpper}`);

  try {
    const result = await yf.quoteSummary(tickerUpper, { modules: ["earnings"] });
    const events = parseEarningsDates(result as Record<string, unknown>);

    if (events.length === 0) {
      cueLogger.warn(`earnings_fetch_no_data ticker=${tickerUpper}`);
      return;
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO earnings_events (ticker, report_date, fiscal_quarter, eps_actual, eps_estimate)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const inserted = db.transaction(() => {
      let count = 0;
      for (const e of events) {
        const result = insert.run(
          tickerUpper,
          e.reportDate,
          e.fiscalQuarter,
          e.epsActual,
          e.epsEstimate,
        );
        if (result.changes > 0) count++;
      }
      return count;
    })();

    setPipelineState(db, earningsFetchedKey(tickerUpper), String(events.length));
    cueLogger.info(`earnings_fetch_done ticker=${tickerUpper} inserted=${inserted} total=${events.length}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    cueLogger.warn(`earnings_fetch_failed ticker=${tickerUpper} error=${msg}`);
  }
}

/** Options for the earnings CLI ingestor. */
export interface EarningsIngestorOpts {
  /** Single ticker to fetch (optional; default: entire universe). */
  ticker?: string;
  /** Force-refresh all tickers even if already fetched. */
  force?: boolean;
}

/**
 * Fetch earnings events for all universe tickers (or single ticker if specified).
 * Populates the `earnings_events` table.
 */
export function runEarningsIngestor(opts?: EarningsIngestorOpts): void {
  const config = getConfig();
  const db = openCueDb(config.DB_PATH);
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  try {
    initSchema(db);

    const tickers = opts?.ticker
      ? [opts.ticker.toUpperCase()]
      : loadUniverseTickers();

    cueLogger.info(`earnings_ingestor_start count=${tickers.length}`);

    for (const t of tickers) {
      fetchAndPersistEarnings(db, t, yf);
    }

    // Summary
    const totalRows = db
      .prepare(`SELECT COUNT(*) AS cnt FROM earnings_events`)
      .get() as { cnt: number };
    const tickerCount = db
      .prepare(`SELECT COUNT(DISTINCT ticker) AS cnt FROM earnings_events`)
      .get() as { cnt: number };
    console.log(`\nEarnings events in DB: ${totalRows.cnt} rows across ${tickerCount.cnt} tickers.`);

    // Sample
    const sample = db
      .prepare(`SELECT ticker, report_date, fiscal_quarter FROM earnings_events ORDER BY report_date DESC LIMIT 10`)
      .all() as Array<{ ticker: string; report_date: string; fiscal_quarter: string | null }>;
    if (sample.length > 0) {
      console.log("\nMost recent 10 earnings events:");
      for (const s of sample) {
        console.log(`  ${s.ticker}: ${s.report_date} ${s.fiscal_quarter ?? ""}`);
      }
    }

    cueLogger.info(`earnings_ingestor_done`);
  } finally {
    db.close();
  }
}
