-- 016_signals_alerted_at.sql
-- Alert audit timestamp; written by markSignalAlerted / markWatchlistSignalsAlerted.
ALTER TABLE signals ADD COLUMN alerted_at TEXT;
