// ---- Brand-name scrubbing ----
// Visiyon AI's models are branded as "Jean" everywhere a user can see —
// see lib/identity.ts for why the model itself can say the wrong thing at
// generation time. This file closes the other leak: raw Ollama tags (e.g.
// "qwen3.5:4b") showing up verbatim in the UI whenever an admin hasn't set
// an explicit displayName override (routes/models.ts, and the public share
// page in routes/chats.ts). An admin override always wins over this — this
// is only the fallback used when there isn't one.
const QWEN_PATTERN = /qwen/i;

// Pulls a human-ish size suffix ("4b", "30b-a3b", "7b-instruct-q4_K_M", ...)
// off an Ollama tag so the fallback can still say *something* useful
// ("Jean 4B") instead of just "Jean" for every single size variant.
function extractSizeLabel(rawName: string): string | null {
  const tag = rawName.split(":")[1] ?? "";
  const match = tag.match(/^(\d+(?:\.\d+)?[bB])/);
  return match ? match[1].toUpperCase() : null;
}

// Returns a safe display name for a raw model identifier. Non-Qwen models
// are returned unchanged — this only rewrites the one name that must never
// reach an end user.
export function safeDisplayName(rawName: string): string {
  if (!QWEN_PATTERN.test(rawName)) return rawName;
  const size = extractSizeLabel(rawName);
  return size ? `Jean ${size}` : "Jean";
}

// Same idea, for a piece of Ollama metadata (family, quantization, ...)
// rather than the model tag itself — used anywhere that field is ever
// surfaced to a non-admin.
export function scrubField(value: string | null | undefined): string | undefined {
  if (!value) return value ?? undefined;
  return QWEN_PATTERN.test(value) ? undefined : value;
}

// ---- Belt-and-suspenders for generated text ----
// buildIdentityBlock (lib/identity.ts) makes the model itself avoid saying
// "Qwen", but prompting is never 100% reliable. This is a second, dumb
// layer applied to the model's own output as it's written to the client
// and to the DB: a case-insensitive word swap, "Qwen" -> "Jean".
// Known limitation: true token-by-token streaming means this runs once per
// chunk, not once over the whole reply — if a chunk boundary ever landed
// exactly inside the word "Qwen" (e.g. one chunk ends "...Qw", the next
// starts "en...") the split halves wouldn't match the pattern individually
// and could slip through. In practice this is rare (it's a single BPE
// token for essentially every tokenizer), and the prompt-level block above
// is what does the real work — this just mops up the common case.
const QWEN_WORD_PATTERN = /qwen(?:[\s-]?(?:1\.5|2(?:\.5)?|3(?:\.5)?))?/gi;

export function scrubQwenMentions(text: string): string {
  if (!text) return text;
  return text.replace(QWEN_WORD_PATTERN, "Jean");
}
