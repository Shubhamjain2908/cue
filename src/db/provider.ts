import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { cueLogger } from "../cli/cue-logger.js";
import { initSchema } from "./schema.js";

export type CueDatabase = InstanceType<typeof Database>;

export function resolveDbPath(dbPath: string): string {
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
}

/** WAL, busy_timeout, and read-path tuning — every read-write connection. */
function applySqlitePragmas(db: CueDatabase): void {
  const jm = db.pragma("journal_mode = WAL", { simple: true }) as string;
  if (jm !== "wal") {
    cueLogger.warn(
      `openCueDb: journal_mode is '${jm}' — WAL not supported on this filesystem. ` +
        "Concurrent read/write contention is possible.",
    );
  }

  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
}

/**
 * Opens the Cue SQLite database (read-write), ensures parent dirs exist,
 * enables foreign keys, and applies `initSchema` idempotently.
 */
export function openCueDb(dbPath: string): CueDatabase {
  const resolved = resolveDbPath(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("foreign_keys = ON");
  applySqlitePragmas(db);
  initSchema(db);
  return db;
}

/** Read-only handle for reporting / briefing queries (no schema writes). */
export function openCueDbReadonly(dbPath: string): CueDatabase {
  const resolved = resolveDbPath(dbPath);
  return new Database(resolved, { readonly: true });
}
