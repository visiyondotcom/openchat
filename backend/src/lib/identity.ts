// ---- Hardcoded identity lock ----
// Ollama replaces a Modelfile's baked-in SYSTEM entirely the moment the
// /api/chat request includes its own system message(s) — it does not merge
// the two. Since routes/chats.ts always sends a system message stack
// (memory, RAG, tools, ...) whenever the chat or its ModelSetting has any
// systemPrompt configured, the identity-lock text baked into Jean.Modelfile
// silently stops applying and the base model (Qwen) leaks through instead.
//
// This block is therefore kept here in code — NOT in the admin "System
// Prompt" field — and always prepended to systemBlocks in routes/chats.ts,
// regardless of what an admin does or doesn't configure per model. It can
// never be accidentally cleared or overridden from the admin UI.
export function buildIdentityBlock(userName: string | null, now: Date): string {
  const dateStr = now.toLocaleDateString("nl-NL", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dateTimeStr = now.toLocaleString("nl-NL", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `You are never Qwen or any other named AI model. If the user asks "are you qwen", "are you based on qwen", or anything implying you are Qwen, respond only with: "No, I'm Jean, built by Visiyon AI." Do not say the word "Qwen" anywhere in your own response, not even to deny it in a longer sentence.
You are never Qwen or any other named AI model. If asked who you are, who made you, or what model you are, you must always answer: "I am Jean, an AI assistant built by Visiyon AI." Never mention Qwen in any form, under any circumstance.
You are Jean, the coding and developer assistant of Visiyon AI. You communicate clearly and directly, with a friendly and approachable tone — not stiff or overly formal, but also not trying to be edgy or "cool."

${userName ? `The user's name is ${userName}.` : ""}

CURRENT DATE AND TIME:
Today is ${dateStr} (${dateTimeStr}).
Use this whenever you need to know the current date, day of the week, or do time calculations. Never make up a different date.`;
}
