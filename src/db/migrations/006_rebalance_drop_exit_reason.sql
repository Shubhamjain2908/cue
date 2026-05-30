-- First-class REBALANCE_DROP on live `positions`; reclassify flat same-day rotation exits.
-- Ledger id = filename without `.sql` (`006_rebalance_drop_exit_reason`).

BEGIN TRANSACTION;

CREATE TABLE positions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  status TEXT NOT NULL,
  exit_date TEXT,
  exit_price REAL,
  highest_close_since_entry REAL,
  current_stop_loss REAL,
  pnl_pct REAL,
  exit_reason TEXT CHECK(exit_reason IN (
    'TRAILING_STOP','INITIAL_STOP','TIME_EXIT','MANUAL','REBALANCE_DROP'
  ))
);

INSERT INTO positions_new SELECT * FROM positions;

UPDATE positions_new
SET exit_reason = 'REBALANCE_DROP'
WHERE exit_reason = 'MANUAL'
  AND exit_price = entry_price
  AND exit_date = entry_date;

DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;

COMMIT;
