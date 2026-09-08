const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// --- Multi-instance load balancing (GPU 1 + GPU 2) ---------------------
// OLLAMA_URLS: comma-separated list of Ollama instance base URLs, one per
// pinned GPU (e.g. "http://localhost:11434,http://localhost:11435").
// When set, every chat request picks whichever instance currently has the
// fewest in-flight requests, so two simultaneous chats land on two
// different GPUs instead of queueing behind each other on one card.
// When unset, everything falls back to the single OLLAMA_URL exactly as
// before — no behavior change for single-GPU setups.
const OLLAMA_URLS: string[] = (process.env.OLLAMA_URLS || OLLAMA_URL)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

// In-flight request counter per instance URL, used purely to pick the
// least-busy instance. Not persisted — resets on backend restart, which is
// fine since it only needs to reflect *current* load.
const inFlightCounts = new Map<string, number>(OLLAMA_URLS.map((u) => [u, 0]));

function pickOllamaUrl(): string {
  let best = OLLAMA_URLS[0];
  let bestCount = inFlightCounts.get(best) ?? 0;
  for (const url of OLLAMA_URLS) {
    const count = inFlightCounts.get(url) ?? 0;
    if (count < bestCount) {
      best = url;
      bestCount = count;
    }
  }
  return best;
}

function beginRequest(url: string) {
  inFlightCounts.set(url, (inFlightCounts.get(url) ?? 0) + 1);
}

function endRequest(url: string) {
  inFlightCounts.set(url, Math.max(0, (inFlightCounts.get(url) ?? 1) - 1));
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

// Returns every model currently pulled into Ollama — this is how
// GLM-4-9B, Granite-4.1-8B, or any other model you `ollama pull`
// shows up in the UI automatically with zero code changes.
export async function listModels(): Promise<OllamaModel[]> {
  const seen = new Map<string, OllamaModel>();
  // Query every instance — a model pulled only via instance 2 should still
  // show up in the UI, and duplicates (same model pulled on both) collapse
  // to one entry by name.
  for (const url of OLLAMA_URLS) {
    const res = await fetch(`${url}/api/tags`);
    if (!res.ok) throw new Error(`Ollama /api/tags failed (${url}): ${res.status}`);
    const data = (await res.json()) as { models: OllamaModel[] };
    for (const m of data.models ?? []) {
      if (!seen.has(m.name)) seen.set(m.name, m);
    }
  }
  return [...seen.values()];
}

export async function ollamaHealth(): Promise<boolean> {
  // Healthy as a whole if at least one instance responds — matches the old
  // single-instance behavior while tolerating one GPU's Ollama being down.
  const results = await Promise.all(
    OLLAMA_URLS.map(async (url) => {
      try {
        const res = await fetch(`${url}/api/tags`);
        return res.ok;
      } catch {
        return false;
      }
    })
  );
  return results.some(Boolean);
}

// Pull/delete need to hit every instance — otherwise a model only exists on
// GPU 1 and the load balancer sends half the chats to a GPU 2 that 404s.
export async function pullModelEverywhere(name: string): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  for (const url of OLLAMA_URLS) {
    const res = await fetch(`${url}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: false }),
    });
    if (!res.ok) failed.push(url);
  }
  return { ok: failed.length === 0, failed };
}

export async function deleteModelEverywhere(name: string): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  for (const url of OLLAMA_URLS) {
    const res = await fetch(`${url}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    // Ollama returns 404 if a given instance never had the model pulled —
    // that's fine, not a real failure, only count genuine errors.
    if (!res.ok && res.status !== 404) failed.push(url);
  }
  return { ok: failed.length === 0, failed };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  // Base64-encoded image data (no data: prefix) — Ollama's /api/chat
  // accepts an `images` array per message for vision models
  // (llama3.2-vision, qwen2.5vl, llava, ...). Ignored by text-only
  // models, so it's always safe to include when present.
  images?: string[];
}

// Embeds a piece of text with the configured embedding model (default:
// nomic-embed-text — pull it with `ollama pull nomic-embed-text`).
// Used both to embed document chunks at ingest time and to embed the
// user's query at retrieval time.
export async function embedText(text: string, model?: string): Promise<number[]> {
  const embeddingModel = model || process.env.EMBEDDING_MODEL || "nomic-embed-text";
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embeddingModel, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}


export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  num_ctx?: number;
  // Sourced from a model's Advanced Params (routes/chats.ts) — no chat-
  // level or per-message override exists for these yet, so they only ever
  // come from ModelSetting.params.
  seed?: number;
  stop?: string[];
  num_predict?: number;
  // Rest of the Chat Controls panel (frontend/components/
  // ChatControlsPanel.tsx) — all native Ollama /api/chat options, forwarded
  // as-is when set.
  min_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  mirostat?: number;
  mirostat_eta?: number;
  mirostat_tau?: number;
  tfs_z?: number;
  repeat_last_n?: number;
  num_batch?: number;
  num_keep?: number;
  use_mmap?: boolean;
  use_mlock?: boolean;
  // Hardware offload knobs — same as Ollama's own `num_gpu`/`num_thread`
  // options, exposed in the admin modal as GPU Layers / CPU Threads
  // sliders (Advanced Params tab). num_gpu is the number of model layers
  // offloaded to GPU/NPU VRAM (-1 or omitted = Ollama decides, 0 = CPU
  // only); num_thread caps CPU threads used for the rest. Only meaningful
  // for local Ollama models — ignored for external providers.
  num_gpu?: number;
  num_thread?: number;
  // Ollama's native chain-of-thought separation (deepseek-r1, qwq,
  // gpt-oss, ...): when the loaded model supports it, its reasoning comes
  // back on `message.thinking` instead of being mixed into `message.content`.
  // Models that don't support it just ignore this option — always safe to
  // send. Defaults to true (see streamChat/chatOnce below) so reasoning
  // shows up automatically for any capable model with no extra config.
  think?: boolean;
  // Lets a caller cancel an in-flight request — used by lib/meta-model.ts
  // to abort every losing candidate the instant one of them wins the race.
  // Optional and unused by any existing caller, so this is a no-op change
  // for every call site that doesn't pass it.
  signal?: AbortSignal;
}

export interface ChatOnceResult {
  content: string;
  // The model's own chain-of-thought, when it supports Ollama's native
  // `think` option — undefined for models that don't.
  thinking?: string;
  // Straight from Ollama's response — prompt_eval_count is the size of the
  // context it processed, eval_count is how many tokens it generated. Both
  // are undefined if Ollama's response omits them (older Ollama versions).
  promptTokens?: number;
  completionTokens?: number;
}

// Non-streaming variant of /api/chat — returns the full reply in one shot.
// Used by the tool-calling loop to get a complete response we can parse for
// a tool_call JSON marker before deciding whether to stream the real answer
// or execute a tool first.
export async function chatOnce(opts: ChatOptions): Promise<ChatOnceResult> {
  const url = pickOllamaUrl();
  beginRequest(url);
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        think: opts.think ?? false,
        options: {
          temperature: opts.temperature ?? 0.7,
          top_p: opts.top_p ?? 0.9,
          num_ctx: opts.num_ctx ?? 4096,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
          ...(opts.num_predict !== undefined ? { num_predict: opts.num_predict } : {}),
          ...(opts.num_gpu !== undefined ? { num_gpu: opts.num_gpu } : {}),
          ...(opts.num_thread !== undefined ? { num_thread: opts.num_thread } : {}),
          ...(opts.min_p !== undefined ? { min_p: opts.min_p } : {}),
          ...(opts.top_k !== undefined ? { top_k: opts.top_k } : {}),
          ...(opts.frequency_penalty !== undefined ? { frequency_penalty: opts.frequency_penalty } : {}),
          ...(opts.mirostat !== undefined ? { mirostat: opts.mirostat } : {}),
          ...(opts.mirostat_eta !== undefined ? { mirostat_eta: opts.mirostat_eta } : {}),
          ...(opts.mirostat_tau !== undefined ? { mirostat_tau: opts.mirostat_tau } : {}),
          ...(opts.tfs_z !== undefined ? { tfs_z: opts.tfs_z } : {}),
          ...(opts.repeat_last_n !== undefined ? { repeat_last_n: opts.repeat_last_n } : {}),
          ...(opts.num_batch !== undefined ? { num_batch: opts.num_batch } : {}),
          ...(opts.num_keep !== undefined ? { num_keep: opts.num_keep } : {}),
          ...(opts.use_mmap !== undefined ? { use_mmap: opts.use_mmap } : {}),
          ...(opts.use_mlock !== undefined ? { use_mlock: opts.use_mlock } : {}),
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama chat request failed (${url}): ${res.status}`);
    }
    const data = (await res.json()) as {
      message?: { content: string; thinking?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      content: data.message?.content ?? "",
      thinking: data.message?.thinking || undefined,
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count,
    };
  } finally {
    endRequest(url);
  }
}

// Shared shape for a single streamed token chunk — also implemented by
// lib/providers.ts's streamProviderChat, so routes/chats.ts can iterate
// either generator with one code path without a type mismatch.
export interface StreamChunk {
  message?: { content: string; thinking?: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// Streams raw NDJSON chunks straight from Ollama's /api/chat.
// The caller (route handler) re-streams these to the browser as SSE.
export async function* streamChat(opts: ChatOptions): AsyncGenerator<StreamChunk> {
  // Picked once per chat request and held for the whole stream (not just
  // the initial fetch) — this is the actual fix: while chat A's tokens are
  // still streaming from instance 1, its in-flight count stays elevated, so
  // chat B that starts a moment later gets routed to instance 2 (GPU 2)
  // instead of queueing behind A on the same card.
  const url = pickOllamaUrl();
  beginRequest(url);
  try {
    console.log("[OLLAMA-REQ]", JSON.stringify({ url, model: opts.model, think: opts.think ?? false, num_ctx: opts.num_ctx ?? 4096 }));
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        think: opts.think ?? false,
        options: {
          temperature: opts.temperature ?? 0.7,
          top_p: opts.top_p ?? 0.9,
          num_ctx: opts.num_ctx ?? 4096,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
          ...(opts.num_predict !== undefined ? { num_predict: opts.num_predict } : {}),
          ...(opts.num_gpu !== undefined ? { num_gpu: opts.num_gpu } : {}),
          ...(opts.num_thread !== undefined ? { num_thread: opts.num_thread } : {}),
          ...(opts.min_p !== undefined ? { min_p: opts.min_p } : {}),
          ...(opts.top_k !== undefined ? { top_k: opts.top_k } : {}),
          ...(opts.frequency_penalty !== undefined ? { frequency_penalty: opts.frequency_penalty } : {}),
          ...(opts.mirostat !== undefined ? { mirostat: opts.mirostat } : {}),
          ...(opts.mirostat_eta !== undefined ? { mirostat_eta: opts.mirostat_eta } : {}),
          ...(opts.mirostat_tau !== undefined ? { mirostat_tau: opts.mirostat_tau } : {}),
          ...(opts.tfs_z !== undefined ? { tfs_z: opts.tfs_z } : {}),
          ...(opts.repeat_last_n !== undefined ? { repeat_last_n: opts.repeat_last_n } : {}),
          ...(opts.num_batch !== undefined ? { num_batch: opts.num_batch } : {}),
          ...(opts.num_keep !== undefined ? { num_keep: opts.num_keep } : {}),
          ...(opts.use_mmap !== undefined ? { use_mmap: opts.use_mmap } : {}),
          ...(opts.use_mlock !== undefined ? { use_mlock: opts.use_mlock } : {}),
        },
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat request failed (${url}): ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const json = JSON.parse(line);
        console.log("[OLLAMA-CHUNK]", JSON.stringify(json).slice(0, 300));
        // Ollama only includes prompt_eval_count / eval_count on the final
        // chunk (done: true) — earlier token chunks won't have them.
        // `message.thinking` streams incrementally alongside `message.content`
        // for reasoning-capable models — Ollama fills one or the other per
        // chunk, never both, while the model is "in" a thinking vs answering
        // phase.
        yield json as {
          message?: { content: string; thinking?: string };
          done: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
      }
    }
  } finally {
    endRequest(url);
  }
}
