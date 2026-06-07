-- Track the latest rebalance rank for open positions.
-- Ledger id = filename without `.sql` (`017_positions_current_rank`).

ALTER TABLE positions ADD COLUMN current_rank INTEGER;
