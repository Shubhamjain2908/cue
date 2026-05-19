import { z } from "zod";

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], maxTokens: number): Promise<string>;
  readonly name: string;
}

/** Upper bound for rationale length; keep in sync with prompt schema line. */
export const ENRICHMENT_RATIONALE_MAX_CHARS = 12_000;

export const EnrichmentResultSchema = z.object({
  sentiment: z.enum(["BULLISH", "NEUTRAL", "BEARISH"]),
  rationale: z.string().min(20).max(ENRICHMENT_RATIONALE_MAX_CHARS),
  earningsDate: z.string().nullable(),
  sector: z.string(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
});

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

export class LLMHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodySnippet: string,
  ) {
    super(message);
    this.name = "LLMHttpError";
  }
}

/** Exact user follow-up after invalid JSON (deterministic; tests assert this string). */
export const JSON_RETRY_USER_MESSAGE =
  "Your response was not valid JSON matching the required schema. Return ONLY a JSON object with keys: sentiment, rationale, earningsDate, sector, confidence. No markdown, no explanation.";
