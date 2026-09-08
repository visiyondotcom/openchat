import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { requireAuth } from "../lib/jwt.js";

function generateKey(): string {
  // "vis_" prefix makes keys recognizable in logs/secret scanners, 32 bytes
  // of randomness hex-encoded gives 64 hex chars of entropy.
  return `vis_${crypto.randomBytes(32).toString("hex")}`;
}

function mask(key: string): string {
  return `${key.slice(0, 8)}${"•".repeat(20)}${key.slice(-4)}`;
}

export default async function apiKeysRoutes(app: FastifyInstance) {
  // ---- List the user's keys, masked (the full value is only ever shown
  // once, at creation time) ----
  app.get("/api-keys", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const keys = await app.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return { keys: keys.map((k) => ({ id: k.id, label: k.label, masked: mask(k.key), createdAt: k.createdAt, lastUsed: k.lastUsed })) };
  });

  // ---- Issue a new key. Returns the full value once — the client must
  // copy it now, since only the masked form is retrievable afterward. ----
  app.post("/api-keys", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const { label } = z.object({ label: z.string().max(60).optional() }).parse(req.body);
    const key = generateKey();
    const created = await app.prisma.apiKey.create({ data: { userId, key, label } });
    return { key: created.key, id: created.id, label: created.label, createdAt: created.createdAt };
  });

  // ---- Revoke a key ----
  app.delete("/api-keys/:keyId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { keyId } = req.params as { keyId: string };
    const key = await app.prisma.apiKey.findFirst({ where: { id: keyId, userId } });
    if (!key) return reply.code(404).send({ error: "Not found" });
    await app.prisma.apiKey.delete({ where: { id: keyId } });
    return { ok: true };
  });
}
