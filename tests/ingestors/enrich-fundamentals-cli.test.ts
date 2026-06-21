import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { selectFundamentalsBatchTickers } from "../../src/db/queries.js";
import { initSchema } from "../../src/db/schema.js";

function openMemoryDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function seedFundamentalsCache(db: InstanceType<typeof Database>, ticker: string, asOfDate: string): void {
  db.prepare(
    `INSERT INTO fundamentals_cache (ticker, as_of_date, payload_json) VALUES (?, ?, '{}')`,
  ).run(ticker, asOfDate);
}

const UNIVERSE = ["AAPL", "AMAT", "AMGN", "CMCSA", "INTC", "KLAC"] as const;
const AS_OF = "2026-06-07";

describe("selectFundamentalsBatchTickers", () => {
  it("returns the first N tickers when none are cached for as_of_date", () => {
    const db = openMemoryDb();
    expect(selectFundamentalsBatchTickers(UNIVERSE, AS_OF, 3, db)).toEqual(["AAPL", "AMAT", "AMGN"]);
    db.close();
  });

  it("skips tickers already cached for as_of_date and advances to the next names", () => {
    const db = openMemoryDb();
    for (const ticker of ["AAPL", "AMAT", "AMGN"]) {
      seedFundamentalsCache(db, ticker, AS_OF);
    }

    expect(selectFundamentalsBatchTickers(UNIVERSE, AS_OF, 3, db)).toEqual(["CMCSA", "INTC", "KLAC"]);
    db.close();
  });

  it("treats stale rows for a prior as_of_date as missing for today", () => {
    const db = openMemoryDb();
    seedFundamentalsCache(db, "AAPL", "2026-06-06");

    expect(selectFundamentalsBatchTickers(["AAPL", "AMAT"], AS_OF, 2, db)).toEqual(["AAPL", "AMAT"]);
    db.close();
  });

  it("returns an empty batch when every ticker is already cached for as_of_date", () => {
    const db = openMemoryDb();
    for (const ticker of UNIVERSE) {
      seedFundamentalsCache(db, ticker, AS_OF);
    }

    expect(selectFundamentalsBatchTickers(UNIVERSE, AS_OF, 3, db)).toEqual([]);
    db.close();
  });
});
