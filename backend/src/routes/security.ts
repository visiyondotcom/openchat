import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";

export default async function securityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  // Newest first; OPEN alerts surface above resolved ones so the review
  // queue reads like an inbox rather than a flat log.
  app.get("/admin/security/alerts", async (req) => {
    const { status } = req.query as { status?: string };
    const alerts = await app.prisma.securityAlert.findMany({
      where: status ? { status: status as "OPEN" | "DISMISSED" | "ACTIONED" } : undefined,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return { alerts };
  });

  app.patch("/admin/security/alerts/:alertId", async (req, reply) => {
    const { alertId } = req.params as { alertId: string };
    const body = z.object({ status: z.enum(["OPEN", "DISMISSED", "ACTIONED"]) }).parse(req.body);
    const existing = await app.prisma.securityAlert.findUnique({ where: { id: alertId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const alert = await app.prisma.securityAlert.update({
      where: { id: alertId },
      data: { status: body.status, resolvedAt: body.status === "OPEN" ? null : new Date() },
    });
    return { alert };
  });
}
