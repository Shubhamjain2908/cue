import { getConfig } from "../config/index.js";
import type { LLMProvider } from "./types.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createGoogleProvider } from "./providers/google.js";
import { createOpenAiProvider } from "./providers/openai.js";
import { createVertexProvider } from "./providers/vertex.js";

export function createLlmProviderFromEnv(): LLMProvider {
  const c = getConfig();
  switch (c.LLM_PROVIDER) {
    case "anthropic":
      return createAnthropicProvider(c.ANTHROPIC_API_KEY!);
    case "openai":
      return createOpenAiProvider(c.OPENAI_API_KEY!);
    case "google":
      return createGoogleProvider(c.GOOGLE_AI_API_KEY!);
    case "vertex":
      return createVertexProvider({
        projectId: c.VERTEX_PROJECT_ID!,
        location: c.VERTEX_LOCATION,
        model: c.VERTEX_MODEL,
      });
    default: {
      const _exhaustive: never = c.LLM_PROVIDER;
      return _exhaustive;
    }
  }
}
