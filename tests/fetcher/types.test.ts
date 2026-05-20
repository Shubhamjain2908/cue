import { describe, expect, it } from "vitest";

import {
  massiveGroupedResponseSchema,
  massiveStocksAggregatesResponseSchema,
} from "../../src/ingestors/types.js";

/** Representative Massive v2 aggs JSON (includes `next_url` + optional `count`). */
const sampleAggregatesResponse = {
  adjusted: true,
  count: 2,
  next_url:
    "https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw",
  queryCount: 2,
  request_id: "6a7e466379af0a71039d60cc78e72282",
  results: [
    {
      c: 75.0875,
      h: 75.15,
      l: 73.7975,
      n: 1,
      o: 74.06,
      t: 1577941200000,
      v: 135647456,
      vw: 74.6099,
    },
    {
      c: 74.3575,
      h: 75.145,
      l: 74.125,
      n: 1,
      o: 74.2875,
      t: 1578027600000,
      v: 146535512,
      vw: 74.7026,
    },
  ],
  resultsCount: 2,
  status: "OK",
  ticker: "AAPL",
} as const;

const sampleGroupedResponse = {
  queryCount: 11630,
  resultsCount: 11630,
  adjusted: true,
  results: [
    {
      T: "RSPN",
      v: 219346,
      vw: 55.5793,
      o: 55.86,
      c: 55.58,
      h: 55.86,
      l: 55.2,
      t: 1762203600000,
      n: 384,
    },
  ],
  status: "OK",
  request_id: "0a618fcaeb9c3ddd770ca89e03958d63",
  count: 11630,
} as const;

describe("fetcher types", () => {
  it("parses Massive grouped daily sample response", () => {
    const parsed = massiveGroupedResponseSchema.safeParse(sampleGroupedResponse);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("OK");
      expect(parsed.data.results).toHaveLength(1);
      expect(parsed.data.results[0]?.T).toBe("RSPN");
      expect(parsed.data.results[0]?.o).toBe(55.86);
    }
  });

  it("parses Massive stocks aggregates sample response", () => {
    const parsed = massiveStocksAggregatesResponseSchema.safeParse(
      sampleAggregatesResponse,
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("OK");
      expect(parsed.data.ticker).toBe("AAPL");
      expect(parsed.data.request_id).toBe("6a7e466379af0a71039d60cc78e72282");
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results).toHaveLength(2);
      expect(parsed.data.results?.[0]?.t).toBe(1577941200000);
      expect(parsed.data.results?.[0]?.vw).toBe(74.6099);
    }
  });

  it("parses aggregate bar with scientific-notation volume (Massive REST)", () => {
    const row = {
      v: 5.0194583e7,
      vw: 268.2996,
      o: 270.42,
      c: 269.05,
      h: 270.85,
      l: 266.25,
      t: 1762146000000,
      n: 731851,
    };
    const parsed = massiveStocksAggregatesResponseSchema.safeParse({
      ticker: "AAPL",
      status: "OK",
      results: [row],
    });
    expect(parsed.success).toBe(true);
  });
});
