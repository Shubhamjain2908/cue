-- Earnings events for research: historical earnings report dates by ticker.
-- Populated by earnings-ingestor from Yahoo Finance quoteSummary('earnings').
-- Used by earnings-blackout veto research (Task 8) to test if skipping buys
-- near earnings report dates improves strategy performance.

CREATE TABLE IF NOT EXISTS earnings_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker        TEXT    NOT NULL,
  report_date   TEXT    NOT NULL,
  fiscal_quarter TEXT,
  eps_actual    REAL,
  eps_estimate  REAL,
  surprise_pct  REAL,
  source        TEXT    NOT NULL DEFAULT 'yahoo',
  fetched_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, report_date)
);

CREATE INDEX IF NOT EXISTS idx_earnings_events_ticker
  ON earnings_events(ticker);

CREATE INDEX IF NOT EXISTS idx_earnings_events_report_date
  ON earnings_events(report_date);
