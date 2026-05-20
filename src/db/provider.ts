import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { initSchema } from "./schema.js";

export type CueDatabase = InstanceType<typeof Database>;

export function resolveDbPath(dbPath: string): string {
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
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
  initSchema(db);
  return db;
}

/** Read-only handle for reporting / briefing queries (no schema writes). */
export function openCueDbReadonly(dbPath: string): CueDatabase {
  const resolved = resolveDbPath(dbPath);
  return new Database(resolved, { readonly: true });
}
