import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";

export default async function foldersRoutes(app: FastifyInstance) {
  // ---- List the user's folders, with chat counts ----
  app.get("/folders", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const folders = await app.prisma.folder.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { chats: true } } },
    });
    return { folders };
  });

  // ---- Create a folder ----
  app.post("/folders", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    const folder = await app.prisma.folder.create({ data: { userId, name } });
    return { folder };
  });

  // ---- Rename a folder ----
  app.patch("/folders/:folderId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { folderId } = req.params as { folderId: string };
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);

    const folder = await app.prisma.folder.findFirst({ where: { id: folderId, userId } });
    if (!folder) return reply.code(404).send({ error: "Not found" });

    const updated = await app.prisma.folder.update({ where: { id: folderId }, data: { name } });
    return { folder: updated };
  });

  // ---- Delete a folder. Chats inside it are NOT deleted — they just lose
  // their folder (Chat.folderId is set null via the FK's onDelete: SetNull). ----
  app.delete("/folders/:folderId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { folderId } = req.params as { folderId: string };
    const folder = await app.prisma.folder.findFirst({ where: { id: folderId, userId } });
    if (!folder) return reply.code(404).send({ error: "Not found" });
    await app.prisma.folder.delete({ where: { id: folderId } });
    return { ok: true };
  });
}
