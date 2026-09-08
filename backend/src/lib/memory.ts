// AI memory: durable facts about a user (name, preferences, ongoing
// projects, recurring context) that get injected into every new chat's
// system prompt, the same way Claude's memory files work — except kept
// as a flat list of short text facts (UserMemory rows) instead of a
// folder structure, which is enough for a single-assistant app like this.
//
// Gated by two AppSettings toggles (both pre-existed in the schema/admin
// UI but were never wired to anything until now):
//   memoriesEnabled            — master switch, gates extraction+storage
//   memorySystemContextEnabled — gates injecting facts into the system
//                                prompt (storage can be on with this off,
//                                e.g. an admin building up profiles by
//                                hand before turning injection on)
//
// Managed by admins from Admin > Users > a user > Memory (see
// routes/admin.ts's /admin/users/:userId/memories endpoints).

import type { PrismaClient } from "@prisma/client";
import { chatOnce } from "./ollama.js";

const CACHE_TTL_MS = 30_000;
let cache: { value: { memoriesEnabled: boolean; contextEnabled: boolean }; expiresAt: number } | null = null;

export function invalidateMemorySettingsCache(): void {
  cache = null;
}

async function loadSettings(prisma: PrismaClient) {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  let row: { memoriesEnabled: boolean; memorySystemContextEnabled: boolean } | null = null;
  try {
    row = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { memoriesEnabled: true, memorySystemContextEnabled: true },
    });
  } catch {
    row = null;
  }
  // Matches the Prisma schema @default(true) for both fields — same
  // "on by default" behavior as before these were wired up.
  const value = {
    memoriesEnabled: row?.memoriesEnabled ?? true,
    contextEnabled: row?.memorySystemContextEnabled ?? true,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

// Read-only check used by the self-service "/auth/me/memories" routes (see
// routes/auth.ts) so a user can't view/edit their own memory when an admin
// has turned the feature off platform-wide.
export async function memoriesEnabled(prisma: PrismaClient): Promise<boolean> {
  const settings = await loadSettings(prisma);
  return settings.memoriesEnabled;
}

const MAX_FACTS_PER_USER = 60;
// Topics are a rolling window of "what we talked about" rather than
// durable facts, so keep far fewer — this is meant to read like a
// person's fuzzy memory of recent conversations, not a full history.
const MAX_TOPICS_PER_USER = 20;

// Builds the system-prompt block injected into every new chat turn —
// the user's name (always, when known and memory isn't fully disabled),
// every stored durable fact, and a short list of recent conversation
// topics so the assistant carries context the way a person would
// ("we talked about X last time") rather than only remembering fixed
// preferences. Returns "" when there's nothing to say, so callers can
// just .filter(Boolean) it in with the other optional system blocks.
export async function getMemoryContextBlock(prisma: PrismaClient, userId: string): Promise<string> {
  const settings = await loadSettings(prisma);
  if (!settings.memoriesEnabled || !settings.contextEnabled) return "";

  const [user, memories] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    prisma.userMemory.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);

  const facts = memories.filter((m) => m.source !== "topic");
  // Most recent topics first, and only the tail of the window — older
  // topics fade out the same way MAX_TOPICS_PER_USER trims storage.
  const topics = memories.filter((m) => m.source === "topic").slice(-MAX_TOPICS_PER_USER).reverse();

  const lines: string[] = [];
  if (user?.name) lines.push(`The user's name is ${user.name}.`);
  for (const f of facts) lines.push(`- ${f.content}`);

  const topicLines = topics.map((t) => `- ${t.content}`);

  if (lines.length === 0 && topicLines.length === 0) return "";

  const blocks: string[] = [];
  if (lines.length > 0) {
    blocks.push(
      [
        "What you remember about this user from past conversations (use naturally, don't recite this list back to them unless asked):",
        ...lines,
      ].join("\n")
    );
  }
  if (topicLines.length > 0) {
    blocks.push(
      [
        "Recent things you've talked about together, most recent first (for context only — don't bring these up unprompted, just recognize continuity if the user references them):",
        ...topicLines,
      ].join("\n")
    );
  }
  return blocks.join("\n\n");
}

// Extracts durable, worth-remembering facts from one exchange and stores
// any new ones. Deliberately conservative — a small dedicated model call
// with a strict prompt, since a chatty/over-eager extractor would clutter
// a user's profile with one-off details instead of real patterns. Always
// best-effort and non-fatal: called fire-and-forget after a response
// finishes, so a failure here (model down, JSON parse error, ...) never
// affects the chat itself — same pattern as web search failures.
export async function extractAndSaveMemory(
  prisma: PrismaClient,
  userId: string,
  model: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const settings = await loadSettings(prisma);
  if (!settings.memoriesEnabled) return;
  // Nothing substantive to extract from very short exchanges — cheap
  // guard that skips the extra model call entirely for e.g. "thanks" /
  // "ok" turns, which are the majority of a typical conversation.
  if (userMessage.trim().length < 12) return;

  const existing = await prisma.userMemory.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, content: true, source: true },
  });
  const existingFacts = existing.filter((f) => f.source !== "topic");
  const existingTopics = existing.filter((f) => f.source === "topic");

  // Two separate extraction targets from one exchange:
  //  - facts: durable, cross-conversation truths (preferences, role,
  //    stack, recurring habits, explicit behavior corrections like
  //    "be more concise" — these actively change how the assistant
  //    behaves in future chats, same as the rest of the fact list).
  //  - topic: one short line capturing what THIS exchange was about,
  //    so the assistant carries a rolling sense of recent conversation
  //    history the way a person naturally would, without every one-off
  //    question turning into a permanent "fact". Omit topic entirely
  //    for trivial/small-talk exchanges.
  const prompt = [
    "You are updating an assistant's memory of a user after one exchange. Produce two things:",
    "1. \"facts\": new DURABLE facts about the user that would still be true weeks from now — stated preferences, role/occupation, ongoing projects, recurring habits, tools/stack, and especially explicit corrections about how the assistant should behave (tone, length, format, what to avoid). Do not repeat facts already known. Do not include one-off requests or the assistant's own suggestions.",
    "2. \"topic\": ONE short line (under 20 words) summarizing what this specific exchange was about, written like a person's memory of the conversation (e.g. \"Hielp met het debuggen van een auth-bug in de Next.js migratie\"). Use empty string \"\" if the exchange was trivial small talk with nothing worth recalling later.",
    "Reply with ONLY JSON in this exact shape, nothing else: {\"facts\": [\"...\"], \"topic\": \"...\"}",
    "",
    "Facts already known about this user (do not repeat these):",
    existingFacts.length > 0 ? existingFacts.map((f) => `- ${f.content}`).join("\n") : "(none yet)",
    "",
    `User: ${userMessage.slice(0, 2000)}`,
    `Assistant: ${assistantMessage.slice(0, 1000)}`,
  ].join("\n");

  let raw: string;
  try {
    const result = await chatOnce({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      think: false,
    });
    raw = result.content;
  } catch {
    // Model unreachable, wrong model id (e.g. an external-provider model
    // this Ollama-only helper can't call), etc — skip silently.
    return;
  }

  let parsed: unknown;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const { facts, topic } = parsed as { facts?: unknown; topic?: unknown };

  const newFacts = Array.isArray(facts)
    ? facts
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0 && f.trim().length < 200)
        .map((f) => f.trim())
        .filter((f) => !existingFacts.some((e) => e.content.toLowerCase() === f.toLowerCase()))
    : [];

  const newTopic = typeof topic === "string" && topic.trim().length > 0 && topic.trim().length < 200
    ? topic.trim()
    : null;

  if (newFacts.length === 0 && !newTopic) return;

  const rows: { userId: string; content: string; source: string }[] = newFacts.map((content) => ({
    userId,
    content,
    source: "user",
  }));
  if (newTopic) rows.push({ userId, content: newTopic, source: "topic" });

  await prisma.userMemory.createMany({ data: rows });

  // Keep each list bounded independently — durable facts and rolling
  // topics trim to their own caps so topics (much shorter-lived) don't
  // crowd out durable facts or vice versa.
  if (newFacts.length > 0) {
    const totalFacts = await prisma.userMemory.count({ where: { userId, source: { not: "topic" } } });
    if (totalFacts > MAX_FACTS_PER_USER) {
      const toDelete = await prisma.userMemory.findMany({
        where: { userId, source: { not: "topic" } },
        orderBy: { createdAt: "asc" },
        take: totalFacts - MAX_FACTS_PER_USER,
        select: { id: true },
      });
      await prisma.userMemory.deleteMany({ where: { id: { in: toDelete.map((d) => d.id) } } });
    }
  }
  if (newTopic) {
    const totalTopics = existingTopics.length + 1;
    if (totalTopics > MAX_TOPICS_PER_USER) {
      const toDelete = await prisma.userMemory.findMany({
        where: { userId, source: "topic" },
        orderBy: { createdAt: "asc" },
        take: totalTopics - MAX_TOPICS_PER_USER,
        select: { id: true },
      });
      await prisma.userMemory.deleteMany({ where: { id: { in: toDelete.map((d) => d.id) } } });
    }
  }
}
