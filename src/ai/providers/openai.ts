import axios from "axios";

import type { LLMMessage, LLMProvider } from "../types.js";
import { LLMHttpError } from "../types.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export function createOpenAiProvider(apiKey: string): LLMProvider {
  return {
    name: "openai",
    async complete(messages: LLMMessage[], maxTokens: number): Promise<string> {
      const chatMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      try {
        const res = await axios.post<{
          choices?: Array<{ message?: { content?: string } }>;
        }>(
          OPENAI_URL,
          {
            model: MODEL,
            max_tokens: maxTokens,
            messages: chatMessages,
          },
          {
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            timeout: 120_000,
            validateStatus: () => true,
          },
        );
        if (res.status < 200 || res.status >= 300) {
          const snippet = typeof res.data === "object" ? JSON.stringify(res.data).slice(0, 500) : String(res.data);
          throw new LLMHttpError(`OpenAI HTTP ${res.status}`, res.status, snippet);
        }
        const text = res.data.choices?.[0]?.message?.content ?? "";
        return text;
      } catch (e) {
        if (e instanceof LLMHttpError) {
          throw e;
        }
        if (axios.isAxiosError(e) && e.response) {
          const snippet = JSON.stringify(e.response.data ?? {}).slice(0, 500);
          throw new LLMHttpError(`OpenAI HTTP ${e.response.status}`, e.response.status, snippet);
        }
        throw e;
      }
    },
  };
}
