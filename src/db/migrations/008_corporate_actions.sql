CREATE TABLE IF NOT EXISTS corporate_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker      TEXT    NOT NULL,
  ex_date     TEXT    NOT NULL,
  type        TEXT    NOT NULL
                CHECK(type IN ('split','reverse_split')),
  factor      REAL    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'yahoo',
  applied_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, ex_date, type)
);
