import type { PrismaClient } from "@prisma/client";

// Free-tier fallback when neither the user's group nor an active plan
// configures a token quota. Keeps self-hosted deployments that haven't
// touched Admin > Settings from handing out unlimited generation by
// default — set the group's dailyTokenQuota (or a plan quota) to a higher
// number, there is no separate "unlimited" sentinel.
// This is now just the env-var-driven fallback; the effective default can
// be overridden per-deployment from Admin > Settings > Usage limits (see
// loadQuotaConfig below) without a redeploy.
export const DEFAULT_TOKEN_QUOTA_ENV = Number(process.env.DEFAULT_TOKEN_QUOTA) || 5000;

// Image generation has no natural "token count" of its own, but it should
// still count against the same rolling-window budget as chat tokens rather
// than having a separate, disconnected cap — one combined number is what
// the "Usage" widget and the subscription plans show. This is the flat
// token-equivalent cost charged per generated image; override with the
// IMAGE_TOKEN_COST env var if a deployment wants images to weigh more or
// less relative to chat usage.
export const IMAGE_TOKEN_COST = Number(process.env.IMAGE_TOKEN_COST) || 1000;

// Rolling window length, in hours — same idea as Claude.ai's 5-hour window
// rather than a hard reset at midnight UTC: usage from N hours ago ages out
// continuously, instead of the whole budget snapping back to full at one
// fixed clock time. This is the env-var fallback; loadQuotaConfig below
// lets an admin override it from the panel without a redeploy.
export const QUOTA_WINDOW_HOURS_ENV = Number(process.env.QUOTA_WINDOW_HOURS) || 5;

// ---- Config resolution ----
// Same "DB wins, falls back to env" pattern as lib/billing.ts / lib/music.ts:
// an admin can set the default token quota and window length from
// Admin > Settings > Usage limits (stored on the AppSettings singleton
// row); a field left empty in the DB falls back to its env var. Cached
// in-memory for CACHE_TTL_MS; admin.ts calls invalidateQuotaConfigCache()
// right after a save so a change takes effect immediately.
type QuotaConfig = {
  defaultTokenQuota: number;
  windowHours: number;
  windowMs: number;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: QuotaConfig; expiresAt: number } | null = null;

export function invalidateQuotaConfigCache(): void {
  cache = null;
}

export async function loadQuotaConfig(prisma?: PrismaClient): Promise<QuotaConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: { defaultTokenQuota: number | null; quotaWindowHours: number | null } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { defaultTokenQuota: true, quotaWindowHours: true },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every quota check.
      row = null;
    }
  }

  const windowHours = row?.quotaWindowHours || QUOTA_WINDOW_HOURS_ENV;
  const value: QuotaConfig = {
    defaultTokenQuota: row?.defaultTokenQuota || DEFAULT_TOKEN_QUOTA_ENV,
    windowHours,
    windowMs: windowHours * 60 * 60 * 1000,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export class QuotaExceededError extends Error {
  // resetAt tells the caller/UI exactly when enough budget will free up
  // again — the moment the oldest event currently inside the window ages
  // out of it — rather than "midnight", since there's no fixed reset
  // instant anymore.
  constructor(public limit: number, public resetAt: Date | null, windowHours: number) {
    super(`Token quota of ${limit} reached for the current ${windowHours}h window`);
  }
}

async function windowStart(prisma?: PrismaClient): Promise<Date> {
  const { windowMs } = await loadQuotaConfig(prisma);
  return new Date(Date.now() - windowMs);
}

async function effectiveQuota(
  prisma: PrismaClient,
  userId: string,
  config: QuotaConfig,
): Promise<{ dailyTokenQuota: number | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      group: { select: { dailyTokenQuota: true } },
    },
  });

  // Admins aren't rate-limited by the session quota — it exists to keep a
  // shared Ollama instance from being monopolized by one regular user, not
  // to throttle the people running the deployment. A null quota means
  // "unlimited" all the way through assertTokenQuota/getTodayUsage below;
  // the frontend already treats a null dailyTokenQuota as "don't show a
  // percentage or limit banner" (see ChatWindow's usagePct calc).
  if (user?.role === "ADMIN") {
    return { dailyTokenQuota: null };
  }

  const fromGroup = user?.group?.dailyTokenQuota ?? null;

  // Tokens always resolve to a real number for non-admins — see
  // config.defaultTokenQuota (Admin > Settings > Usage limits, env-fallback).
  return { dailyTokenQuota: fromGroup ?? config.defaultTokenQuota };
}

// Sums tokens from every QuotaEvent still inside the rolling window. Also
// returns the createdAt of the oldest event in that window, since that's
// the moment its tokens will age out and free up budget — used to compute
// QuotaExceededError.resetAt and the "Usage" widget's reset countdown.
async function windowUsage(
  prisma: PrismaClient,
  userId: string,
  config: QuotaConfig,
): Promise<{ used: number; oldestInWindow: Date | null }> {
  const since = new Date(Date.now() - config.windowMs);

  const [agg, oldest] = await Promise.all([
    prisma.quotaEvent.aggregate({
      where: { userId, createdAt: { gte: since } },
      _sum: { tokens: true },
    }),
    prisma.quotaEvent.findFirst({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    used: agg._sum.tokens ?? 0,
    oldestInWindow: oldest?.createdAt ?? null,
  };
}

// Call before starting generation (chat or image). Throws if the user has
// already used up this window's token budget — cheap check, no write, so
// an over-quota user never triggers a model/image call. The actual spend
// for *this* turn isn't known until generation finishes (chat) or is a
// fixed cost (image) — see recordTokenUsage below — so this only guards
// against starting a new turn once already over the limit.
export async function assertTokenQuota(prisma: PrismaClient, userId: string): Promise<void> {
  const config = await loadQuotaConfig(prisma);
  const { dailyTokenQuota } = await effectiveQuota(prisma, userId, config);
  if (dailyTokenQuota == null) return; // unlimited (admin)

  const { used, oldestInWindow } = await windowUsage(prisma, userId, config);
  if (used >= dailyTokenQuota) {
    // The window frees up gradually, not all at once: budget becomes
    // available again the instant the oldest event currently counted
    // slides out of the window, not at some fixed reset time.
    const resetAt = oldestInWindow ? new Date(oldestInWindow.getTime() + config.windowMs) : null;
    throw new QuotaExceededError(dailyTokenQuota, resetAt, config.windowHours);
  }
}

// Call once generation finishes, with the real prompt+completion token
// count for a chat turn, or IMAGE_TOKEN_COST for a generated image — both
// draw from the same rolling-window total. Recorded unconditionally so the
// "Usage" widget always reflects real activity. Each call is its own
// QuotaEvent row (rather than an upsert-and-increment on a day bucket),
// which is what makes the rolling window possible: each event ages out of
// the window independently, QUOTA_WINDOW_HOURS after it happened.
export async function recordTokenUsage(prisma: PrismaClient, userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  await prisma.quotaEvent.create({ data: { userId, tokens, isImage: false } });
}

// Purely informational — bumps the "images generated" counter shown in the
// UI. Doesn't gate anything itself; the actual spend/enforcement for an
// image happens via assertTokenQuota + recordTokenUsage above. Recorded as
// its own zero-token event (rather than folded into the chat-tokens event)
// so the per-event isImage flag can drive an accurate image count within
// the rolling window.
export async function recordImageGenerated(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.quotaEvent.create({ data: { userId, tokens: 0, isImage: true } });
}

export async function getTodayUsage(prisma: PrismaClient, userId: string) {
  const config = await loadQuotaConfig(prisma);
  const { used, oldestInWindow } = await windowUsage(prisma, userId, config);
  const quota = await effectiveQuota(prisma, userId, config);

  const imageCount = await prisma.quotaEvent.count({
    where: { userId, createdAt: { gte: await windowStart(prisma) }, isImage: true },
  });

  return {
    tokenCount: used,
    imageCount,
    dailyTokenQuota: quota.dailyTokenQuota,
    windowHours: config.windowHours,
    // When the oldest event in the window ages out and some budget frees
    // up. Null means the window is currently empty (no reset pending).
    resetAt: oldestInWindow ? new Date(oldestInWindow.getTime() + config.windowMs) : null,
  };
}

export type UsageHistoryRange = "day" | "month" | "year";

// Buckets this user's QuotaEvent rows for the Usage & Analytics chart.
// "day" -> last 24 buckets of 1h, "month" -> last 30 daily buckets,
// "year" -> last 12 monthly buckets. Each bucket reports tokens spent and
// images generated in that slice, plus an ISO label the frontend formats.
export async function getUsageHistory(prisma: PrismaClient, userId: string, range: UsageHistoryRange) {
  const now = new Date();
  const bucketCount = range === "day" ? 24 : range === "month" ? 30 : 12;
  const bucketMs =
    range === "day" ? 60 * 60 * 1000 : range === "month" ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;

  const since = new Date(now.getTime() - bucketCount * bucketMs);
  const events = await prisma.quotaEvent.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { tokens: true, isImage: true, createdAt: true },
  });

  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const bucketStart = new Date(since.getTime() + i * bucketMs);
    return { bucketStart, tokens: 0, images: 0 };
  });

  for (const ev of events) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ev.createdAt.getTime() - since.getTime()) / bucketMs)));
    buckets[idx].tokens += ev.tokens;
    if (ev.isImage) buckets[idx].images += 1;
  }

  return buckets.map((b) => ({
    date: b.bucketStart.toISOString(),
    tokens: b.tokens,
    images: b.images,
  }));
}
