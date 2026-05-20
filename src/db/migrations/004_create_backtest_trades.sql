BEGIN TRANSACTION;

CREATE TABLE backtest_trades (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES backtest_runs(rowid),
    ticker      TEXT NOT NULL,
    entry_date  TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_date   TEXT,
    exit_price  REAL,
    pnl_pct     REAL,
    exit_reason TEXT CHECK(exit_reason IN (
                    'TRAILING_STOP','INITIAL_STOP','TIME_EXIT','MANUAL'
                )),
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bt_trades_ticker ON backtest_trades(ticker, entry_date);
CREATE INDEX idx_bt_trades_run    ON backtest_trades(run_id);

COMMIT;