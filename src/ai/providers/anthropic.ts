import axios from "axios";

import type { LLMMessage, LLMProvider } from "../types.js";
import { LLMHttpError } from "../types.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

export function createAnthropicProvider(apiKey: string): LLMProvider {
  return {
    name: "anthropic",
    async complete(messages: LLMMessage[], maxTokens: number): Promise<string> {
      const systemParts = messages.filter((m) => m.role === "system");
      const system = systemParts.map((m) => m.content).join("\n\n");
      const anthropicMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      try {
        const res = await axios.post<{ content: Array<{ type: string; text?: string }> }>(
          ANTHROPIC_URL,
          {
            model: MODEL,
            max_tokens: maxTokens,
            system: system.length > 0 ? system : undefined,
            messages: anthropicMessages,
          },
          {
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            timeout: 120_000,
            validateStatus: () => true,
          },
        );
        if (res.status < 200 || res.status >= 300) {
          const snippet = typeof res.data === "object" ? JSON.stringify(res.data).slice(0, 500) : String(res.data);
          throw new LLMHttpError(`Anthropic HTTP ${res.status}`, res.status, snippet);
        }
        const blocks = res.data.content ?? [];
        const text = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text!)
          .join("");
        return text;
      } catch (e) {
        if (e instanceof LLMHttpError) {
          throw e;
        }
        if (axios.isAxiosError(e) && e.response) {
          const snippet = JSON.stringify(e.response.data ?? {}).slice(0, 500);
          throw new LLMHttpError(`Anthropic HTTP ${e.response.status}`, e.response.status, snippet);
        }
        throw e;
      }
    },
  };
}
