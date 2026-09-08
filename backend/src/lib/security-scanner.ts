import type { FastifyInstance } from "fastify";

const TICK_MS = 2 * 60 * 1000; // scan every 2 minutes
const LOOKBACK_MS = 15 * 60 * 1000; // over a rolling 15-minute window

// A user sending the exact same message text into this many *different*
// chats within the lookback window looks like scripted spam, not a person
// typing — a real user re-asking the same question twice in one chat is
// normal, the same text fanned out across many chats is not.
const DUPLICATE_CONTENT_THRESHOLD = 4;

// Far more messages than a normal interactive session would produce in 15
// minutes — high enough that a fast typist mid-conversation never trips it.
const MESSAGE_RATE_THRESHOLD = 60;

// New accounts within the window sharing the same suspicious pattern.
const RAPID_SIGNUP_THRESHOLD = 8;

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
}

async function detectDuplicateContentBursts(app: FastifyInstance, since: Date): Promise<void> {
  const messages = await app.prisma.message.findMany({
    where: { role: "USER", createdAt: { gte: since } },
    select: { content: true, chatId: true, chat: { select: { userId: true } } },
  });

  // userId -> normalized content -> set of distinct chatIds it appeared in
  const byUser = new Map<string, Map<string, Set<string>>>();
  for (const m of messages) {
    const userId = m.chat.userId;
    const key = normalize(m.content);
    if (!key) continue;
    if (!byUser.has(userId)) byUser.set(userId, new Map());
    const perUser = byUser.get(userId)!;
    if (!perUser.has(key)) perUser.set(key, new Set());
    perUser.get(key)!.add(m.chatId);
  }

  for (const [userId, contents] of byUser) {
    for (const [content, chatIds] of contents) {
      if (chatIds.size < DUPLICATE_CONTENT_THRESHOLD) continue;

      // Don't re-alert on the same user+pattern every tick while it's
      // still ongoing — only open a new alert if there isn't already an
      // OPEN one for this user of this type from the current window.
      const existing = await app.prisma.securityAlert.findFirst({
        where: { userId, type: "DUPLICATE_CONTENT_BURST", status: "OPEN", createdAt: { gte: since } },
      });
      if (existing) continue;

      await app.prisma.securityAlert.create({
        data: {
          type: "DUPLICATE_CONTENT_BURST",
          userId,
          summary: `Same message sent to ${chatIds.size} different chats within 15 minutes`,
          detail: { sample: content.slice(0, 200), chatCount: chatIds.size },
        },
      });
    }
  }
}

async function detectMessageRateBursts(app: FastifyInstance, since: Date): Promise<void> {
  const counts = await app.prisma.message.groupBy({
    by: ["chatId"],
    where: { role: "USER", createdAt: { gte: since } },
    _count: { _all: true },
  });
  if (counts.length === 0) return;

  const chatIds = counts.filter((c) => c._count._all >= MESSAGE_RATE_THRESHOLD).map((c) => c.chatId);
  if (chatIds.length === 0) return;

  const chats = await app.prisma.chat.findMany({ where: { id: { in: chatIds } }, select: { id: true, userId: true } });
  const countByChat = new Map(counts.map((c) => [c.chatId, c._count._all]));

  for (const chat of chats) {
    const existing = await app.prisma.securityAlert.findFirst({
      where: { userId: chat.userId, type: "MESSAGE_RATE_BURST", status: "OPEN", createdAt: { gte: since } },
    });
    if (existing) continue;

    await app.prisma.securityAlert.create({
      data: {
        type: "MESSAGE_RATE_BURST",
        userId: chat.userId,
        summary: `${countByChat.get(chat.id)} messages sent in one chat within 15 minutes`,
        detail: { chatId: chat.id, count: countByChat.get(chat.id) },
      },
    });
  }
}

async function detectRapidSignups(app: FastifyInstance, since: Date): Promise<void> {
  const recentUsers = await app.prisma.user.count({ where: { createdAt: { gte: since } } });
  if (recentUsers < RAPID_SIGNUP_THRESHOLD) return;

  const existing = await app.prisma.securityAlert.findFirst({
    where: { type: "RAPID_SIGNUP", status: "OPEN", createdAt: { gte: since } },
  });
  if (existing) return;

  await app.prisma.securityAlert.create({
    data: {
      type: "RAPID_SIGNUP",
      summary: `${recentUsers} new accounts created within 15 minutes`,
      detail: { count: recentUsers },
    },
  });
}

async function tick(app: FastifyInstance): Promise<void> {
  try {
    const since = new Date(Date.now() - LOOKBACK_MS);
    await Promise.all([
      detectDuplicateContentBursts(app, since),
      detectMessageRateBursts(app, since),
      detectRapidSignups(app, since),
    ]);
  } catch (err) {
    app.log.error({ err }, "security scanner tick failed");
  }
}

// Starts the 24/7 platform-protection loop — runs independently of any
// single user's session, scanning the whole instance for spam/abuse
// patterns and writing SecurityAlert rows the admin dashboard reads.
export function scheduleSecurityScanner(app: FastifyInstance): void {
  setTimeout(() => tick(app), 10_000);
  const timer = setInterval(() => tick(app), TICK_MS);
  timer.unref();
}
