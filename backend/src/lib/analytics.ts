import type { PrismaClient } from "@prisma/client";

// Optional cost estimate — self-hosted Ollama has no per-token API cost,
// but an admin may still want to attach a $/1M-token figure (e.g. to
// compare against what the same usage would cost on a hosted API, or to
// account for GPU/electricity cost per model). Configured entirely via
// env so no code change is needed; unconfigured models just show token
// counts with no cost column. Format matches other env-driven config in
// this codebase (STRIPE_PLANS, STRIPE_PLAN_QUOTAS):
//   MODEL_COST_PER_1M="glm4:9b:0.10:0.30,granite4.1:8b:0.05:0.15"
//   (modelName:inputPricePer1M:outputPricePer1M, comma-separated)
function modelCosts(): Record<string, { input: number; output: number }> {
  const raw = process.env.MODEL_COST_PER_1M || "";
  const out: Record<string, { input: number; output: number }> = {};
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    if (parts.length !== 3) continue;
    const [model, input, output] = parts;
    const inputNum = Number(input);
    const outputNum = Number(output);
    if (Number.isFinite(inputNum) && Number.isFinite(outputNum)) {
      out[model] = { input: inputNum, output: outputNum };
    }
  }
  return out;
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number | null {
  const costs = modelCosts();
  const rate = costs[model];
  if (!rate) return null;
  return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ---- Top-line summary card: totals across the whole window ----
export async function getAnalyticsSummary(prisma: PrismaClient, days: number) {
  const since = daysAgo(days);

  const [messageCount, activeUserCount, activeChatCount, tokenAgg] = await Promise.all([
    prisma.message.count({ where: { createdAt: { gte: since }, role: { in: ["USER", "ASSISTANT"] } } }),
    prisma.chat.findMany({
      where: { messages: { some: { createdAt: { gte: since } } } },
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.chat.count({ where: { messages: { some: { createdAt: { gte: since } } } } }),
    prisma.message.aggregate({
      where: { createdAt: { gte: since }, role: "ASSISTANT" },
      _sum: { promptTokens: true, completionTokens: true },
    }),
  ]);

  const promptTokens = tokenAgg._sum.promptTokens ?? 0;
  const completionTokens = tokenAgg._sum.completionTokens ?? 0;

  return {
    days,
    messageCount,
    activeUserCount: activeUserCount.length,
    activeChatCount,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

// ---- Per-day timeseries for the line chart ----
export async function getAnalyticsTimeseries(prisma: PrismaClient, days: number) {
  const since = daysAgo(days);
  // Raw SQL: Prisma's groupBy can't truncate a timestamp to a day, and
  // this needs to run against Postgres's date_trunc for an accurate
  // per-UTC-day bucket regardless of row volume.
  const rows = await prisma.$queryRaw<
    { day: Date; message_count: bigint; prompt_tokens: bigint | null; completion_tokens: bigint | null }[]
  >`
    SELECT
      date_trunc('day', "createdAt") AS day,
      COUNT(*) FILTER (WHERE role IN ('USER', 'ASSISTANT')) AS message_count,
      SUM("promptTokens") AS prompt_tokens,
      SUM("completionTokens") AS completion_tokens
    FROM "Message"
    WHERE "createdAt" >= ${since}
    GROUP BY day
    ORDER BY day ASC
  `;

  return rows.map((r) => ({
    date: r.day.toISOString().slice(0, 10),
    messageCount: Number(r.message_count),
    promptTokens: Number(r.prompt_tokens ?? 0),
    completionTokens: Number(r.completion_tokens ?? 0),
  }));
}

// ---- Per-model breakdown: usage + estimated cost ----
export async function getAnalyticsByModel(prisma: PrismaClient, days: number) {
  const since = daysAgo(days);
  const rows = await prisma.message.groupBy({
    by: ["model"],
    where: { createdAt: { gte: since }, role: "ASSISTANT", model: { not: null } },
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true },
  });

  return rows
    .map((r) => {
      const promptTokens = r._sum.promptTokens ?? 0;
      const completionTokens = r._sum.completionTokens ?? 0;
      return {
        model: r.model as string,
        messageCount: r._count._all,
        promptTokens,
        completionTokens,
        estimatedCost: estimateCost(r.model as string, promptTokens, completionTokens),
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount);
}

// ---- Per-user breakdown: usage, tokens, last active — the "who's using
// what" view for admin monitoring ----
export async function getAnalyticsByUser(prisma: PrismaClient, days: number) {
  const since = daysAgo(days);

  const rows = await prisma.$queryRaw<
    {
      user_id: string;
      message_count: bigint;
      prompt_tokens: bigint | null;
      completion_tokens: bigint | null;
      last_active: Date;
    }[]
  >`
    SELECT
      c."userId" AS user_id,
      COUNT(*) FILTER (WHERE m.role IN ('USER', 'ASSISTANT')) AS message_count,
      SUM(m."promptTokens") AS prompt_tokens,
      SUM(m."completionTokens") AS completion_tokens,
      MAX(m."createdAt") AS last_active
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE m."createdAt" >= ${since}
    GROUP BY c."userId"
    ORDER BY message_count DESC
  `;

  if (rows.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.user_id) } },
    select: { id: true, email: true, name: true, role: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => {
    const user = userMap.get(r.user_id);
    const promptTokens = Number(r.prompt_tokens ?? 0);
    const completionTokens = Number(r.completion_tokens ?? 0);
    return {
      userId: r.user_id,
      email: user?.email ?? "(deleted user)",
      name: user?.name ?? null,
      role: user?.role ?? null,
      messageCount: Number(r.message_count),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      lastActive: r.last_active,
    };
  });
}

// ---- Functions usage: how much each Filter/Pipe/Action is actually
// running, and whether it's currently healthy (lastError). Cheap to
// compute — small tables, no time-window aggregation needed since we only
// track "last run", not a full run history.
export async function getFunctionsUsage(prisma: PrismaClient) {
  const [filters, pipes, actions] = await Promise.all([
    prisma.filter.findMany({ select: { id: true, name: true, enabled: true, lastRunAt: true, lastError: true } }),
    prisma.pipe.findMany({ select: { id: true, name: true, slug: true, enabled: true, lastRunAt: true, lastError: true } }),
    prisma.action.findMany({ select: { id: true, name: true, enabled: true, lastRunAt: true, lastError: true } }),
  ]);
  return { filters, pipes, actions };
}
