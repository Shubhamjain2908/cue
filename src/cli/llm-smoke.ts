import { z } from "zod";

import { getConfig } from "../config/index.js";
import { getLlmProvider } from "../llm/factory.js";

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
  const llm = getLlmProvider();
  switch (c.LLM_PROVIDER) {
    case "vertex":
      return `${llm.name} model=${c.VERTEX_MODEL} project=${c.VERTEX_PROJECT_ID}`;
    case "openai":
      return `${llm.name} model=${c.OPENAI_MODEL} base=${c.OPENAI_BASE_URL}`;
    case "anthropic":
      return `${llm.name} model=${c.ANTHROPIC_MODEL}`;
    case "google-studio":
      return `${llm.name} model=${c.GOOGLE_AI_MODEL}`;
    case "cursor-agent":
      return `${llm.name} model=${c.CURSOR_AGENT_MODEL} bin=${c.CURSOR_AGENT_BIN}`;
    default:
      return `${llm.name} model=${llm.model}`;
  }
}

/**
 * Live smoke test for the configured LLM: short text, small JSON schema, then a compact thesis JSON.
 */
export async function runLlmSmokeCli(): Promise<void> {
  const config = getConfig();
  const llm = getLlmProvider();

  console.log(`provider: ${providerSummary()}`);

  await step("text", async () => {
    const res = await llm.generateText({
      system: "You are a concise assistant.",
      user: "Reply with the single word: PONG",
      maxOutputTokens: 64,
    });
    console.log(`  text: "${res.text.trim()}"`);
  });

  await step("json", async () => {
    const Schema = z.object({
      sentiment: z.number().min(-1).max(1),
      rationale: z.string().min(1).max(280),
    });
    const res = await llm.generateJson({
      system:
        "You output JSON only. No markdown, no prose. Numbers must be in the requested range.",
      user: `Score this headline for US large-cap sentiment.

Headline: "Apple reports record services revenue, tops estimates"

Return JSON: { "sentiment": <-1..1>, "rationale": "<short reason>" }`,
      schema: Schema,
      maxOutputTokens: config.LLM_MAX_TOKENS,
      maxRetries: 1,
    });
    console.log(`  json: sentiment=${res.data.sentiment}, rationale="${res.data.rationale}"`);
  });

  await step("thesis", async () => {
    const Schema = z.object({
      action: z.enum(["BUY", "HOLD", "SELL"]),
      /** Models often emit 4+ bullets; accept extras and show the first three. */
      bullets: z.array(z.string()).min(3).max(12),
    });
    const res = await llm.generateJson({
      system:
        "You are a US equity research assistant. Output strict JSON only. Describe technical setups only; do not give individualized investment advice.",
      user: `Analyse this setup.

Stock: AAPL
Close: 210
SMA50: 205
SMA200: 198
RSI 14: 58
Volume ratio (20d): 1.25

Return JSON: { "action": "BUY|HOLD|SELL", "bullets": ["...", "...", "..."] }
Use at least 3 bullet strings; prefer exactly 3.`,
      schema: Schema,
      maxOutputTokens: config.LLM_MAX_TOKENS,
      maxRetries: 1,
    });
    const bullets = res.data.bullets.slice(0, 3);
    if (res.data.bullets.length > 3) {
      console.log(`  (truncated ${res.data.bullets.length} bullets → 3)`);
    }
    console.log(`  thesis: ${res.data.action}`);
    for (const b of bullets) {
      console.log(`    - ${b}`);
    }
  });

  console.log("\nLLM smoke test passed.");
}
