-- Align live `positions` with `backtest_trades` exit columns (pnl_pct, exit_reason).
-- Ledger id = filename without `.sql` (`005_positions_pnl_exit_reason`).

BEGIN TRANSACTION;

ALTER TABLE positions ADD COLUMN pnl_pct REAL;
ALTER TABLE positions ADD COLUMN exit_reason TEXT
  CHECK(exit_reason IN ('TRAILING_STOP','INITIAL_STOP','TIME_EXIT','MANUAL'));

UPDATE positions
SET pnl_pct = ROUND((exit_price - entry_price) / entry_price * 100, 4)
WHERE status != 'OPEN'
  AND exit_price IS NOT NULL
  AND exit_price > 0
  AND pnl_pct IS NULL;

UPDATE positions
SET exit_reason = 'MANUAL'
WHERE status != 'OPEN'
  AND exit_reason IS NULL;

COMMIT;
