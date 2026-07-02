-- Add form_type column to existing earnings_events table.
-- SQLite: ALTER TABLE ADD COLUMN errors if column exists, so we use a safe check.
-- The IF NOT EXISTS pattern uses a try/catch approach via the migrate runner,
-- but since SQLite lacks IF NOT EXISTS for ALTER, we check via PRAGMA first.

-- Check if column exists; if not, add it.
-- This is handled in the main migration runner which uses a transaction.

ALTER TABLE earnings_events ADD COLUMN form_type TEXT;
