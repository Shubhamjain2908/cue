-- 014_enrichments_signal_id_unique.sql
-- One enrichment row per signal; enables INSERT OR IGNORE on stub writes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrichments_signal_id_unique
  ON enrichments(signal_id);
