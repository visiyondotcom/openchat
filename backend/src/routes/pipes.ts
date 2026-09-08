import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { runPipe, runFilterOnce } from "../lib/functions-sandbox.js";

const pipeBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens only"),
  enabled: z.boolean().optional(),
  code: z.string().min(1),
  description: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

export default async function pipesRoutes(app: FastifyInstance) {
  app.get("/pipes", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const pipes = await app.prisma.pipe.findMany({ orderBy: { name: "asc" } });
    return { pipes };
  });

  // Non-admin, read-only: the chat model picker needs to list enabled
  // pipes as selectable "models" (prefixed `pipe:<slug>`), but must never
  // see the code itself.
  app.get("/pipes/available", { preHandler: requireAuth }, async () => {
    const pipes = await app.prisma.pipe.findMany({
      where: { enabled: true },
      select: { slug: true, name: true, description: true },
    });
    return { pipes };
  });

  app.post("/pipes", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const body = pipeBody.parse(req.body);
    const existing = await app.prisma.pipe.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: "A pipe with this slug already exists" });
    const pipe = await app.prisma.pipe.create({ data: body });
    return { pipe };
  });

  app.patch("/pipes/:pipeId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { pipeId } = req.params as { pipeId: string };
    const body = pipeBody.partial().parse(req.body);
    const existing = await app.prisma.pipe.findUnique({ where: { id: pipeId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const pipe = await app.prisma.pipe.update({ where: { id: pipeId }, data: body });
    return { pipe };
  });

  app.delete("/pipes/:pipeId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { pipeId } = req.params as { pipeId: string };
    const existing = await app.prisma.pipe.findUnique({ where: { id: pipeId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.pipe.delete({ where: { id: pipeId } });
    return { ok: true };
  });

  app.post("/pipes/:pipeId/test", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { pipeId } = req.params as { pipeId: string };
    const { content } = z.object({ content: z.string() }).parse(req.body);
    const pipe = await app.prisma.pipe.findUnique({ where: { id: pipeId } });
    if (!pipe) return reply.code(404).send({ error: "Not found" });
    const admin = req.user as { id: string; email: string; role: string };
    const result = await runFilterOnce({
      hook: "pipe",
      code: pipe.code,
      body: { content },
      user: { id: admin.id, email: admin.email, role: admin.role },
      timeoutMs: pipe.timeoutMs,
    });
    return result;
  });
}

// Called from routes/chats.ts when the client selects a "pipe:<slug>"
// model instead of a real Ollama model. Exported separately so chats.ts
// doesn't need to duplicate the slug->pipe lookup.
export async function invokePipeBySlug(
  app: FastifyInstance,
  slug: string,
  content: string,
  user: { id: string; email: string; role: string }
) {
  const pipe = await app.prisma.pipe.findUnique({ where: { slug } });
  if (!pipe || !pipe.enabled) return { ok: false as const, error: "Pipe not found or disabled" };
  return runPipe(app.prisma, pipe.id, { content }, user);
}
