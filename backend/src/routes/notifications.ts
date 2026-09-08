import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";

// In-app notification bell — synced with the account (server-side rows),
// not the browser-permission desktop popup in lib/notificationPref.ts.
// Every route here is scoped to req.user.id; there's no way to read or
// mark another user's notifications.
export default async function notificationsRoutes(app: FastifyInstance) {
  app.get("/notifications/unread-count", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const count = await app.prisma.notification.count({ where: { userId, readAt: null } });
    return { count };
  });

  // Newest first, capped — this backs the dropdown list, not a full
  // history page, so there's no pagination yet.
  app.get("/notifications", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const notifications = await app.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { notifications };
  });

  app.post("/notifications/:id/read", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const updated = await app.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) {
      // Either it doesn't exist, isn't this user's, or was already read —
      // any of those is fine to no-op on rather than error, since the
      // frontend calls this optimistically on click.
      const exists = await app.prisma.notification.findFirst({ where: { id, userId } });
      if (!exists) return reply.code(404).send({ error: "Not found" });
    }
    return { ok: true };
  });

  app.post("/notifications/read-all", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    await app.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });
}
