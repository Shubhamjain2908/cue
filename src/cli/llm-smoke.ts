import { z } from "zod";

import { getConfig } from "../config/index.js";
import { tryParseModelJson } from "../llm/prompt.js";
import { createLlmProviderFromEnv } from "../llm/provider.js";
import type { LLMMessage } from "../llm/types.js";

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${label} — ${Date.now() - t0}ms`);
    return r;
  } catch (err) {
    console.log(`✗ ${label} — ${Date.now() - t0}ms`);
    console.log(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function providerSummary(): string {
  const c = getConfig();
  if (c.LLM_PROVIDER === "vertex") {
    return `${c.LLM_PROVIDER} (model=${c.VERTEX_MODEL})`;
  }
  return c.LLM_PROVIDER;
}

/**
 * Live smoke test for the configured LLM: short text, small JSON schema, then a compact thesis JSON.
 */
export async function runLlmSmokeCli(): Promise<void> {
  const config = getConfig();
  const provider = createLlmProviderFromEnv();
  const maxTokens = config.LLM_MAX_TOKENS;

  console.log(`provider: ${provider.name} (${providerSummary()})`);

  await step("text", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "Reply with the single word: PONG" },
    ];
    const raw = await provider.complete(messages, 64);
    console.log(`  text: "${raw.trim()}"`);
  });

  await step("json", async () => {
    const Schema = z.object({
      sentiment: z.number().min(-1).max(1),
      rationale: z.string().min(1).max(280),
    });
    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          "You output JSON only. No markdown, no prose. Numbers must be in the requested range.",
      },
      {
        role: "user",
        content: `Score this headline for US large-cap sentiment.

Headline: "Apple reports record services revenue, tops estimates"

Return JSON: { "sentiment": <-1..1>, "rationale": "<short reason>" }`,
      },
    ];
    const raw = await provider.complete(messages, maxTokens);
    const data = Schema.parse(tryParseModelJson(raw));
    console.log(`  json: sentiment=${data.sentiment}, rationale="${data.rationale}"`);
  });

  await step("thesis", async () => {
    const Schema = z.object({
      action: z.enum(["BUY", "HOLD", "SELL"]),
      /** Models often emit 4+ bullets; accept extras and show the first three. */
      bullets: z.array(z.string()).min(3).max(12),
    });
    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          "You are a US equity research assistant. Output strict JSON only. Describe technical setups only; do not give individualized investment advice.",
      },
      {
        role: "user",
        content: `Analyse this setup.

Stock: AAPL
Close: 210
SMA50: 205
SMA200: 198
RSI 14: 58
Volume ratio (20d): 1.25

Return JSON: { "action": "BUY|HOLD|SELL", "bullets": ["...", "...", "..."] }
Use at least 3 bullet strings; prefer exactly 3.`,
      },
    ];
    const raw = await provider.complete(messages, maxTokens);
    const data = Schema.parse(tryParseModelJson(raw));
    const bullets = data.bullets.slice(0, 3);
    if (data.bullets.length > 3) {
      console.log(`  (truncated ${data.bullets.length} bullets → 3)`);
    }
    console.log(`  thesis: ${data.action}`);
    for (const b of bullets) {
      console.log(`    - ${b}`);
    }
  });

  console.log("\nLLM smoke test passed.");
}
