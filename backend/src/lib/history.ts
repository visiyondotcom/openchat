// Without this, every turn re-sends the *entire* conversation so far as
// context — prompt tokens grow with every message (see quota.ts / the
// "Usage" widget), and on a long chat that eventually both blows the
// model's context window and eats the token quota before the user even
// asks their new question. This caps how much history actually gets sent:
// keep the most recent messages, drop the oldest ones once the running
// total would exceed MAX_HISTORY_TOKENS.
//
// The model still only ever "remembers" what's in this trimmed window —
// older turns are silently dropped from context (though still visible in
// the UI, since trimming only affects what's sent to Ollama, not what's
// persisted/displayed). That's an accuracy/cost tradeoff, not a bug: a
// very long chat was always going to need this once it outgrew the
// model's context window anyway.
export const MAX_HISTORY_TOKENS = Number(process.env.MAX_HISTORY_TOKENS) || 8000;

// Rough token estimate — not a real tokenizer (no tiktoken/gpt-tokenizer
// dependency in this project), just the standard "~4 characters per
// token" rule of thumb. That's fine here: this only decides *where to cut*
// the history, it doesn't need to be exact the way quota accounting does
// (quota.ts uses Ollama's own real prompt/completion counts for that).
const BASE64_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+\/=]+/g;

function estimateTokens(text: string): number {
  // Strip embedded base64 image data before estimating length, so a
  // generated image (which can be 1M+ characters of base64) doesn't
  // single-handedly blow the history token budget and get trimmed out
  // before it can ever be re-attached to a later user question.
  const withoutImages = text.replace(BASE64_IMAGE_RE, "[image]");
  return Math.ceil(withoutImages.length / 4);
}

export interface TrimmableMessage {
  role: string;
  content: string;
}

// Walks the history from newest to oldest, keeping messages until adding
// the next (older) one would exceed maxTokens, then stops — so the cut
// always happens at the oldest end, never in the middle of recent
// context. Always keeps at least the single most recent message, even if
// it alone exceeds the budget, so a very long user message never results
// in empty history being sent.
export function trimHistory<T extends TrimmableMessage>(history: T[], maxTokens: number = MAX_HISTORY_TOKENS): T[] {
  if (history.length === 0) return history;

  let total = 0;
  let cutIndex = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(history[i].content);
    if (total + tokens > maxTokens && total > 0) {
      cutIndex = i + 1;
      break;
    }
    total += tokens;
    cutIndex = i;
  }

  return history.slice(cutIndex);
}
