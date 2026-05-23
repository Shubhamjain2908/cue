import { afterEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn().mockResolvedValue({
  text: "ok",
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
  candidates: [{ finishReason: "STOP" }],
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent },
  })),
}));

import { resetConfigCache } from "../../../src/config/index.js";
import { GoogleStudioProvider } from "../../../src/llm/providers/google-studio.js";

const saved = { ...process.env };

afterEach(() => {
  Object.assign(process.env, saved);
  resetConfigCache();
  vi.clearAllMocks();
});

describe("GoogleStudioProvider", () => {
  it("generateText calls Gemini with system instruction", async () => {
    process.env.POLYGON_API_KEY = "p";
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID = "c";
    process.env.LLM_PROVIDER = "google-studio";
    process.env.GOOGLE_AI_API_KEY = "gemini-key";
    resetConfigCache();

    const p = new GoogleStudioProvider();
    const out = await p.generateText({
      system: "You are a bot",
      user: "hello",
      maxOutputTokens: 200,
    });
    expect(out.text).toBe("ok");
    expect(generateContent).toHaveBeenCalled();
    const call = generateContent.mock.calls[0]![0] as {
      config?: { systemInstruction?: string };
    };
    expect(call.config?.systemInstruction).toBe("You are a bot");
  });
});
