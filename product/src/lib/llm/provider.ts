// BYOK LLM adapter. One `complete()` surface over Anthropic, OpenAI, and Gemini,
// each with a "cheap" and "smart" tier so briefs use a small model and drafting
// uses a strong one. Every call is the user's own key and their own spend.
//
// All three are asked to return a single JSON object matching a passed schema.
// We validate that the response parses; schema-shape validation is the caller's
// job (via zod) since each step knows its own shape.

export type Provider = "anthropic" | "openai" | "gemini";
export type Tier = "cheap" | "smart";

export type LlmConfig = {
  provider: Provider;
  apiKey: string;
};

export class LlmError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "LlmError";
  }
}

const MODELS: Record<Provider, Record<Tier, string>> = {
  anthropic: {
    cheap: process.env.ANTHROPIC_CHEAP_MODEL ?? "claude-3-5-haiku-latest",
    smart: process.env.ANTHROPIC_SMART_MODEL ?? "claude-3-5-sonnet-latest",
  },
  openai: {
    cheap: process.env.OPENAI_CHEAP_MODEL ?? "gpt-4o-mini",
    smart: process.env.OPENAI_SMART_MODEL ?? "gpt-4o",
  },
  gemini: {
    cheap: process.env.GEMINI_CHEAP_MODEL ?? "gemini-1.5-flash",
    smart: process.env.GEMINI_SMART_MODEL ?? "gemini-1.5-pro",
  },
};

export type CompleteOptions = {
  system: string;
  prompt: string;
  schema?: Record<string, unknown>;
  tier?: Tier;
  temperature?: number;
  maxTokens?: number;
};

export async function complete<T>(config: LlmConfig, options: CompleteOptions): Promise<T> {
  const tier = options.tier ?? "smart";
  const model = MODELS[config.provider][tier];
  const text = await callProvider(config, model, options);
  return parseJson<T>(text);
}

async function callProvider(config: LlmConfig, model: string, options: CompleteOptions): Promise<string> {
  switch (config.provider) {
    case "anthropic":
      return callAnthropic(config.apiKey, model, options);
    case "openai":
      return callOpenAI(config.apiKey, model, options);
    case "gemini":
      return callGemini(config.apiKey, model, options);
    default:
      throw new LlmError(`Unknown provider: ${config.provider}`);
  }
}

function jsonInstruction(schema?: Record<string, unknown>): string {
  if (!schema) return "\n\nReturn ONLY a single valid JSON object. No prose, no markdown fences.";
  return `\n\nReturn ONLY a single valid JSON object matching this JSON schema. No prose, no markdown fences.\n${JSON.stringify(schema)}`;
}

async function callAnthropic(apiKey: string, model: string, options: CompleteOptions): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 2000,
      temperature: options.temperature ?? 0.7,
      system: options.system + jsonInstruction(options.schema),
      messages: [{ role: "user", content: options.prompt }],
    }),
  });
  if (!res.ok) throw providerError("Anthropic", res.status, await res.text());
  const json = await res.json();
  return json.content?.[0]?.text ?? "";
}

async function callOpenAI(apiKey: string, model: string, options: CompleteOptions): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: options.system + jsonInstruction(options.schema) },
        { role: "user", content: options.prompt },
      ],
    }),
  });
  if (!res.ok) throw providerError("OpenAI", res.status, await res.text());
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function callGemini(apiKey: string, model: string, options: CompleteOptions): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: options.system + jsonInstruction(options.schema) }] },
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 2000,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) throw providerError("Gemini", res.status, await res.text());
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}

function providerError(name: string, status: number, body: string): LlmError {
  const retryable = status === 429 || status >= 500;
  const detail = body.slice(0, 200);
  if (status === 401 || status === 403) return new LlmError(`${name} rejected your API key.`);
  return new LlmError(`${name} error ${status}: ${detail}`, retryable);
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Some models wrap or prepend a stray token; grab the outermost object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new LlmError("Model did not return valid JSON.");
  }
}

/** Cheap validity probe used at key-entry time. */
export async function validateLlmKey(config: LlmConfig): Promise<{ valid: boolean; error?: string }> {
  try {
    await complete<{ ok: boolean }>(config, {
      system: "You are a connectivity check.",
      prompt: 'Return {"ok": true}.',
      tier: "cheap",
      maxTokens: 20,
      temperature: 0,
    });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "Could not reach the provider." };
  }
}
