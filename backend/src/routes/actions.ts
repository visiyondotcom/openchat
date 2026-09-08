import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { runAction, runFilterOnce } from "../lib/functions-sandbox.js";

const actionBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens only"),
  enabled: z.boolean().optional(),
  code: z.string().min(1),
  icon: z.string().optional(),
  timeoutMs: z.number().int().min(500).max(30000).optional(),
});

export default async function actionsRoutes(app: FastifyInstance) {
  app.get("/actions", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const actions = await app.prisma.action.findMany({ orderBy: { name: "asc" } });
    return { actions };
  });

  // Non-admin: the chat toolbar needs to know which action buttons to
  // render, but never sees the code.
  app.get("/actions/available", { preHandler: requireAuth }, async () => {
    const actions = await app.prisma.action.findMany({
      where: { enabled: true },
      select: { id: true, slug: true, name: true, icon: true },
    });
    return { actions };
  });

  app.post("/actions", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const body = actionBody.parse(req.body);
    const existing = await app.prisma.action.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: "An action with this slug already exists" });
    const action = await app.prisma.action.create({ data: body });
    return { action };
  });

  app.patch("/actions/:actionId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { actionId } = req.params as { actionId: string };
    const body = actionBody.partial().parse(req.body);
    const existing = await app.prisma.action.findUnique({ where: { id: actionId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const action = await app.prisma.action.update({ where: { id: actionId }, data: body });
    return { action };
  });

  app.delete("/actions/:actionId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { actionId } = req.params as { actionId: string };
    const existing = await app.prisma.action.findUnique({ where: { id: actionId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.action.delete({ where: { id: actionId } });
    return { ok: true };
  });

  app.post("/actions/:actionId/test", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { actionId } = req.params as { actionId: string };
    const { content } = z.object({ content: z.string() }).parse(req.body);
    const action = await app.prisma.action.findUnique({ where: { id: actionId } });
    if (!action) return reply.code(404).send({ error: "Not found" });
    const admin = req.user as { id: string; email: string; role: string };
    const result = await runFilterOnce({
      hook: "action",
      code: action.code,
      body: { content },
      user: { id: admin.id, email: admin.email, role: admin.role },
      timeoutMs: action.timeoutMs,
    });
    return result;
  });

  // Fired by a user clicking an action button on a specific message —
  // any authenticated user can invoke an enabled action (that's the
  // point of exposing it in the toolbar); only the admin CRUD above is
  // gated.
  app.post("/actions/:actionId/run", { preHandler: requireAuth }, async (req, reply) => {
    const { actionId } = req.params as { actionId: string };
    const { content } = z.object({ content: z.string() }).parse(req.body);
    const user = req.user as { id: string; email: string; role: string };
    const result = await runAction(app.prisma, actionId, { content }, user);
    if (!result.ok) return reply.code(422).send({ error: result.error });
    return { body: result.body };
  });
}
