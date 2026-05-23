import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLlmProvider, resetLlmProvider } from "../../src/llm/factory.js";
import { resetConfigCache } from "../../src/config/index.js";

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, savedEnv);
  resetConfigCache();
  resetLlmProvider();
}

function setProviderEnv(over: Record<string, string | undefined>): void {
  restoreEnv();
  Object.assign(process.env, {
    POLYGON_API_KEY: "pk",
    TELEGRAM_BOT_TOKEN: "tb",
    TELEGRAM_CHAT_ID: "tc",
    ...over,
  });
  resetConfigCache();
  resetLlmProvider();
}

afterEach(() => {
  restoreEnv();
});

describe("getLlmProvider", () => {
  beforeEach(() => {
    restoreEnv();
  });

  it("returns anthropic provider", () => {
    setProviderEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x" });
    expect(getLlmProvider().name).toBe("anthropic");
  });

  it("returns openai provider", () => {
    setProviderEnv({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "o",
    });
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();
    resetLlmProvider();
    expect(getLlmProvider().name).toBe("openai");
  });

  it("returns google-studio provider", () => {
    setProviderEnv({
      LLM_PROVIDER: "google-studio",
      GOOGLE_AI_API_KEY: "g",
    });
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();
    resetLlmProvider();
    expect(getLlmProvider().name).toBe("google-studio");
  });

  it("returns vertex provider", () => {
    setProviderEnv({
      LLM_PROVIDER: "vertex",
      VERTEX_PROJECT_ID: "test-project-123",
    });
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();
    resetLlmProvider();
    expect(getLlmProvider().name).toBe("vertex");
  });

  it("returns mock provider", () => {
    setProviderEnv({ LLM_PROVIDER: "mock" });
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();
    resetLlmProvider();
    expect(getLlmProvider().name).toBe("mock");
  });

  it("throws when vertex project id missing", () => {
    setProviderEnv({
      LLM_PROVIDER: "vertex",
      VERTEX_PROJECT_ID: "",
    });
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();
    resetLlmProvider();
    expect(() => getLlmProvider()).toThrow(/VERTEX_PROJECT_ID/);
  });

  it("throws when anthropic key missing", () => {
    setProviderEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" });
    expect(() => getLlmProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws when openai key missing", () => {
    setProviderEnv({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "",
    });
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();
    resetLlmProvider();
    expect(() => getLlmProvider()).toThrow(/OPENAI_API_KEY/);
  });
});
