/**
 * Migration runner: ensures `_migrations`, then runs each `*.sql` in this directory **in
 * lexicographic (filename) order**, skipping any stem already present in the ledger
 * (`id` = filename without `.sql`). After a file executes successfully, the runner inserts
 * that `id` into `_migrations` — **do not** `INSERT INTO _migrations` from inside `.sql` files
 * (duplicate key). All DDL/DML lives in the `.sql` files; idempotency on re-run is ledger-based.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { getConfig } from "../../config/index.js";
import type { CueDatabase } from "../provider.js";

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

function listSqlFiles(): string[] {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply every `*.sql` in `src/db/migrations/` that is not yet recorded in `_migrations`. */
export function migrateTracked(db: CueDatabase): MigrateTrackedResult {
  ensureMigrationsTable(db);
  const result: MigrateTrackedResult = { applied: [], skipped: [] };

  const isApplied = (id: string): boolean =>
    Boolean(db.prepare(`SELECT 1 FROM _migrations WHERE id = ?`).get(id));

  for (const file of listSqlFiles()) {
    const id = file.replace(/\.sql$/i, "");
    if (isApplied(id)) {
      result.skipped.push(id);
      continue;
    }
    const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(id);
    result.applied.push(id);
  }

  return result;
}

/** Open / upgrade DB: run all pending SQL migrations. */
export function initSchema(db: CueDatabase): MigrateTrackedResult {
  return migrateTracked(db);
}

/** `pnpm run db:init` — create DB file and apply migrations. */
export function runDbInitFromConfig(): void {
  const config = getConfig();
  const dbDir = path.dirname(config.DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(config.DB_PATH);
  try {
    initSchema(db);
  } finally {
    db.close();
  }
}
