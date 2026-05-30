-- P7-H / P7-F: append-only position audit tables (stop ladder mutations + thesis notes).
-- Ledger id = filename without `.sql` (`011_position_audit`).
--
-- INTENTIONAL: foreign keys to `positions.id` omit ON DELETE CASCADE.
-- Positions are never deleted — this is an immutable audit ledger. Do not add CASCADE.

CREATE TABLE IF NOT EXISTS stop_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id     INTEGER NOT NULL REFERENCES positions (id),
  as_of_date      TEXT    NOT NULL,
  previous_stop   REAL    NOT NULL,
  new_stop        REAL    NOT NULL,
  previous_high   REAL    NOT NULL,
  new_high        REAL    NOT NULL,
  stop_regime     TEXT    NOT NULL CHECK (stop_regime IN ('BASE', 'TIGHT')),
  close_price     REAL    NOT NULL,
  atr14           REAL    NOT NULL,
  recorded_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (position_id, as_of_date)
);

CREATE TABLE IF NOT EXISTS position_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id     INTEGER NOT NULL REFERENCES positions (id),
  note_type       TEXT    NOT NULL CHECK (note_type IN ('ENTRY_THESIS', 'REFRESH_THESIS', 'OPERATOR_NOTE')),
  content         TEXT    NOT NULL,
  as_of_date      TEXT    NOT NULL,
  recorded_at     TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
