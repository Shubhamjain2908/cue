import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  tryLoadUniverseMeta,
  universeMetaMatchesTickerCount,
  universeTickersFileSchema,
} from "../../src/universe/load-universe.js";

describe("universe files", () => {
  it("parses nasdaq100.json with unique uppercased symbols", () => {
    const raw = fs.readFileSync("data/universe/nasdaq100.json", "utf8");
    const p = universeTickersFileSchema.safeParse(JSON.parse(raw) as unknown);
    expect(p.success).toBe(true);
    if (!p.success) {
      return;
    }
    const upper = p.data.tickers.map((t) => t.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
    expect(upper.length).toBe(101);
  });

  it("parses _meta.json and total_ticker_count matches universe file length", () => {
    const meta = tryLoadUniverseMeta();
    expect(meta).not.toBeNull();
    const raw = fs.readFileSync("data/universe/nasdaq100.json", "utf8");
    const n = universeTickersFileSchema.parse(JSON.parse(raw) as unknown).tickers.length;
    expect(meta!.total_ticker_count).toBe(n);
    expect(universeMetaMatchesTickerCount(meta!, n)).toBe(true);
    expect(meta!.system_additions).toContain("QQQ");
  });
});
