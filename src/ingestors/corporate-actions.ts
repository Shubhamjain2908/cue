/**
 * Split / reverse-split adjustment for open positions (Yahoo Finance chart events).
 */

import YahooFinance from "yahoo-finance2";
import type { Logger } from "winston";

import { cueLogger } from "../cli/cue-logger.js";
import { setPipelineState } from "../db/queries.js";
import type { CueDatabase } from "../db/provider.js";

/** Marks daily_prices split adjustment done (live applySplit + one-shot backfill). */
export function splitDailyPricesPipelineKey(ticker: string, exDate: string): string {
  return `backfill_split_applied:${ticker}:${exDate}`;
}

/** Retroactively divide OHLC by split factor for all bars strictly before ex-date.
 *  Volume is adjusted in the INVERSE direction (multiplied by factor) so that
 *  `$volume = price × shares` remains continuous across the ex-date boundary.
 *  Forward 2:1 split → historical volume doubles; 1:10 reverse → historical volume × 0.1. */
export function adjustDailyPricesBeforeExDate(
  db: CueDatabase,
  params: { ticker: string; exDate: string; factor: number },
): number {
  const result = db
    .prepare(
      `
      UPDATE daily_prices
      SET
        open   = ROUND(open   / @factor, 6),
        high   = ROUND(high   / @factor, 6),
        low    = ROUND(low    / @factor, 6),
        close  = ROUND(close  / @factor, 6),
        volume = CAST(ROUND(volume * @factor) AS INTEGER)
      WHERE ticker = @ticker
        AND date < @exDate
    `,
    )
    .run({
      factor: params.factor,
      ticker: params.ticker,
      exDate: params.exDate,
    });
  return result.changes;
}

export type YahooFinanceHandle = InstanceType<typeof YahooFinance>;

type CorporateActionType = "split" | "reverse_split";

type OpenPositionRow = {
  ticker: string;
  position_id: number;
};

type SplitEventLike = {
  date: Date | string | number;
  numerator: number;
  denominator: number;
};

function formatIsoDateYmd(value: Date | string | number): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString().slice(0, 10);
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function calendarYmdDaysAgo(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayCalendarYmd(from: Date = new Date()): string {
  return from.toISOString().slice(0, 10);
}

function extractSplitEvents(
  splits: Record<string, SplitEventLike> | SplitEventLike[] | undefined,
): SplitEventLike[] {
  if (splits === undefined) {
    return [];
  }
  if (Array.isArray(splits)) {
    return splits;
  }
  return Object.values(splits);
}

function groupOpenPositionsByTicker(rows: OpenPositionRow[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const row of rows) {
    const list = map.get(row.ticker) ?? [];
    list.push(row.position_id);
    map.set(row.ticker, list);
  }
  return map;
}

export async function adjustSplitsForOpenPositions(
  db: CueDatabase,
  yf: YahooFinanceHandle = new YahooFinance({ suppressNotices: ["yahooSurvey"] }),
  logger: Logger,
): Promise<void> {
  const openRows = db
    .prepare(
      `
      SELECT DISTINCT s.ticker AS ticker, p.id AS position_id
      FROM positions p
      JOIN signals s ON s.id = p.signal_id
      WHERE p.status = 'OPEN'
    `,
    )
    .all() as OpenPositionRow[];

  if (openRows.length === 0) {
    logger.info("[corporate-actions] No open positions; skipping split adjustment");
    return;
  }

  const byTicker = groupOpenPositionsByTicker(openRows);
  const period1 = calendarYmdDaysAgo(7);
  const period2 = todayCalendarYmd();

  const existsStmt = db.prepare(
    `SELECT id FROM corporate_actions WHERE ticker = ? AND ex_date = ? AND type = ?`,
  );

  const applySplit = db.transaction(
    (params: {
      ticker: string;
      exDate: string;
      type: CorporateActionType;
      factor: number;
    }) => {
      db.prepare(
        `
        INSERT INTO corporate_actions (ticker, ex_date, type, factor, source)
        VALUES (@ticker, @exDate, @type, @factor, 'yahoo')
      `,
      ).run({
        ticker: params.ticker,
        exDate: params.exDate,
        type: params.type,
        factor: params.factor,
      });

      db.prepare(
        `
        UPDATE positions
        SET
          entry_price = ROUND(entry_price / @factor, 4),
          current_stop_loss = ROUND(current_stop_loss / @factor, 4),
          highest_close_since_entry = ROUND(highest_close_since_entry / @factor, 4)
        WHERE id IN (
          SELECT p.id
          FROM positions p
          JOIN signals s ON s.id = p.signal_id
          WHERE s.ticker = @ticker AND p.status = 'OPEN'
        )
      `,
      ).run({ ticker: params.ticker, factor: params.factor });

      db.prepare(
        `
        UPDATE signals
        SET
          price = ROUND(price / @factor, 4),
          atr14 = ROUND(atr14 / @factor, 4),
          initial_atr_stop = ROUND(initial_atr_stop / @factor, 4)
        WHERE id IN (
          SELECT p.signal_id
          FROM positions p
          JOIN signals s ON s.id = p.signal_id
          WHERE s.ticker = @ticker AND p.status = 'OPEN'
        )
      `,
      ).run({ ticker: params.ticker, factor: params.factor });

      const dailyPriceRows = adjustDailyPricesBeforeExDate(db, {
        ticker: params.ticker,
        exDate: params.exDate,
        factor: params.factor,
      });
      setPipelineState(db, splitDailyPricesPipelineKey(params.ticker, params.exDate), "1");
      cueLogger.info(
        `applySplit: adjusted daily_prices for ${params.ticker} ` +
          `factor=${params.factor} exDate=${params.exDate} ` +
          `rows=${dailyPriceRows}`,
      );
    },
  );

  for (const [ticker] of byTicker) {
    try {
      const result = await yf.chart(ticker, {
        period1,
        period2,
        interval: "1d",
        events: "split",
        return: "object",
      });

      const splits = extractSplitEvents(
        result.events?.splits as Record<string, SplitEventLike> | SplitEventLike[] | undefined,
      );

      if (splits.length === 0) {
        logger.debug(`[corporate-actions] No split events for ${ticker} in ${period1}..${period2}`);
        continue;
      }

      for (const event of splits) {
        const numerator = event.numerator;
        const denominator = event.denominator;
        if (
          typeof numerator !== "number" ||
          typeof denominator !== "number" ||
          !Number.isFinite(numerator) ||
          !Number.isFinite(denominator) ||
          denominator === 0
        ) {
          logger.warn(
            `[corporate-actions] Skipping malformed split for ${ticker}: numerator=${String(numerator)} denominator=${String(denominator)}`,
          );
          continue;
        }

        const factor = numerator / denominator;
        if (!(factor > 0) || factor === 1) {
          logger.warn(`[corporate-actions] Skipping no-op split for ${ticker}: factor=${factor}`);
          continue;
        }

        const exDate = formatIsoDateYmd(event.date);
        const type: CorporateActionType = factor >= 1 ? "split" : "reverse_split";

        const existing = existsStmt.get(ticker, exDate, type) as { id: number } | undefined;
        if (existing !== undefined) {
          logger.debug(
            `[corporate-actions] Already applied ${type} for ${ticker} ex_date=${exDate}; skipping`,
          );
          continue;
        }

        applySplit({ ticker, exDate, type, factor });
        logger.info(
          `[corporate-actions] Applied ${type} factor=${factor} to ${ticker} (ex_date=${exDate})`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[corporate-actions] Yahoo chart failed for ${ticker}: ${msg}`);
    }
  }
}
