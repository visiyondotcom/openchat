import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { runFilterOnce } from "../lib/functions-sandbox.js";

const filterBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  code: z.string().min(1),
  modelNames: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  timeoutMs: z.number().int().min(500).max(15000).optional(),
});

const testBody = z.object({
  hook: z.enum(["inlet", "outlet"]),
  content: z.string(),
});

export default async function filtersRoutes(app: FastifyInstance) {
  // Admin-only: filter code runs against every message in the system and
  // executes in the sandbox — same trust level as Pipeline rules, plus
  // the code-execution risk, so nobody but admins gets near this.
  app.get("/filters", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const filters = await app.prisma.filter.findMany({ orderBy: { priority: "asc" } });
    return { filters };
  });

  app.post("/filters", { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const body = filterBody.parse(req.body);
    const filter = await app.prisma.filter.create({ data: body });
    return { filter };
  });

  app.patch("/filters/:filterId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { filterId } = req.params as { filterId: string };
    const body = filterBody.partial().parse(req.body);
    const existing = await app.prisma.filter.findUnique({ where: { id: filterId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const filter = await app.prisma.filter.update({ where: { id: filterId }, data: body });
    return { filter };
  });

  app.delete("/filters/:filterId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { filterId } = req.params as { filterId: string };
    const existing = await app.prisma.filter.findUnique({ where: { id: filterId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.filter.delete({ where: { id: filterId } });
    return { ok: true };
  });

  // Dry-run a filter against sample input before enabling it for real
  // traffic. Runs in the exact same sandbox/isolation as a live call —
  // just not chained with other filters and doesn't persist
  // lastError/lastRunAt, so a test doesn't pollute the admin dashboard.
  app.post("/filters/:filterId/test", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { filterId } = req.params as { filterId: string };
    const { hook, content } = testBody.parse(req.body);
    const filter = await app.prisma.filter.findUnique({ where: { id: filterId } });
    if (!filter) return reply.code(404).send({ error: "Not found" });

    const admin = req.user as { id: string; email: string; role: string };
    const result = await runFilterOnce({
      hook,
      code: filter.code,
      body: { content },
      user: { id: admin.id, email: admin.email, role: admin.role },
      timeoutMs: filter.timeoutMs,
    });
    return result;
  });
}
