import axios from "axios";
import { GoogleAuth } from "google-auth-library";

import type { LLMMessage, LLMProvider } from "../types.js";
import { LLMHttpError } from "../types.js";

export interface VertexProviderOptions {
  /** GCP project id (numeric or string id from Cloud Console). */
  projectId: string;
  /** Vertex region, e.g. `us-central1`. */
  location?: string;
  /** Publisher model id, e.g. `gemini-2.0-flash-001`. */
  model?: string;
}

function buildGenerateContentUrl(projectId: string, location: string, model: string): string {
  const host = `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

/**
 * Gemini on Vertex AI via `generateContent`, authenticated with Application Default Credentials
 * (e.g. `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file, or GCE / Cloud Run identity).
 */
export function createVertexProvider(options: VertexProviderOptions): LLMProvider {
  const location = options.location ?? "us-central1";
  const model = options.model ?? "gemini-2.0-flash-001";
  const url = buildGenerateContentUrl(options.projectId, location, model);

  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  return {
    name: "vertex",
    async complete(messages: LLMMessage[], maxTokens: number): Promise<string> {
      const client = await auth.getClient();
      const access = await client.getAccessToken();
      const rawToken = access.token;
      const token = typeof rawToken === "string" ? rawToken : "";
      if (token.length === 0) {
        throw new Error(
          "Vertex: no access token (set GOOGLE_APPLICATION_CREDENTIALS or use a GCP-attached service identity)",
        );
      }

      const systemParts = messages.filter((m) => m.role === "system");
      const systemText = systemParts.map((m) => m.content).join("\n\n");
      const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
        },
      };
      if (systemText.length > 0) {
        body.systemInstruction = { parts: [{ text: systemText }] };
      }

      try {
        const res = await axios.post<{
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        }>(url, body, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          timeout: 120_000,
          validateStatus: () => true,
        });
        if (res.status < 200 || res.status >= 300) {
          const snippet =
            typeof res.data === "object" ? JSON.stringify(res.data).slice(0, 500) : String(res.data);
          throw new LLMHttpError(`Vertex HTTP ${res.status}`, res.status, snippet);
        }
        const parts = res.data.candidates?.[0]?.content?.parts ?? [];
        return parts.map((p) => p.text ?? "").join("");
      } catch (e) {
        if (e instanceof LLMHttpError) {
          throw e;
        }
        if (axios.isAxiosError(e) && e.response) {
          const snippet = JSON.stringify(e.response.data ?? {}).slice(0, 500);
          throw new LLMHttpError(`Vertex HTTP ${e.response.status}`, e.response.status, snippet);
        }
        throw e;
      }
    },
  };
}
