import { getConfig } from "../config/index.js";
import type { LLMProvider } from "./types.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createGoogleProvider } from "./providers/google.js";
import { createOpenAiProvider } from "./providers/openai.js";

export function createLlmProviderFromEnv(): LLMProvider {
  const c = getConfig();
  switch (c.LLM_PROVIDER) {
    case "anthropic":
      return createAnthropicProvider(c.ANTHROPIC_API_KEY!);
    case "openai":
      return createOpenAiProvider(c.OPENAI_API_KEY!);
    case "google":
      return createGoogleProvider(c.GOOGLE_AI_API_KEY!);
    default: {
      const _exhaustive: never = c.LLM_PROVIDER;
      return _exhaustive;
    }
  }
}
