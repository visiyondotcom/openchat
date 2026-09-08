import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";

const pipelineBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  stage: z.enum(["PRE", "POST"]),
  matchType: z.enum(["KEYWORD", "REGEX", "AI"]),
  pattern: z.string().min(1),
  action: z.enum(["BLOCK", "FLAG"]),
  message: z.string().optional(),
  order: z.number().int().optional(),
  aiModel: z.string().nullable().optional(),
});

export default async function pipelinesRoutes(app: FastifyInstance) {
  // Admin-only: rules can inspect every message in the system, so nobody
  // else gets to read or write them.
  app.get("/pipelines", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const pipelines = await app.prisma.pipeline.findMany({ orderBy: [{ stage: "asc" }, { order: "asc" }] });
    return { pipelines };
  });

  app.post("/pipelines", { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const body = pipelineBody.parse(req.body);
    const pipeline = await app.prisma.pipeline.create({ data: body });
    return { pipeline };
  });

  app.patch("/pipelines/:pipelineId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { pipelineId } = req.params as { pipelineId: string };
    const body = pipelineBody.partial().parse(req.body);
    const existing = await app.prisma.pipeline.findUnique({ where: { id: pipelineId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const pipeline = await app.prisma.pipeline.update({ where: { id: pipelineId }, data: body });
    return { pipeline };
  });

  app.delete("/pipelines/:pipelineId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { pipelineId } = req.params as { pipelineId: string };
    const existing = await app.prisma.pipeline.findUnique({ where: { id: pipelineId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.pipeline.delete({ where: { id: pipelineId } });
    return { ok: true };
  });

  // Flagged messages across every chat, newest first — the admin review queue.
  app.get("/pipelines/flagged", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const messages = await app.prisma.message.findMany({
      where: { flagged: true },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { chat: { select: { id: true, title: true, userId: true } } },
    });
    return { messages };
  });
}
