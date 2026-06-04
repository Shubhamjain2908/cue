-- 013_enrichment_status.sql
-- Adds status column to enrichments. Backfills all existing rows to 'OK'.
-- Requires SQLite >= 3.25 (Oracle Cloud Ubuntu 24 ships 3.45 — safe).

ALTER TABLE enrichments
  ADD COLUMN status TEXT NOT NULL DEFAULT 'OK'
    CHECK(status IN ('OK', 'LLM_FAIL', 'TIMEOUT', 'SCHEMA_FAIL', 'YAHOO_FAIL'));
