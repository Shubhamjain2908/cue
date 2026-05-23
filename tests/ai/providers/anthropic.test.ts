import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn().mockResolvedValue({
    model: "claude-test",
    content: [{ type: "text", text: '{"sentiment":"NEUTRAL"}' }],
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create },
    })),
  };
});

import { resetConfigCache } from "../../../src/config/index.js";
import { AnthropicProvider } from "../../../src/llm/providers/anthropic.js";

const saved = { ...process.env };

afterEach(() => {
  Object.assign(process.env, saved);
  resetConfigCache();
  vi.clearAllMocks();
});

describe("AnthropicProvider", () => {
  it("generateText returns concatenated text blocks", async () => {
    process.env.POLYGON_API_KEY = "p";
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "c";
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "key";
    resetConfigCache();

    const p = new AnthropicProvider();
    const out = await p.generateText({
      system: "sys",
      user: "hi",
      maxOutputTokens: 100,
    });
    expect(out.text).toBe('{"sentiment":"NEUTRAL"}');
    expect(out.model).toBe("claude-test");
  });
});
