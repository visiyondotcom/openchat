import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";

export default async function notesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/notes", async (req) => {
    const { id: userId } = req.user as { id: string };
    const notes = await app.prisma.note.findMany({
      where: { userId },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });
    return { notes };
  });

  app.post("/notes", async (req) => {
    const { id: userId } = req.user as { id: string };
    const body = z.object({ title: z.string().optional(), content: z.string().optional() }).parse(req.body);
    const note = await app.prisma.note.create({ data: { userId, ...body } });
    return { note };
  });

  app.patch("/notes/:noteId", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { noteId } = req.params as { noteId: string };
    const body = z.object({ title: z.string().optional(), content: z.string().optional(), pinned: z.boolean().optional() }).parse(req.body);
    const existing = await app.prisma.note.findFirst({ where: { id: noteId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const note = await app.prisma.note.update({ where: { id: noteId }, data: body });
    return { note };
  });

  app.delete("/notes/:noteId", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { noteId } = req.params as { noteId: string };
    const existing = await app.prisma.note.findFirst({ where: { id: noteId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.note.delete({ where: { id: noteId } });
    return { ok: true };
  });
}
