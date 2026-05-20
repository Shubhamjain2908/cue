import { describe, expect, it } from "vitest";

import { parseOptionalYmdFromArgv, parseYmd } from "../../src/cli/ymd-arg.js";

describe("ymd-arg", () => {
  it("parseYmd accepts valid calendar day", () => {
    expect(parseYmd("2026-05-20")).toBe("2026-05-20");
  });

  it("parseYmd rejects impossible dates", () => {
    expect(() => parseYmd("2026-02-31")).toThrow(/not a valid calendar day/);
  });

  it("parseOptionalYmdFromArgv returns undefined when flag absent", () => {
    expect(parseOptionalYmdFromArgv(["screen", "--force-rebalance"], "--date")).toBeUndefined();
  });

  it("parseOptionalYmdFromArgv reads --date value", () => {
    expect(parseOptionalYmdFromArgv(["--date", "2026-01-02", "x"], "--date")).toBe("2026-01-02");
  });

  it("parseOptionalYmdFromArgv throws when flag has no value", () => {
    expect(() => parseOptionalYmdFromArgv(["--date"], "--date")).toThrow(/Missing value/);
  });
});
