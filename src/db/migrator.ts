import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CueDatabase } from "./provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrateTrackedResult {
  applied: string[];
  skipped: string[];
}

function ensureMigrationsTable(db: CueDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);
}

function listAppliedIds(db: CueDatabase): Set<string> {
  const rows = db.prepare(`SELECT id FROM _migrations ORDER BY id`).all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function columnExists(db: CueDatabase, table: "signals" | "positions", column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
  db: CueDatabase,
  table: "signals" | "positions",
  column: string,
  sqlType: string,
): void {
  if (columnExists(db, table, column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

/**
 * Rebuild `signals` with `signal_type` and UNIQUE (ticker, date, signal, signal_type).
 * Preserves row ids for enrichments / positions FKs.
 */
function rebuildSignalsWithSignalType(db: CueDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE signals_phase4 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      signal TEXT NOT NULL,
      signal_type TEXT NOT NULL DEFAULT 'MOMENTUM',
      price REAL NOT NULL,
      alerted INTEGER NOT NULL DEFAULT 0,
      momentum_rank INTEGER,
      universe_ranked_count INTEGER,
      momentum_12_1_return REAL,
      atr14 REAL,
      initial_atr_stop REAL,
      UNIQUE (ticker, date, signal, signal_type)
    );
    INSERT INTO signals_phase4 (
      id, ticker, date, signal, signal_type, price, alerted,
      momentum_rank, universe_ranked_count, momentum_12_1_return, atr14, initial_atr_stop
    )
    SELECT
      id, ticker, date, signal, 'MOMENTUM', price, alerted,
      momentum_rank, universe_ranked_count, momentum_12_1_return, atr14, initial_atr_stop
    FROM signals;
    DROP TABLE signals;
    ALTER TABLE signals_phase4 RENAME TO signals;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/** Idempotent Phase 4.0 DDL (positions columns, signals + fundamentals_cache). */
export function applyPhase4SchemaIfNeeded(db: CueDatabase): void {
  addColumnIfMissing(db, "positions", "highest_close_since_entry", "REAL");
  addColumnIfMissing(db, "positions", "current_stop_loss", "REAL");

  if (!columnExists(db, "signals", "signal_type")) {
    rebuildSignalsWithSignalType(db);
  }

  const sqlPath = path.join(__dirname, "migrations", "002_phase4_schema.sql");
  if (fs.existsSync(sqlPath)) {
    const sql = fs.readFileSync(sqlPath, "utf8");
    db.exec(sql);
  }
}

/**
 * Ledger-based migrations: `_migrations` + sorted `migrations/*.sql` after programmatic Phase 4.
 */
export function migrateTracked(db: CueDatabase): MigrateTrackedResult {
  ensureMigrationsTable(db);
  const appliedIds = listAppliedIds(db);
  const result: MigrateTrackedResult = { applied: [], skipped: [] };

  const phase4Id = "002_phase4_schema";
  if (appliedIds.has(phase4Id)) {
    result.skipped.push(phase4Id);
  } else {
    applyPhase4SchemaIfNeeded(db);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(phase4Id);
    result.applied.push(phase4Id);
  }

  const migrationsDir = path.join(__dirname, "migrations");
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return result;
  }

  const isApplied = (id: string): boolean =>
    Boolean(db.prepare(`SELECT 1 FROM _migrations WHERE id = ?`).get(id));

  for (const file of files) {
    const id = file.replace(/\.sql$/i, "");
    if (id === phase4Id) {
      continue;
    }
    if (isApplied(id)) {
      result.skipped.push(id);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(id);
    result.applied.push(id);
  }

  return result;
}
