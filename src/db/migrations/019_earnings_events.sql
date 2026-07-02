-- Earnings events for research: historical earnings report dates by ticker.
-- Populated by SEC EDGAR submissions API (10-K and 10-Q filing dates).
-- Also accepts Yahoo Finance data as fallback (source='yahoo').
-- Used by earnings-blackout veto research (Task 8).

CREATE TABLE IF NOT EXISTS earnings_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker        TEXT    NOT NULL,
  report_date   TEXT    NOT NULL,
  fiscal_quarter TEXT,
  eps_actual    REAL,
  eps_estimate  REAL,
  surprise_pct  REAL,
  form_type     TEXT,  -- '10-K', '10-Q', or 'yahoo'
  source        TEXT    NOT NULL DEFAULT 'sec_edgar',
  fetched_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, report_date)
);

CREATE INDEX IF NOT EXISTS idx_earnings_events_ticker
  ON earnings_events(ticker);

CREATE INDEX IF NOT EXISTS idx_earnings_events_report_date
  ON earnings_events(report_date);
