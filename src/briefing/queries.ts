import { getConfig } from "../config/index.js";
import { openCueDbReadonly } from "../db/provider.js";

export interface OpenPosition {
  ticker: string;
  entry_date: string;
  entry_price: number;
  /** Persisted entry-time ATR stop from the BUY signal (`signals.initial_atr_stop`). */
  current_stop_loss: number;
  highest_close_since_entry: number;
  momentum_rank: number | null;
  momentum_12_1_return: number | null;
  atr14: number | null;
  days_held: number;
}

export interface RecentSignal {
  ticker: string;
  signal_type: "BUY" | "SELL";
  signal_date: string;
  momentum_rank: number | null;
  momentum_12_1_return: number | null;
  sentiment: string | null;
  rationale: string | null;
  sector: string | null;
}

export interface BacktestSummary {
  run_date: string;
  cagr: number;
  sharpe: number;
  max_drawdown: number;
  expectancy: number;
  total_trades: number;
}

export interface DashboardPayload {
  generated_at: string;
  regime_active: boolean;
  open_positions: OpenPosition[];
  recent_signals: RecentSignal[];
  backtest_summary: BacktestSummary | null;
  sector_allocation: { sector: string; count: number }[];
}

interface BacktestRow {
  run_date: string;
  cagr: number;
  sharpe_ratio: number;
  max_drawdown: number;
  expectancy: number;
  total_trades: number;
}

interface RegimeRow {
  regime_active: number;
}

/**
 * Read-only snapshot of SQLite for dashboard embedding.
 * Column names follow UI contracts; `cagr` / `max_drawdown` / `expectancy` are **decimals** (e.g. 0.2139 = 21.39%).
 */
export function extractDashboardPayload(): DashboardPayload {
  const { DB_PATH } = getConfig();
  const db = openCueDbReadonly(DB_PATH);

  try {
    const open_positions = db
      .prepare(
        `
      SELECT
        sig.ticker AS ticker,
        p.entry_date AS entry_date,
        p.entry_price AS entry_price,
        sig.initial_atr_stop AS current_stop_loss,
        COALESCE(
          (
            SELECT MAX(dp.close)
            FROM daily_prices dp
            WHERE dp.ticker = sig.ticker AND dp.date >= p.entry_date
          ),
          p.entry_price
        ) AS highest_close_since_entry,
        sig.momentum_rank AS momentum_rank,
        sig.momentum_12_1_return AS momentum_12_1_return,
        sig.atr14 AS atr14,
        CAST(julianday('now') - julianday(p.entry_date) AS INTEGER) AS days_held
      FROM positions p
      INNER JOIN signals sig ON sig.id = p.signal_id
      WHERE p.status = 'OPEN'
      ORDER BY p.entry_date ASC
    `,
      )
      .all() as OpenPosition[];

    const recent_signals = db
      .prepare(
        `
      SELECT
        s.ticker AS ticker,
        s.signal AS signal_type,
        s.date AS signal_date,
        s.momentum_rank AS momentum_rank,
        s.momentum_12_1_return AS momentum_12_1_return,
        e.sentiment AS sentiment,
        e.rationale AS rationale,
        e.sector AS sector
      FROM signals s
      LEFT JOIN enrichments e ON e.signal_id = s.id
      WHERE s.signal IN ('BUY', 'SELL')
      ORDER BY s.date DESC
      LIMIT 20
    `,
      )
      .all() as RecentSignal[];

    const rawBacktest = db
      .prepare(
        `
      SELECT run_date, cagr, sharpe_ratio, max_drawdown, expectancy, total_trades
      FROM backtest_runs
      ORDER BY run_date DESC
      LIMIT 1
    `,
      )
      .get() as BacktestRow | undefined;

    let backtest_summary: BacktestSummary | null = null;
    if (rawBacktest) {
      backtest_summary = {
        run_date: rawBacktest.run_date,
        cagr: rawBacktest.cagr / 100,
        sharpe: rawBacktest.sharpe_ratio,
        max_drawdown: rawBacktest.max_drawdown / 100,
        expectancy: rawBacktest.expectancy / 100,
        total_trades: rawBacktest.total_trades,
      };
    }

    const regimeRow = db
      .prepare(
        `
      WITH qqq_prices AS (
        SELECT date, close
        FROM daily_prices
        WHERE ticker = 'QQQ'
        ORDER BY date DESC
        LIMIT 200
      ),
      latest AS (SELECT close FROM qqq_prices LIMIT 1),
      sma AS (SELECT AVG(close) AS sma200 FROM qqq_prices)
      SELECT CASE
        WHEN (SELECT close FROM latest) > (SELECT sma200 FROM sma) THEN 1
        ELSE 0
      END AS regime_active
    `,
      )
      .get() as RegimeRow | undefined;

    const sector_allocation = db
      .prepare(
        `
      SELECT e.sector AS sector, COUNT(*) AS count
      FROM positions p
      INNER JOIN signals sig ON sig.id = p.signal_id
      INNER JOIN enrichments e ON e.signal_id = sig.id
      WHERE p.status = 'OPEN' AND e.sector IS NOT NULL AND e.sector != ''
      GROUP BY e.sector
      ORDER BY count DESC
    `,
      )
      .all() as { sector: string; count: number }[];

    return {
      generated_at: new Date().toISOString(),
      regime_active: (regimeRow?.regime_active ?? 0) === 1,
      open_positions,
      recent_signals,
      backtest_summary,
      sector_allocation,
    };
  } finally {
    db.close();
  }
}
