-- Rebuild backtest_trades; CHECK adds REBALANCE_DROP (parity with positions, migration 006).
-- Ledger id = filename without `.sql` (`015_backtest_rebalance_drop`).

PRAGMA foreign_keys = OFF;

CREATE TABLE backtest_trades_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES backtest_runs(id),
  ticker      TEXT NOT NULL,
  entry_date  TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_date   TEXT NOT NULL,
  exit_price  REAL NOT NULL,
  pnl_pct     REAL,
  exit_reason TEXT CHECK(exit_reason IN (
                'TRAILING_STOP','INITIAL_STOP','TIME_EXIT',
                'MANUAL','REBALANCE_DROP'
              ))
);

INSERT INTO backtest_trades_new (
  id, run_id, ticker, entry_date, entry_price,
  exit_date, exit_price, pnl_pct, exit_reason
)
SELECT
  id, run_id, ticker, entry_date, entry_price,
  exit_date, exit_price, pnl_pct, exit_reason
FROM backtest_trades;

DROP TABLE backtest_trades;
ALTER TABLE backtest_trades_new RENAME TO backtest_trades;

CREATE INDEX IF NOT EXISTS idx_bt_trades_ticker
  ON backtest_trades(ticker);

CREATE INDEX IF NOT EXISTS idx_bt_trades_run
  ON backtest_trades(run_id);

PRAGMA foreign_keys = ON;
