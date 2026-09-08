import type { FastifyInstance } from "fastify";
import { chatOnce } from "./ollama.js";
import { assertTokenQuota, recordTokenUsage, QuotaExceededError } from "./quota.js";

// How often the scheduler wakes up to check for due automations. One
// minute is fine granularity for an intervalMinutes-based schedule — an
// automation set to run "every 5 min" will actually fire within 5-6 min of
// the target, never later than one tick past it.
const TICK_MS = 60 * 1000;

// Caps how many automations run at once per tick so a user with dozens of
// hourly jobs that all happen to line up can't spike Ollama/DB load all at
// the same second.
const MAX_CONCURRENT_RUNS = 3;

async function runOne(app: FastifyInstance, automation: {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  model: string;
  intervalMinutes: number;
  chatId: string | null;
}): Promise<void> {
  const prisma = app.prisma;

  // Quota is enforced exactly like an interactive chat message — an
  // automation is still "the user" spending tokens, just without them
  // present to click send. A user who's out of budget doesn't get free
  // 24/7 generation just because it's unattended.
  try {
    await assertTokenQuota(prisma, automation.userId);
  } catch (err) {
    const message = err instanceof QuotaExceededError ? err.message : "Quota check failed";
    await prisma.automation.update({
      where: { id: automation.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + automation.intervalMinutes * 60 * 1000),
        lastError: message,
      },
    });
    await prisma.automationRun.create({
      data: { automationId: automation.id, status: "FAILED", error: message, finishedAt: new Date() },
    });
    return;
  }

  let chatId = automation.chatId;
  if (!chatId) {
    const chat = await prisma.chat.create({
      data: { userId: automation.userId, model: automation.model, title: automation.name },
    });
    chatId = chat.id;
    await prisma.automation.update({ where: { id: automation.id }, data: { chatId } });
  }

  try {
    // Give the model the recent transcript of its own past runs as
    // context, the same way a normal chat would — so a monitoring
    // automation can reference "vs. last hour" instead of starting cold
    // on every run.
    const history = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
      take: 40,
      select: { role: true, content: true },
    });

    const messages = [
      ...history.map((m) => ({
        role: m.role.toLowerCase() as "user" | "assistant" | "system",
        content: m.content,
      })),
      { role: "user" as const, content: automation.prompt },
    ];

    const result = await chatOnce({ model: automation.model, messages });

    await prisma.$transaction([
      prisma.message.create({
        data: { chatId, role: "USER", content: automation.prompt },
      }),
      prisma.message.create({
        data: {
          chatId,
          role: "ASSISTANT",
          content: result.content,
          model: automation.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        },
      }),
      prisma.automation.update({
        where: { id: automation.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: new Date(Date.now() + automation.intervalMinutes * 60 * 1000),
          lastError: null,
        },
      }),
      prisma.automationRun.create({
        data: {
          automationId: automation.id,
          status: "SUCCESS",
          output: result.content,
          finishedAt: new Date(),
        },
      }),
    ]);

    const totalTokens = (result.promptTokens ?? 0) + (result.completionTokens ?? 0);
    if (totalTokens > 0) await recordTokenUsage(prisma, automation.userId, totalTokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Automation run failed";
    app.log.error({ err, automationId: automation.id }, "automation run failed");
    await prisma.automation.update({
      where: { id: automation.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + automation.intervalMinutes * 60 * 1000),
        lastError: message,
      },
    });
    await prisma.automationRun.create({
      data: { automationId: automation.id, status: "FAILED", error: message, finishedAt: new Date() },
    });
  }
}

async function tick(app: FastifyInstance): Promise<void> {
  try {
    const settings = await app.prisma.appSettings.findUnique({ where: { id: "singleton" } });
    // Instance-wide kill switch (Admin > Settings > Automations). Off by
    // default has no meaning here since existing rows just keep their
    // enabled flag — this only stops the scheduler from picking up *new*
    // due runs while off; nothing is deleted.
    if (settings && settings.automationsEnabled === false) return;

    const due = await app.prisma.automation.findMany({
      where: { enabled: true, nextRunAt: { lte: new Date() } },
      take: MAX_CONCURRENT_RUNS,
      orderBy: { nextRunAt: "asc" },
    });
    if (due.length === 0) return;

    await Promise.all(due.map((a) => runOne(app, a)));
  } catch (err) {
    app.log.error({ err }, "automation scheduler tick failed");
  }
}

// Starts the 24/7 background loop. Runs once shortly after boot (so a
// restarted backend doesn't wait a full tick before picking up overdue
// jobs) and then every TICK_MS thereafter for as long as the process runs.
export function scheduleAutomations(app: FastifyInstance): void {
  setTimeout(() => tick(app), 5_000);
  const timer = setInterval(() => tick(app), TICK_MS);
  timer.unref();
}
