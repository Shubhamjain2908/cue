import { describe, expect, it } from "vitest";

import { parseAlertModeFromArgv } from "../../src/alerts/telegram.js";

describe("parseAlertModeFromArgv", () => {
  it("throws when --mode is absent", () => {
    expect(() => parseAlertModeFromArgv(["node", "telegram.ts"])).toThrow(/missing or empty --mode/);
  });

  it("parses --mode stop", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "stop"])).toBe("stop");
  });

  it("parses --mode rebalance", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "rebalance"])).toBe("rebalance");
  });

  it("is case-insensitive for mode value", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "STOP"])).toBe("stop");
  });

  it("throws when mode value is invalid", () => {
    expect(() => parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "daily"])).toThrow(/invalid --mode/);
  });

  it("throws when --mode has no following arg", () => {
    expect(() => parseAlertModeFromArgv(["node", "telegram.ts", "--mode"])).toThrow(/missing or empty --mode/);
  });
});
