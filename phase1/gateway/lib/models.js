// The OpenRouter provider for pi-ai: static catalog of the two models the
// system uses, with metadata from OpenRouter's models API (2 Oct 2026).
// Costs are US dollars per million tokens, as pi-ai expects.

import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const MODELS = [
  {
    id: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    name: "GLM 5.3 Flash",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.15, output: 0.5, cacheRead: 0.0375, cacheWrite: 0.15 },
  },
  {
    id: "z-ai/glm-5.3",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    name: "GLM 5.3",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.35, cacheWrite: 1.4 },
  },
];

export function buildModels() {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: { apiKey: envApiKeyAuth("OpenRouter", ["OPENROUTER_API_KEY"]) },
      api: openAICompletionsApi(),
      models: MODELS,
    })
  );
  return models;
}

export const MODEL_ALIASES = {
  flash: { provider: "openrouter", modelId: "z-ai/glm-5.3-flash" },
  strong: { provider: "openrouter", modelId: "z-ai/glm-5.3" },
};

/** One small chat completion over OpenRouter REST (topic naming, escalation
 *  classification). Not part of the durable agent loop. */
export async function smallLlm({ apiKey, system, user, maxTokens = 500 }) {
  // GLM reasoning is mandatory and emits reasoning tokens before content; a
  // retry with a larger budget covers runs where reasoning starves the answer.
  let lastError = "no response";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "z-ai/glm-5.3-flash",
        max_tokens: maxTokens * (attempt + 1),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    const choice = body?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text === "string" && text.trim().length > 0) return text.trim();
    lastError = `content empty (finish: ${choice?.finish_reason ?? "unknown"})`;
  }
  throw new Error(`OpenRouter returned no text: ${lastError}`);
}
