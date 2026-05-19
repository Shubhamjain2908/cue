import { describe, expect, it } from "vitest";

import { parseAlertModeFromArgv } from "../../src/alerts/telegram.js";

describe("parseAlertModeFromArgv", () => {
  it("defaults to rebalance when --mode is absent", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts"])).toBe("rebalance");
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

  it("defaults to rebalance when mode value is invalid", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode", "daily"])).toBe("rebalance");
  });

  it("defaults to rebalance when --mode has no following arg", () => {
    expect(parseAlertModeFromArgv(["node", "telegram.ts", "--mode"])).toBe("rebalance");
  });
});
