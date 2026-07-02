/**
 * Entry fill restamp — align live position pricing with backtest simulation.
 *
 * # Problem
 * Live positions are entered at Friday close (the asOf date of the Sunday rebalance).
 * Backtest fills at the next-session open × 1.001 (slippage). This creates a P&L basis
 * mismatch: live shows gains/losses from Friday close, but the actual fill is Monday open.
 *
 * # Solution
 * After each ingest cycle, scan OPEN positions whose `entry_price` still matches the
 * signal close price (i.e., haven't been restamped yet). For each such position, find
 * the earliest daily bar after the entry date and restamp:
 *   - `entry_price` → bar.open (the tradeable fill)
 *   - `current_stop_loss` → bar.open − 4×ATR (only if no stop movement has occurred yet)
 */

import Database from "better-sqlite3";

import { DEFAULT_RANKING_CONFIG } from "../enrichers/momentum-types.js";
import { cueLogger } from "../cli/cue-logger.js";

type SqliteConnection = InstanceType<typeof Database>;

export interface RestampRow {
  positionId: number;
  ticker: string;
  entryDate: string;
  signalPrice: number;
  atr14: number | null;
}

/** True when at least one stop_movements row exists for a position. */
function hasStopMovements(db: SqliteConnection, positionId: number): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM stop_movements WHERE position_id = ?`)
    .get(positionId) as { c: number };
  return row.c > 0;
}

/**
 * Scan OPEN positions that haven't been restamped yet (`entry_price === signal.price`)
 * and restamp them to the earliest daily bar after the entry date.
 *
 * This is idempotent — once restamped, `entry_price !== signal.price` and subsequent
 * calls are no-ops.
 *
 * @returns Number of positions restamped.
 */
export function restampPendingEntryFills(db: SqliteConnection): number {
  const pending = db
    .prepare(
      `SELECT
        p.id AS positionId,
        sig.ticker AS ticker,
        p.entry_date AS entryDate,
        sig.price AS signalPrice,
        sig.atr14 AS atr14
      FROM positions p
      JOIN signals sig ON sig.id = p.signal_id
      WHERE p.status = 'OPEN'
        AND p.entry_price = sig.price      -- not yet restamped
        AND sig.ticker != 'QQQ'            -- QQQ is regime benchmark only
      ORDER BY p.id ASC`,
    )
    .all() as RestampRow[];

  if (pending.length === 0) {
    return 0;
  }

  let restamped = 0;

  for (const row of pending) {
    const nextBar = db
      .prepare(
        `SELECT date, open FROM daily_prices
         WHERE ticker = ? AND date > ?
         ORDER BY date ASC LIMIT 1`,
      )
      .get(row.ticker, row.entryDate) as { date: string; open: number } | undefined;

    if (!nextBar) {
      // No next bar available yet — position is freshly opened and the next
      // session hasn't been ingested. Skip; will restamp on a future cycle.
      continue;
    }

    const newEntryPrice = nextBar.open;
    const atrVal = row.atr14;

    // Re-seed stop only if no stop movement has ever occurred for this position.
    // This prevents lowering an already-ratcheted stop.
    const stopMoved = atrVal !== null ? hasStopMovements(db, row.positionId) : true;

    if (stopMoved) {
      // Entry-price only — stop is already managed by live trailing-stop replay.
      db.prepare(
        `UPDATE positions
         SET entry_price = ?
         WHERE id = ? AND status = 'OPEN' AND entry_price = ?`,
      ).run(newEntryPrice, row.positionId, row.signalPrice);
    } else {
      // No stop movements yet — re-seed both entry and stop.
      const newStop = newEntryPrice - DEFAULT_RANKING_CONFIG.atrMultiplierBase * atrVal!;
      db.prepare(
        `UPDATE positions
         SET entry_price = ?, current_stop_loss = ?
         WHERE id = ? AND status = 'OPEN' AND entry_price = ?`,
      ).run(newEntryPrice, newStop, row.positionId, row.signalPrice);
    }

    restamped += 1;
    cueLogger.debug(
      `restamp: ${row.ticker} pos=${row.positionId} ` +
        `${String(row.signalPrice)} → ${String(newEntryPrice)} ` +
        (atrVal !== null ? `stop=${String(stopMoved)}` : "stop=skip(no ATR)"),
    );
  }

  return restamped;
}

/** CLI entry: restamp pending entry fills. */
export async function runRestampEntryCli(): Promise<void> {
  const config = (await import("../config/index.js")).getConfig();
  const { openCueDb } = await import("../db/provider.js");
  const db = openCueDb(config.DB_PATH);
  try {
    const count = restampPendingEntryFills(db);
    cueLogger.info(`restamp: ${count} position(s) restamped`);
  } finally {
    db.close();
  }
}
