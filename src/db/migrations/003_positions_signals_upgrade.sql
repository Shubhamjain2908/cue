-- Phase 4 Task 4.0: S1 trailing-stop columns on `positions` + S2 composite unique on `signals`.
-- Ledger id = filename without `.sql` (`003_positions_signals_upgrade`). Runner records `_migrations`.
--
-- SQLite cannot change UNIQUE constraints in place; `signals` is rebuilt with FK checks disabled.
-- PRAGMA foreign_keys must be toggled outside an active transaction (see sqlite.org/foreignkeys.html).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE TRANSACTION;

UPDATE positions
SET
  highest_close_since_entry = entry_price,
  current_stop_loss = (
    SELECT s.initial_atr_stop
    FROM signals s
    WHERE s.id = positions.signal_id
  )
WHERE status = 'OPEN';

-- S2: preserve `id` values so `enrichments` / `positions` FKs remain valid.
DROP TABLE IF EXISTS signals_dg_tmp;
DROP INDEX IF EXISTS uk_signals_composite;

CREATE TABLE signals_dg_tmp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  signal TEXT NOT NULL,
  signal_type TEXT NOT NULL DEFAULT 'MOMENTUM',
  price REAL NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  momentum_rank INTEGER,
  universe_ranked_count INTEGER,
  momentum_12_1_return REAL,
  atr14 REAL,
  initial_atr_stop REAL,
  CONSTRAINT uk_signals_composite UNIQUE (ticker, date, signal, signal_type)
);

INSERT INTO signals_dg_tmp (
  id,
  ticker,
  date,
  signal,
  signal_type,
  price,
  alerted,
  momentum_rank,
  universe_ranked_count,
  momentum_12_1_return,
  atr14,
  initial_atr_stop
)
SELECT
  id,
  ticker,
  date,
  signal,
  COALESCE(signal_type, 'MOMENTUM'),
  price,
  alerted,
  momentum_rank,
  universe_ranked_count,
  momentum_12_1_return,
  atr14,
  initial_atr_stop
FROM signals;

DROP TABLE signals;
ALTER TABLE signals_dg_tmp RENAME TO signals;

COMMIT;

PRAGMA foreign_keys = ON;
