/**
 * Mock LLM provider for tests and `LLM_PROVIDER=mock` dry runs.
 */

import { parseAndValidate } from "../json.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from "../types.js";

const MOCK_ENRICHMENT = {
  sentiment: "NEUTRAL" as const,
  rationale: "Mock enrichment: headlines are mixed; no material change to the BUY thesis from provided context.",
  earningsDate: null as string | null,
  sector: "Technology",
  confidence: "LOW" as const,
};

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-model";

  readonly calls: Array<{ method: string; system: string; user: string }> = [];

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    this.calls.push({ method: "generateText", system: opts.system, user: opts.user });
    let text = "Mock narrative for pipeline dry-run.";
    if (opts.user.toLowerCase().includes("pong")) {
      text = "PONG";
    }
    return {
      text,
      model: this.model,
      usage: { durationMs: 1 },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    this.calls.push({ method: "generateJson", system: opts.system, user: opts.user });

    let raw: string;
    if (opts.system.includes("financial signal analyst")) {
      raw = JSON.stringify(MOCK_ENRICHMENT);
    } else if (opts.system.includes("sentiment")) {
      raw = JSON.stringify({ sentiment: 0.1, rationale: "Mock sentiment score." });
    } else {
      raw = JSON.stringify({ ok: true, mock: true });
    }

    const data = parseAndValidate(raw, opts.schema);
    return {
      data,
      raw,
      model: this.model,
      usage: { durationMs: 1 },
    };
  }
}
