/**
 * Google Vertex AI — Gemini via `@google/genai` (Vertex backend).
 *
 * The legacy `@google-cloud/vertexai` SDK was deprecated 2025-06-24 and removed
 * 2026-06-24. The unified Gen AI SDK speaks to Vertex when constructed with
 * `vertexai: true` and a project/location, using ADC for auth
 * (`GOOGLE_APPLICATION_CREDENTIALS` or workload identity).
 */

import {
  BlockedReason,
  FinishReason,
  type GenerateContentResponse,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/genai";

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
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

export class VertexProvider implements LlmProvider {
  readonly name = "vertex";
  readonly model: string;
  private readonly ai: GoogleGenAI;
  private readonly timeoutMs: number;

  constructor() {
    const config = getConfig();
    if (!config.VERTEX_PROJECT_ID) {
      throw new Error(
        "VertexProvider requires VERTEX_PROJECT_ID. Set it in .env or switch LLM_PROVIDER.",
      );
    }
    this.model = config.VERTEX_MODEL;
    this.timeoutMs = config.VERTEX_TIMEOUT_MS;
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: config.VERTEX_PROJECT_ID,
      location: config.VERTEX_LOCATION,
      httpOptions: { timeout: this.timeoutMs },
    });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      const userPrompt =
        attempt === 0
          ? opts.user
          : `${opts.user}\n\nIMPORTANT: Return ONLY a single valid JSON object matching the schema. No markdown fences, no commentary.`;

      const result = await this.ai.models.generateContent({
        model: this.model,
        contents: userPrompt,
        config: {
          systemInstruction: opts.system,
          safetySettings: RESEARCH_SAFETY_SETTINGS,
          temperature: opts.temperature ?? 0.1,
          maxOutputTokens: opts.maxOutputTokens ?? 8192,
          responseMimeType: "application/json",
        },
      });

      const raw = extractResponseText(result, { rejectMaxTokens: true });
      lastRaw = raw;
      const usage = result.usageMetadata;

      try {
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
      : new Error(`Vertex JSON generation failed after retries: ${lastRaw.slice(0, 300)}`);
  }
}

function extractResponseText(
  response: GenerateContentResponse,
  opts?: { rejectMaxTokens?: boolean },
): string {
  const pf = response.promptFeedback;
  if (pf?.blockReason && pf.blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
    throw new Error(
      `Vertex blocked the prompt: ${pf.blockReason}. ${pf.blockReasonMessage ?? ""}`,
    );
  }

  const candidates = response.candidates ?? [];
  const emptyReasons: string[] = [];

  for (const cand of candidates) {
    const reason = cand.finishReason;
    let chunk = "";
    if (cand.content?.parts?.length) {
      for (const part of cand.content.parts) {
        if (typeof part.text === "string" && part.text) chunk += part.text;
      }
    }
    const trimmed = chunk.trim();
    if (trimmed) {
      if (
        reason &&
        reason !== FinishReason.STOP &&
        reason !== FinishReason.MAX_TOKENS &&
        reason !== FinishReason.FINISH_REASON_UNSPECIFIED
      ) {
        throw new Error(
          `Vertex stopped with finishReason=${reason}${cand.finishMessage ? `: ${cand.finishMessage}` : ""}`,
        );
      }
      if (opts?.rejectMaxTokens && reason === FinishReason.MAX_TOKENS) {
        throw new Error(
          "Vertex hit MAX_TOKENS — output truncated. Increase maxOutputTokens or shorten the task.",
        );
      }
      return trimmed;
    }
    if (reason && reason !== FinishReason.FINISH_REASON_UNSPECIFIED) {
      emptyReasons.push(String(reason));
    }
  }

  // Fall back to the SDK convenience accessor when candidates are present but
  // we couldn't reconstruct text manually (e.g. tool-call-only responses).
  const flat = typeof response.text === "string" ? response.text.trim() : "";
  if (flat) return flat;

  const hint = emptyReasons.length > 0 ? ` finishReason=${emptyReasons.join(",")}` : "";
  throw new Error(`Vertex returned no text candidates (empty or filtered).${hint}`);
}
