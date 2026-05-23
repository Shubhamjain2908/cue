/**
 * cursor-agent provider (CLI). Sandboxes each call in a temp directory.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../../config/index.js";
import { parseAndValidate } from "../json.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from "../types.js";

export interface CursorAgentProviderOptions {
  bin?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class CursorAgentProvider implements LlmProvider {
  readonly name = "cursor-agent";
  readonly model: string;
  private readonly bin: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: CursorAgentProviderOptions = {}) {
    const config = getConfig();
    this.bin = opts.bin ?? config.CURSOR_AGENT_BIN;
    this.model = opts.model ?? config.CURSOR_AGENT_MODEL;
    this.apiKey = opts.apiKey ?? config.CURSOR_API_KEY;
    this.timeoutMs = opts.timeoutMs ?? config.CURSOR_AGENT_TIMEOUT_MS;
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const prompt = this.buildPrompt(opts.system, opts.user);
    const started = Date.now();
    const stdout = await this.runProcess(prompt, opts.signal);
    return {
      text: stdout.trim(),
      model: this.model,
      usage: { durationMs: Date.now() - started },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    const maxRetries = opts.maxRetries ?? 1;
    let lastErr: unknown;
    let lastRaw = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const userPrompt =
        attempt === 0
          ? `${opts.user}\n\nRespond with ONLY a single valid JSON object that matches the schema. No commentary, no markdown fences, no explanation before or after.`
          : `${opts.user}\n\nThe previous attempt failed JSON validation. Respond with ONLY a single valid JSON object that matches the schema. No prose, no markdown.`;

      const text = await this.generateText({ ...opts, user: userPrompt });
      lastRaw = text.text;
      try {
        const data = parseAndValidate(text.text, opts.schema);
        return { data, raw: text.text, model: this.model, usage: text.usage };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`cursor-agent JSON generation failed after retries: ${lastRaw}`);
  }

  private buildPrompt(system: string, user: string): string {
    return `[SYSTEM]\n${system.trim()}\n\n[TASK]\n${user.trim()}`;
  }

  private runProcess(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const sandbox = mkdtempSync(join(tmpdir(), "cue-cursor-"));
      const args: string[] = ["--cwd", sandbox, "--", prompt];

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (this.apiKey) env.CURSOR_API_KEY = this.apiKey;

      const child = spawn(this.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal,
        env,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new Error(
            `cursor-agent timed out after ${this.timeoutMs}ms. Last stderr: ${stderr.trim().slice(0, 500)}`,
          ),
        );
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        try {
          rmSync(sandbox, { recursive: true, force: true });
        } catch {
          // best effort
        }
      };

      child.on("error", (err) => {
        cleanup();
        reject(err);
      });
      child.on("close", (code) => {
        cleanup();
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `cursor-agent exited with code ${code}. stderr: ${stderr.trim().slice(0, 500)}`,
            ),
          );
        }
      });
    });
  }
}
