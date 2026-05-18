import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGoogleProvider } from "../../../src/ai/providers/google.js";

describe("createGoogleProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps assistant to model role and uses systemInstruction", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    });
    const p = createGoogleProvider("gemini-key");
    await p.complete(
      [
        { role: "system", content: "You are a bot" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "prev" },
      ],
      200,
    );
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0]![1] as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(body.systemInstruction?.parts[0]?.text).toBe("You are a bot");
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model"]);
    const cfg = post.mock.calls[0]![2] as { headers: Record<string, string> };
    expect(cfg.headers["x-goog-api-key"]).toBe("gemini-key");
  });
});
