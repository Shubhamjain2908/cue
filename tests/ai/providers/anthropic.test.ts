import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnthropicProvider } from "../../../src/llm/providers/anthropic.js";

describe("createAnthropicProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to Anthropic messages and returns concatenated text", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: {
        content: [{ type: "text", text: '{"sentiment":"NEUTRAL"}' }],
      },
    });
    const p = createAnthropicProvider("key");
    const out = await p.complete(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      100,
    );
    expect(out).toBe('{"sentiment":"NEUTRAL"}');
    expect(post).toHaveBeenCalledTimes(1);
    const url = post.mock.calls[0]![0] as string;
    expect(url).toContain("api.anthropic.com");
    const cfg = post.mock.calls[0]![2] as { headers: Record<string, string> };
    expect(cfg.headers["x-api-key"]).toBe("key");
    expect(cfg.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("throws LLMHttpError on non-2xx", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 401,
      data: { error: "bad" },
    });
    const p = createAnthropicProvider("key");
    await expect(p.complete([{ role: "user", content: "x" }], 50)).rejects.toThrow(/Anthropic HTTP 401/);
  });
});
