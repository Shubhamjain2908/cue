import { describe, expect, it } from "vitest";

import { previousWeekdayBeforeEtCivil } from "../../src/ingestors/massive-price-ingestor.js";

describe("previousWeekdayBeforeEtCivil", () => {
  it("maps Monday ET to the prior Friday session", () => {
    const now = new Date("2026-05-25T16:05:00-04:00");
    expect(previousWeekdayBeforeEtCivil(now)).toBe("2026-05-22");
  });

  it("maps Tuesday ET to the prior Monday session", () => {
    const now = new Date("2026-05-26T16:05:00-04:00");
    expect(previousWeekdayBeforeEtCivil(now)).toBe("2026-05-25");
  });

  it("maps Sunday ET civil date to the prior Friday session", () => {
    const now = new Date("2026-05-24T12:00:00-04:00");
    expect(previousWeekdayBeforeEtCivil(now)).toBe("2026-05-22");
  });
});
