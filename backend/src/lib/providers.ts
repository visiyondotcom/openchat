import type { ChatMessage, ChatOnceResult, StreamChunk } from "./ollama.js";

// External AI providers — OpenAI, Anthropic/Claude, and any OpenAI-
// compatible endpoint (Groq, Mistral, OpenRouter, Azure OpenAI,
// together.ai, a local vLLM/LM Studio server, ...). Mirrors the shape of
// lib/ollama.ts (ChatOnceResult, the same streamed-chunk shape) so
// routes/chats.ts can treat a "provider:<id>:<model>" chat exactly like a
// normal Ollama one once it's picked the right client here.

export type ProviderType = "openai" | "anthropic" | "openai_compatible";

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string | null;
}

export interface ProviderChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  stop?: string[];
  num_predict?: number; // mapped to max_tokens for OpenAI/Anthropic
  // Lets a caller cancel an in-flight request — used by lib/meta-model.ts
  // to abort every losing candidate the instant one of them wins the race.
  // Optional; unused by any pre-existing caller.
  signal?: AbortSignal;
}

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

function resolveBaseUrl(config: ProviderConfig): string {
  if (config.baseUrl) {
    // Some providers' own docs (NVIDIA's "invoke_url" examples are the
    // one seen in practice) show a full completions URL as the thing to
    // copy — e.g. "https://integrate.api.nvidia.com/v1/chat/completions"
    // — rather than the API root this platform expects in the Base URL
    // field. Pasted as-is, that doubles up: this module appends
    // "/chat/completions" or "/models" itself below, so the request ends
    // up hitting ".../v1/chat/completions/models" and 404s on
    // everything, test included. Strip a trailing "/chat/completions" (or
    // a bare "/completions") so pasting either form just works.
    return config.baseUrl.replace(/\/+$/, "").replace(/\/(chat\/completions|completions)$/i, "");
  }
  return config.type === "anthropic" ? DEFAULT_ANTHROPIC_BASE : DEFAULT_OPENAI_BASE;
}

// Anthropic's Messages API takes `system` as a top-level field, not a
// message with role "system" — split it out and merge multiple system
// messages (if present) into one string.
function splitSystem(messages: ChatMessage[]): { system?: string; rest: ChatMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, rest };
}

// ---- Non-streaming: used by the tool-calling first pass, same as
// lib/ollama.ts's chatOnce. ----
export async function chatOnceProvider(
  config: ProviderConfig,
  opts: ProviderChatOptions
): Promise<ChatOnceResult> {
  if (config.type === "anthropic") {
    const { system, rest } = splitSystem(opts.messages);
    const res = await fetch(`${resolveBaseUrl(config)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        system,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
        temperature: opts.temperature,
        top_p: opts.top_p,
        stop_sequences: opts.stop,
        max_tokens: opts.num_predict ?? 4096,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return {
      content,
      promptTokens: data.usage?.input_tokens,
      completionTokens: data.usage?.output_tokens,
    };
  }

  // openai + openai_compatible share the same /chat/completions shape.
  const res = await fetch(`${resolveBaseUrl(config)}/chat/completions`, {
    method: "POST",
    // Some gateways (NVIDIA's NIM catalog specifically — see their own
    // sample code) key request handling off the Accept header, not just
    // Authorization — an otherwise-identical request without it can come
    // back 401 for a model that requires it. Harmless to send for every
    // other OpenAI-compatible provider too, so it's not gated by type.
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature,
      top_p: opts.top_p,
      stop: opts.stop,
      max_tokens: opts.num_predict,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Provider request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  };
}

// ---- Streaming: yields the same chunk shape lib/ollama.ts's streamChat
// does, so routes/chats.ts's SSE loop needs no branching beyond picking
// which generator to iterate. ----
export async function* streamProviderChat(
  config: ProviderConfig,
  opts: ProviderChatOptions
): AsyncGenerator<StreamChunk> {
  if (config.type === "anthropic") {
    yield* streamAnthropic(config, opts);
    return;
  }
  yield* streamOpenAiCompatible(config, opts);
}

async function* streamOpenAiCompatible(
  config: ProviderConfig,
  opts: ProviderChatOptions
): AsyncGenerator<StreamChunk> {
  const res = await fetch(`${resolveBaseUrl(config)}/chat/completions`, {
    method: "POST",
    // See the matching comment above chatOnceProvider's request — same
    // reasoning, "text/event-stream" here since this path always streams.
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature,
      top_p: opts.top_p,
      stop: opts.stop,
      max_tokens: opts.num_predict,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Provider request failed: ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        yield { message: { content: "" }, done: true, prompt_eval_count: promptTokens, eval_count: completionTokens };
        return;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) {
        promptTokens = json.usage.prompt_tokens;
        completionTokens = json.usage.completion_tokens;
      }
      const delta = json.choices?.[0]?.delta?.content ?? "";
      const finished = json.choices?.[0]?.finish_reason != null;
      if (delta) yield { message: { content: delta }, done: false };
      if (finished) {
        yield { message: { content: "" }, done: true, prompt_eval_count: promptTokens, eval_count: completionTokens };
        return;
      }
    }
  }
}

async function* streamAnthropic(config: ProviderConfig, opts: ProviderChatOptions): AsyncGenerator<StreamChunk> {
  const { system, rest } = splitSystem(opts.messages);
  const res = await fetch(`${resolveBaseUrl(config)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      system,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature,
      top_p: opts.top_p,
      stop_sequences: opts.stop,
      max_tokens: opts.num_predict ?? 4096,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.type === "message_start") {
        promptTokens = json.message?.usage?.input_tokens;
      } else if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        yield { message: { content: json.delta.text as string }, done: false };
      } else if (json.type === "message_delta") {
        completionTokens = json.usage?.output_tokens;
      } else if (json.type === "message_stop") {
        yield { message: { content: "" }, done: true, prompt_eval_count: promptTokens, eval_count: completionTokens };
        return;
      }
    }
  }
}

// ---- Connection test, used by the admin "Test" button. Does the
// cheapest possible authenticated call for each provider type — for
// OpenAI/compatible that's GET /models (also lets us auto-populate the
// model list); Anthropic has no models-list endpoint on all deployments,
// so it sends a 1-token ping instead. ----
export async function testProviderConnection(
  config: ProviderConfig
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  try {
    if (config.type === "anthropic") {
      await chatOnceProvider(config, {
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "ping" }],
        num_predict: 1,
      });
      return { ok: true };
    }

    const res = await fetch(`${resolveBaseUrl(config)}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    const data = (await res.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((m) => m.id).sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
