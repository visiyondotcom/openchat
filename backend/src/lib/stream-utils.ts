// Wraps an async chunk generator (Ollama/provider stream) so that a
// silently wedged connection — no error, just no more chunks ever
// arriving, seen with some local models mid-generation on a long file —
// throws after a period of silence instead of leaving the `for await`
// loop (and the client's SSE connection) hanging forever. Resets on every
// chunk received, so this only fires on genuine silence, not a
// slow-but-alive stream.
//
// Used in two places: wrapped around each individual meta-model candidate
// in lib/meta-model.ts, so a stalled candidate is treated the same as one
// that errored outright (triggering failover to the next candidate,
// instead of the whole multi-candidate race just hanging); and wrapped
// around the final routed stream in routes/chats.ts as the last-resort
// safety net for the plain (non-meta) single-model path, and for the rare
// case every meta-model candidate ends up stalled.
export const STALL_TIMEOUT_MS = 60_000;

export async function* withStallTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number = STALL_TIMEOUT_MS
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Model stream stalled: no data received for ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs
      );
    });
    let result;
    try {
      result = await Promise.race([iterator.next(), timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
    if (result.done) return;
    yield result.value;
  }
}
