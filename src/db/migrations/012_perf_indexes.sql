-- 012_perf_indexes.sql
-- Additive indexes only. No table rebuilds. Safe to roll back via DROP INDEX.

CREATE INDEX IF NOT EXISTS idx_signals_date_signal
  ON signals(date, signal);

CREATE INDEX IF NOT EXISTS idx_signals_signal_alerted
  ON signals(signal, alerted);

CREATE INDEX IF NOT EXISTS idx_enrichments_signal_id
  ON enrichments(signal_id);

CREATE INDEX IF NOT EXISTS idx_positions_status
  ON positions(status);

CREATE INDEX IF NOT EXISTS idx_positions_status_reason
  ON positions(status, exit_reason);

CREATE INDEX IF NOT EXISTS idx_daily_prices_date
  ON daily_prices(date);

CREATE INDEX IF NOT EXISTS idx_stop_movements_pos_date_desc
  ON stop_movements(position_id, as_of_date DESC);
