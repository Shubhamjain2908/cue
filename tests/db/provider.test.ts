import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openCueDb, openCueDbReadonly } from "../../src/db/provider.js";

const tempDirs: string[] = [];

function tempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-provider-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("openCueDb pragmas", () => {
  it("sets WAL, busy_timeout, synchronous, cache, mmap, and temp_store", () => {
    const db = openCueDb(tempDbPath("pragmas.db"));
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
      // better-sqlite3 `simple: true` returns the integer code (1 = NORMAL).
      expect(db.pragma("synchronous", { simple: true })).toBe(1);
      expect(db.pragma("cache_size", { simple: true })).toBe(-64000);
      expect(db.pragma("mmap_size", { simple: true })).toBe(268435456);
      expect(db.pragma("temp_store", { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });

  it("allows concurrent read while another connection holds a write transaction (WAL)", () => {
    const dbPath = tempDbPath("wal-concurrent.db");
    const writer = openCueDb(dbPath);
    const reader = openCueDb(dbPath);

    try {
      writer.exec(`
        CREATE TABLE IF NOT EXISTS wal_probe (id INTEGER PRIMARY KEY, n INTEGER);
        INSERT INTO wal_probe (n) VALUES (1);
      `);
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO wal_probe (n) VALUES (2)").run();

      expect(() => reader.prepare("SELECT COUNT(*) AS c FROM wal_probe").get()).not.toThrow();
      const row = reader.prepare("SELECT COUNT(*) AS c FROM wal_probe").get() as { c: number };
      expect(row.c).toBeGreaterThanOrEqual(1);

      writer.exec("COMMIT");
    } finally {
      writer.close();
      reader.close();
    }
  });
});

describe("openCueDbReadonly", () => {
  it("sets busy_timeout on readonly connections", () => {
    const dbPath = tempDbPath("readonly-busy.db");
    const writer = openCueDb(dbPath);
    writer.close();

    const reader = openCueDbReadonly(dbPath);
    try {
      expect(reader.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      reader.close();
    }
  });
});

describe("openCueDbReadonly under WAL", () => {
  it("reader can query while writer transaction is open", () => {
    const dbPath = tempDbPath("wal-readonly.db");
    const writer = openCueDb(dbPath);
    const reader = new Database(dbPath, { readonly: true });
    reader.pragma("busy_timeout = 5000");

    try {
      writer.exec("CREATE TABLE IF NOT EXISTS ro_probe (v INTEGER); INSERT INTO ro_probe VALUES (1)");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO ro_probe VALUES (2)").run();

      expect(() => reader.prepare("SELECT COUNT(*) AS c FROM ro_probe").get()).not.toThrow();

      writer.exec("COMMIT");
    } finally {
      writer.close();
      reader.close();
    }
  });
});
