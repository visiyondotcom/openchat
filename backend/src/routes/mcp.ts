import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { syncMcpServer } from "../lib/mcp.js";

const serverBody = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  transport: z.enum(["http", "sse"]).optional(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export default async function mcpRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  app.get("/mcp/servers", async () => {
    const servers = await app.prisma.mcpServer.findMany({ orderBy: { name: "asc" } });
    return { servers };
  });

  app.post("/mcp/servers", async (req, reply) => {
    const body = serverBody.parse(req.body);
    const existing = await app.prisma.mcpServer.findUnique({ where: { name: body.name } });
    if (existing) return reply.code(409).send({ error: "A server with this name already exists" });
    const server = await app.prisma.mcpServer.create({ data: body });
    // Discover its tools immediately so the admin sees results without a
    // separate manual sync step.
    const sync = await syncMcpServer(app.prisma, server.id);
    return { server, sync };
  });

  app.patch("/mcp/servers/:serverId", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const body = serverBody.partial().parse(req.body);
    const existing = await app.prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const server = await app.prisma.mcpServer.update({ where: { id: serverId }, data: body });
    return { server };
  });

  app.delete("/mcp/servers/:serverId", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const existing = await app.prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    // Tool rows this server created stay behind (as disabled/orphaned) so
    // any chat that had them attached doesn't break; admin can clean up
    // the mcp:<server>:* tools separately via the normal Tools page.
    await app.prisma.mcpServer.delete({ where: { id: serverId } });
    return { ok: true };
  });

  // Re-discover tools from a connected server — call after the remote
  // server adds/removes tools, or to clear a stale lastSyncError.
  app.post("/mcp/servers/:serverId/sync", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const existing = await app.prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const result = await syncMcpServer(app.prisma, serverId);
    return result;
  });
}
