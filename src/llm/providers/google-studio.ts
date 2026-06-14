import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";

import { getConfig } from "../../config/index.js";
import { parseAndValidate } from "../json.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from "../types.js";

const RESEARCH_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

const GEMINI_CALLS_PER_MINUTE = 15;
const GEMINI_WINDOW_MS = 60_000;

export class SlidingWindowRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private readonly timestamps: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    now: () => number = () => Date.now(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.now = now;
    this.sleep = sleep;
  }

  acquire(): Promise<void> {
    const run = async () => {
      for (;;) {
        const current = this.now();
        while (this.timestamps.length > 0) {
          const oldest = this.timestamps[0];
          if (oldest == null) {
            this.timestamps.shift();
            continue;
          }
          if (current - oldest < this.windowMs) break;
          this.timestamps.shift();
        }
        if (this.timestamps.length < this.capacity) {
          this.timestamps.push(current);
          return;
        }
        const oldest = this.timestamps[0];
        if (oldest == null) continue;
        const waitMs = Math.max(this.windowMs - (current - oldest), 1);
        await this.sleep(waitMs);
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const geminiRateLimiter = new SlidingWindowRateLimiter(GEMINI_CALLS_PER_MINUTE, GEMINI_WINDOW_MS);

export class GoogleStudioProvider implements LlmProvider {
  readonly model: string;
  readonly name = "google-studio";
  private readonly ai: GoogleGenAI;

  constructor() {
    const config = getConfig();
    const apiKey = config.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GoogleStudioProvider requires GOOGLE_AI_API_KEY. Set it in .env or switch LLM_PROVIDER.",
      );
    }
    this.model = config.GOOGLE_AI_MODEL;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();
    await geminiRateLimiter.acquire();

    const result = await this.ai.models.generateContent({
      model: this.model,
      contents: opts.user,
      config: {
        systemInstruction: opts.system,
        safetySettings: RESEARCH_SAFETY_SETTINGS,
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
    });

    const text = extractResponseText(result);
    const usage = result.usageMetadata;

    return {
      text,
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        durationMs: Date.now() - started,
      },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    const maxRetries = opts.maxRetries ?? 1;
    let lastErr: unknown;
    let lastRaw = "";
    const cleanedSchema = toGoogleResponseSchema(opts.schema);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      const userPrompt =
        attempt === 0
          ? opts.user
          : `${opts.user}\n\nIMPORTANT: Return ONLY a single valid JSON object matching the requested schema. Do not output markdown codeblocks.`;

      try {
        await geminiRateLimiter.acquire();

        const result = await this.ai.models.generateContent({
          model: this.model,
          contents: userPrompt,
          config: {
            systemInstruction: opts.system,
            safetySettings: RESEARCH_SAFETY_SETTINGS,
            temperature: opts.temperature ?? 0.1,
            maxOutputTokens: opts.maxOutputTokens ?? 8192,
            responseMimeType: "application/json",
            responseSchema: cleanedSchema,
          },
        });

        const raw = extractResponseText(result, { rejectMaxTokens: true });
        lastRaw = raw;
        const usage = result.usageMetadata;

        const data = parseAndValidate(raw, opts.schema);
        return {
          data,
          raw,
          model: this.model,
          usage: {
            inputTokens: usage?.promptTokenCount,
            outputTokens: usage?.candidatesTokenCount,
            durationMs: Date.now() - started,
          },
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(
          `Google AI Studio JSON generation failed after retries: ${lastRaw.slice(0, 300)}`,
        );
  }
}

function toGoogleResponseSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  let candidate: unknown;
  if (typeof (schema as { toJSON?: () => unknown }).toJSON === "function") {
    candidate = (schema as { toJSON: () => unknown }).toJSON();
  } else if ((schema as { jsonSchema?: unknown }).jsonSchema) {
    candidate = (schema as { jsonSchema: unknown }).jsonSchema;
  } else {
    candidate = JSON.parse(JSON.stringify(schema));
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;

  const payload = candidate as Record<string, unknown>;
  payload.$schema = undefined;
  payload.additionalProperties = undefined;

  if (!isLikelyJsonSchema(payload)) return undefined;
  return payload;
}

function isLikelyJsonSchema(value: Record<string, unknown>): boolean {
  return ["type", "properties", "items", "required", "enum", "oneOf", "anyOf", "allOf"].some(
    (k) => k in value,
  );
}

function extractResponseText(result: {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string }>;
  text?: string;
}, opts?: { rejectMaxTokens?: boolean }): string {
  const promptFeedback = result.promptFeedback;
  if (promptFeedback?.blockReason) {
    throw new Error(`Google Studio blocked the prompt sequence: ${promptFeedback.blockReason}`);
  }

  const candidates = result.candidates ?? [];
  if (candidates.length === 0) {
    throw new Error("Google Studio returned empty response array with zero structural candidates.");
  }

  const primeCandidate = candidates[0];
  const finishReason = primeCandidate?.finishReason;

  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw new Error(`Google Studio stopped execution process via code: ${finishReason}`);
  }

  if (opts?.rejectMaxTokens && finishReason === "MAX_TOKENS") {
    throw new Error("Google Studio target hit MAX_TOKENS ceiling — output buffer truncated.");
  }

  if (result.text) return result.text.trim();

  throw new Error("Google Studio failed to yield valid textual candidate payloads.");
}
