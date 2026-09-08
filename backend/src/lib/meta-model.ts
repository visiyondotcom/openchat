import type { FastifyInstance } from "fastify";
import { chatOnce, streamChat, type ChatMessage, type ChatOnceResult, type StreamChunk } from "./ollama.js";
import { chatOnceProvider, streamProviderChat, type ProviderConfig } from "./providers.js";
import { decryptSecret } from "./crypto.js";
import { withStallTimeout } from "./stream-utils.js";

// ---- What a meta-model ("Jean") is -------------------------------------
// One admin-configured name (`meta:<slug>`) that fans out to several real
// models: your own GPU(s) via Ollama, and/or external APIs (NVIDIA,
// OpenAI, Anthropic, any OpenAI-compatible endpoint) via lib/providers.ts.
// Every candidate is tried in a race: the fastest to produce a first token
// wins and the rest are aborted immediately. If a candidate errors instead
// of answering, the next one still in the race takes over. From the
// client's side this is indistinguishable from talking to one model —
// exactly the "Blender-achtig mixen" behavior that was asked for.

export interface MetaModelCandidateSpec {
  order: number;
  kind: "ollama" | "provider";
  ollamaModel?: string | null;
  providerConfig?: ProviderConfig | null;
  providerModel?: string | null;
  // Purely for logs/debugging — never shown to end users.
  label: string;
}

export interface ResolvedMetaModel {
  slug: string;
  hedgeDelayMs: number;
  candidates: MetaModelCandidateSpec[];
}

// Loads a meta-model plus its enabled candidates (and their enabled
// parent AiProvider, for provider-kind candidates) from the DB and
// decrypts provider API keys once up front. Returns null for anything
// that isn't "meta:<slug>", or whose slug doesn't exist / is disabled, or
// that ends up with zero usable candidates — callers treat null as "not a
// meta-model, fall through to the normal Ollama/provider path".
export async function resolveMetaModel(
  prisma: FastifyInstance["prisma"],
  model: string
): Promise<ResolvedMetaModel | null> {
  if (!model.startsWith("meta:")) return null;
  const slug = model.slice("meta:".length);
  const meta = await prisma.metaModel.findUnique({
    where: { slug },
    include: { candidates: { include: { provider: true }, orderBy: { order: "asc" } } },
  });
  if (!meta || !meta.enabled) return null;

  const candidates: MetaModelCandidateSpec[] = [];
  for (const c of meta.candidates) {
    if (!c.enabled) continue;
    if (c.kind === "ollama") {
      if (!c.ollamaModel) continue;
      candidates.push({
        order: c.order,
        kind: "ollama",
        ollamaModel: c.ollamaModel,
        label: `ollama:${c.ollamaModel}`,
      });
    } else if (c.kind === "provider") {
      if (!c.provider || !c.provider.enabled || !c.providerModel) continue;
      candidates.push({
        order: c.order,
        kind: "provider",
        providerConfig: {
          type: c.provider.type as ProviderConfig["type"],
          apiKey: decryptSecret(c.provider.apiKeyEncrypted),
          baseUrl: c.provider.baseUrl,
        },
        providerModel: c.providerModel,
        label: `${c.provider.name}:${c.providerModel}`,
      });
    }
  }
  candidates.sort((a, b) => a.order - b.order);
  if (candidates.length === 0) return null;

  return { slug, hedgeDelayMs: meta.hedgeDelayMs, candidates };
}

export interface RoutedChatOptions {
  temperature?: number;
  top_p?: number;
  stop?: string[];
  num_predict?: number;
}

// Waits `ms`, but resolves early (without error) if `cancel` fires first —
// used so a not-yet-started candidate stops waiting the moment some
// earlier candidate has already won and there's no point joining anymore.
function delay(ms: number, cancel: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    cancel.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ---- Non-streaming race (used by the tool-call detection passes) -------
export async function chatOnceMeta(
  meta: ResolvedMetaModel,
  messages: ChatMessage[],
  opts: RoutedChatOptions
): Promise<ChatOnceResult> {
  const raceOver = new AbortController();
  const attempts = meta.candidates.map((candidate, i) =>
    runOnceAttempt(candidate, i, meta.hedgeDelayMs, messages, opts, raceOver)
  );

  try {
    return await firstSuccessful(attempts);
  } finally {
    raceOver.abort();
  }
}

async function runOnceAttempt(
  candidate: MetaModelCandidateSpec,
  index: number,
  hedgeDelayMs: number,
  messages: ChatMessage[],
  opts: RoutedChatOptions,
  raceOver: AbortController
): Promise<ChatOnceResult> {
  await delay(index * hedgeDelayMs, raceOver.signal);
  if (raceOver.signal.aborted) throw new Error(`meta candidate ${candidate.label}: race already won elsewhere`);
  const controller = new AbortController();
  const onRaceOver = () => controller.abort();
  raceOver.signal.addEventListener("abort", onRaceOver);
  try {
    const result =
      candidate.kind === "ollama"
        ? await chatOnce({ model: candidate.ollamaModel!, messages, ...opts, signal: controller.signal })
        : await chatOnceProvider(candidate.providerConfig!, {
            model: candidate.providerModel!,
            messages,
            ...opts,
            signal: controller.signal,
          });
    // Won: detach from raceOver so the caller's raceOver.abort() (fired
    // once a winner exists, to cancel every other candidate) doesn't also
    // cancel this one.
    raceOver.signal.removeEventListener("abort", onRaceOver);
    return result;
  } catch (err) {
    raceOver.signal.removeEventListener("abort", onRaceOver);
    throw err;
  }
}

// Resolves with the first attempt that succeeds; only rejects once every
// attempt has failed (all candidates unreachable/erroring/too slow).
async function firstSuccessful<T>(attempts: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let remaining = attempts.length;
    const errors: unknown[] = [];
    for (const attempt of attempts) {
      attempt.then(resolve).catch((err) => {
        errors.push(err);
        remaining -= 1;
        if (remaining === 0) {
          reject(new Error(`All meta-model candidates failed: ${errors.map(String).join("; ")}`));
        }
      });
    }
  });
}

// ---- Streaming race (used for the actual chat reply) -------------------
// Every candidate races for a FIRST chunk. The instant one produces its
// first chunk, every other still-racing candidate is aborted and the
// winner's stream is relayed chunk-for-chunk from then on — no visible
// seam, from the client's side it looks like one model answering.
//
// If the winner itself drops out MID-stream (backend restarted, network
// blip, rate limit hit partway through, silently wedged with no more
// chunks ever arriving, etc.) this used to just surface that as a hard
// error — annoying when there are perfectly healthy candidates sitting
// right there that never even got a turn. Instead: on a mid-stream
// failure OR stall (see the withStallTimeout wrap in runStreamAttempt
// below — that's what turns a silent wedge into a real error this catch
// can see), immediately re-race the remaining candidates that haven't
// failed yet (skipping the ones already tried) and keep streaming from
// whichever of THEM answers first — repeating until either a candidate
// makes it all the way through, or every candidate has failed at least
// once, in which case the last error is what's surfaced. Text already
// shown stays shown either way; a mid-stream switch just means a fresh
// reply continues appending after it rather than the chat dying.
export async function* streamChatMeta(
  meta: ResolvedMetaModel,
  messages: ChatMessage[],
  opts: RoutedChatOptions
): AsyncGenerator<StreamChunk> {
  let remaining = meta.candidates;
  let lastError: unknown = null;

  while (remaining.length > 0) {
    const raceOver = new AbortController();
    const attempts = remaining.map((candidate, i) =>
      runStreamAttempt(candidate, i, meta.hedgeDelayMs, messages, opts, raceOver)
    );

    let winner: { candidate: MetaModelCandidateSpec; iterator: AsyncIterator<StreamChunk>; first: IteratorResult<StreamChunk> };
    try {
      winner = await firstSuccessful(attempts);
    } catch (err) {
      // Every remaining candidate failed before producing even a first
      // chunk — nothing left to fail over to.
      raceOver.abort();
      throw err;
    } finally {
      raceOver.abort();
    }

    try {
      if (!winner.first.done) yield winner.first.value;
      while (!winner.first.done) {
        winner.first = await winner.iterator.next();
        if (!winner.first.done) yield winner.first.value;
      }
      // Reached the natural end of the stream — done, no failover needed.
      return;
    } catch (err) {
      // Mid-stream failure: drop this candidate and, if any candidates
      // remain untried, loop back around to race them instead of dying.
      lastError = err;
      remaining = remaining.filter((c) => c !== winner.candidate);
      if (remaining.length === 0) throw err;
      // else: fall through to the top of the while loop and try again.
    }
  }
  // Unreachable in practice (the loop always returns or throws above),
  // but keeps TypeScript happy about the generator's control flow.
  if (lastError) throw lastError;
}

async function runStreamAttempt(
  candidate: MetaModelCandidateSpec,
  index: number,
  hedgeDelayMs: number,
  messages: ChatMessage[],
  opts: RoutedChatOptions,
  raceOver: AbortController
): Promise<{ candidate: MetaModelCandidateSpec; iterator: AsyncIterator<StreamChunk>; first: IteratorResult<StreamChunk> }> {
  await delay(index * hedgeDelayMs, raceOver.signal);
  if (raceOver.signal.aborted) throw new Error(`meta candidate ${candidate.label}: race already won elsewhere`);
  const controller = new AbortController();
  const onRaceOver = () => controller.abort();
  raceOver.signal.addEventListener("abort", onRaceOver);

  const generator =
    candidate.kind === "ollama"
      ? streamChat({ model: candidate.ollamaModel!, messages, ...opts, signal: controller.signal })
      : streamProviderChat(candidate.providerConfig!, {
          model: candidate.providerModel!,
          messages,
          ...opts,
          signal: controller.signal,
        });
  // Wrapping HERE (the individual candidate) rather than only around the
  // final routed stream in routes/chats.ts is the actual fix for "meta
  // model just drops out, have to keep retrying": a candidate that goes
  // silently wedged mid-stream — no error, just no more chunks — used to
  // be invisible to streamChatMeta's own failover logic (that only reacts
  // to a REJECTED iterator.next(), and a stall never rejects on its own).
  // It would sit there until the OUTER wrapper's 60s timeout killed the
  // whole multi-candidate reply outright, with nothing left to fail over
  // to by that point since the failure happened outside this generator
  // entirely. Wrapping the candidate's own iterator means a stall now
  // throws right here, which the existing mid-stream catch block in
  // streamChatMeta already treats exactly like any other candidate error
  // — dropping this one and re-racing whichever candidates are still
  // untried, same as a real connection error would.
  const iterator = withStallTimeout(generator)[Symbol.asyncIterator]();

  try {
    const first = await iterator.next();
    // Won: detach from raceOver so the caller's raceOver.abort() (fired
    // once a winner exists, to cancel every other candidate) doesn't also
    // cancel this one mid-stream.
    raceOver.signal.removeEventListener("abort", onRaceOver);
    return { candidate, iterator, first };
  } catch (err) {
    raceOver.signal.removeEventListener("abort", onRaceOver);
    throw err;
  }
}

// ---- Convenience wrappers: pick meta / provider / plain-Ollama routing
// in one call, so route handlers don't need three separate branches. ----
export async function resolveRoutedModel(
  prisma: FastifyInstance["prisma"],
  model: string
): Promise<
  | { kind: "meta"; meta: ResolvedMetaModel }
  | { kind: "provider"; config: ProviderConfig; modelName: string }
  | { kind: "ollama" }
> {
  const meta = await resolveMetaModel(prisma, model);
  if (meta) return { kind: "meta", meta };

  if (model.startsWith("provider:")) {
    const rest = model.slice("provider:".length);
    const separatorIndex = rest.indexOf(":");
    if (separatorIndex !== -1) {
      const providerId = rest.slice(0, separatorIndex);
      const modelName = rest.slice(separatorIndex + 1);
      const provider = await prisma.aiProvider.findUnique({ where: { id: providerId } });
      if (provider && provider.enabled) {
        return {
          kind: "provider",
          config: {
            type: provider.type as ProviderConfig["type"],
            apiKey: decryptSecret(provider.apiKeyEncrypted),
            baseUrl: provider.baseUrl,
          },
          modelName,
        };
      }
    }
  }

  return { kind: "ollama" };
}

export async function chatOnceRouted(
  prisma: FastifyInstance["prisma"],
  model: string,
  messages: ChatMessage[],
  opts: RoutedChatOptions
): Promise<ChatOnceResult> {
  const routed = await resolveRoutedModel(prisma, model);
  if (routed.kind === "meta") return chatOnceMeta(routed.meta, messages, opts);
  if (routed.kind === "provider") return chatOnceProvider(routed.config, { model: routed.modelName, messages, ...opts });
  return chatOnce({ model, messages, ...opts });
}

export async function* streamChatRouted(
  prisma: FastifyInstance["prisma"],
  model: string,
  messages: ChatMessage[],
  opts: RoutedChatOptions
): AsyncGenerator<StreamChunk> {
  const routed = await resolveRoutedModel(prisma, model);
  if (routed.kind === "meta") {
    yield* streamChatMeta(routed.meta, messages, opts);
    return;
  }
  if (routed.kind === "provider") {
    yield* streamProviderChat(routed.config, { model: routed.modelName, messages, ...opts });
    return;
  }
  yield* streamChat({ model, messages, ...opts });
}
