import axios from "axios";

import type { LLMMessage, LLMProvider } from "../types.js";
import { LLMHttpError } from "../types.js";

const GOOGLE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

export function createGoogleProvider(apiKey: string): LLMProvider {
  return {
    name: "google",
    async complete(messages: LLMMessage[], maxTokens: number): Promise<string> {
      const systemParts = messages.filter((m) => m.role === "system");
      const systemText = systemParts.map((m) => m.content).join("\n\n");
      const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
        },
      };
      if (systemText.length > 0) {
        body.systemInstruction = { parts: [{ text: systemText }] };
      }
      try {
        const res = await axios.post<{
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        }>(GOOGLE_URL, body, {
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          timeout: 120_000,
          validateStatus: () => true,
        });
        if (res.status < 200 || res.status >= 300) {
          const snippet = typeof res.data === "object" ? JSON.stringify(res.data).slice(0, 500) : String(res.data);
          throw new LLMHttpError(`Google HTTP ${res.status}`, res.status, snippet);
        }
        const parts = res.data.candidates?.[0]?.content?.parts ?? [];
        return parts.map((p) => p.text ?? "").join("");
      } catch (e) {
        if (e instanceof LLMHttpError) {
          throw e;
        }
        if (axios.isAxiosError(e) && e.response) {
          const snippet = JSON.stringify(e.response.data ?? {}).slice(0, 500);
          throw new LLMHttpError(`Google HTTP ${e.response.status}`, e.response.status, snippet);
        }
        throw e;
      }
    },
  };
}
