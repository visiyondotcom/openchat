import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";

const MIN_INTERVAL_MINUTES = 5;

export default async function automationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/automations", async (req) => {
    const { id: userId } = req.user as { id: string };
    const automations = await app.prisma.automation.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return { automations };
  });

  app.post("/automations", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const body = z
      .object({
        name: z.string().min(1),
        prompt: z.string().min(1),
        model: z.string().min(1),
        intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    const automation = await app.prisma.automation.create({
      data: {
        userId,
        name: body.name,
        prompt: body.prompt,
        model: body.model,
        intervalMinutes: body.intervalMinutes,
        enabled: body.enabled ?? true,
        nextRunAt: new Date(),
      },
    });
    return reply.code(201).send({ automation });
  });

  app.patch("/automations/:automationId", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { automationId } = req.params as { automationId: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    const existing = await app.prisma.automation.findFirst({ where: { id: automationId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    // Re-enabling (or shrinking the interval) should make it eligible to
    // run right away rather than waiting out whatever the old nextRunAt
    // was — otherwise flipping a paused automation back on could silently
    // do nothing for up to a full interval.
    const nextRunAt =
      (body.enabled === true && !existing.enabled) || body.intervalMinutes !== undefined
        ? new Date()
        : undefined;

    const automation = await app.prisma.automation.update({
      where: { id: automationId },
      data: { ...body, ...(nextRunAt ? { nextRunAt } : {}) },
    });
    return { automation };
  });

  app.delete("/automations/:automationId", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { automationId } = req.params as { automationId: string };
    const existing = await app.prisma.automation.findFirst({ where: { id: automationId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.automation.delete({ where: { id: automationId } });
    return { ok: true };
  });

  // Manual "run now" — reuses the same scheduler entry point so a manual
  // trigger and the 24/7 loop behave identically (same quota check, same
  // message/run bookkeeping).
  app.post("/automations/:automationId/run", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { automationId } = req.params as { automationId: string };
    const existing = await app.prisma.automation.findFirst({ where: { id: automationId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.automation.update({ where: { id: automationId }, data: { nextRunAt: new Date() } });
    return { ok: true };
  });

  app.get("/automations/:automationId/runs", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { automationId } = req.params as { automationId: string };
    const existing = await app.prisma.automation.findFirst({ where: { id: automationId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const runs = await app.prisma.automationRun.findMany({
      where: { automationId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return { runs };
  });
}
