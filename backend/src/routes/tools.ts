import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { runPythonCode } from "../lib/functions-sandbox.js";

const httpToolParameterSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

const httpToolConfigSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  bodyTemplate: z.string().optional(),
  parameters: z.array(httpToolParameterSchema).default([]),
});

export default async function toolsRoutes(app: FastifyInstance) {
  // ---- Catalog: every enabled tool any user can attach to a chat ----
  app.get("/tools", { preHandler: requireAuth }, async () => {
    const tools = await app.prisma.tool.findMany({
      where: { enabled: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });
    return { tools };
  });

  // ---- Admin: full catalog including disabled tools ----
  app.get("/tools/all", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const tools = await app.prisma.tool.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });
    return { tools };
  });

  // ---- Admin: create an HTTP tool. Built-in tools are seeded at startup
  // and can't be created through the API, only toggled/deleted. ----
  app.post("/tools", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        config: httpToolConfigSchema,
      })
      .parse(req.body);

    const existing = await app.prisma.tool.findUnique({ where: { name: body.name } });
    if (existing) return reply.code(409).send({ error: "A tool with that name already exists" });

    const tool = await app.prisma.tool.create({
      data: {
        name: body.name,
        description: body.description,
        type: "HTTP",
        config: body.config,
      },
    });
    return { tool };
  });

  // ---- Admin: enable/disable any tool, or edit an HTTP tool's config ----
  app.patch("/tools/:toolId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { toolId } = req.params as { toolId: string };
    const body = z
      .object({
        enabled: z.boolean().optional(),
        description: z.string().min(1).optional(),
        config: httpToolConfigSchema.optional(),
      })
      .parse(req.body);

    const tool = await app.prisma.tool.findUnique({ where: { id: toolId } });
    if (!tool) return reply.code(404).send({ error: "Not found" });
    if (tool.type === "BUILTIN" && body.config) {
      return reply.code(400).send({ error: "Built-in tool configs can't be edited" });
    }

    const updated = await app.prisma.tool.update({ where: { id: toolId }, data: body });
    return { tool: updated };
  });

  // ---- Admin: delete an HTTP tool ----
  app.delete("/tools/:toolId", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { toolId } = req.params as { toolId: string };
    const tool = await app.prisma.tool.findUnique({ where: { id: toolId } });
    if (!tool) return reply.code(404).send({ error: "Not found" });
    if (tool.type === "BUILTIN") return reply.code(400).send({ error: "Built-in tools can't be deleted, only disabled" });
    await app.prisma.tool.delete({ where: { id: toolId } });
    return { ok: true };
  });

  // ---- List tools attached to a chat ----
  app.get("/chats/:chatId/tools", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    const links = await app.prisma.chatTool.findMany({
      where: { chatId },
      include: { tool: true },
    });
    return { tools: links.map((l) => l.tool) };
  });

  // ---- Attach a tool to a chat ----
  app.post("/chats/:chatId/tools", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const { toolId } = z.object({ toolId: z.string() }).parse(req.body);

    const [chat, tool] = await Promise.all([
      app.prisma.chat.findFirst({ where: { id: chatId, userId } }),
      app.prisma.tool.findFirst({ where: { id: toolId, enabled: true } }),
    ]);
    if (!chat || !tool) return reply.code(404).send({ error: "Not found" });

    const link = await app.prisma.chatTool.upsert({
      where: { chatId_toolId: { chatId, toolId } },
      create: { chatId, toolId },
      update: {},
    });
    return { link };
  });

  // ---- Detach a tool from a chat ----
  app.delete("/chats/:chatId/tools/:toolId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId, toolId } = req.params as { chatId: string; toolId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    await app.prisma.chatTool.delete({ where: { chatId_toolId: { chatId, toolId } } }).catch(() => null);
    return { ok: true };
  });

  // ---- Run a Python snippet directly from a chat message's code block
  // ("Run" button — see frontend/components/MarkdownMessage.tsx). Same
  // isolated, network-less sandbox as the run_python tool the model itself
  // can call (see backend/src/lib/tools.ts) — this route just lets the
  // human trigger the identical execution manually, on demand, for any
  // Python code block regardless of whether run_python is attached to the
  // chat. Any authenticated user can use this; there's nothing
  // admin-specific about running your own pasted/generated code. ----
  app.post("/tools/run-python", { preHandler: requireAuth }, async (req, reply) => {
    const { code, stdin } = z
      .object({ code: z.string().min(1).max(50_000), stdin: z.string().max(50_000).optional() })
      .parse(req.body);

    const result = await runPythonCode(code, stdin ?? "");
    if (!result.ok && !result.stdout && !result.stderr) {
      return reply.code(502).send({ error: result.error || "Python execution failed" });
    }
    return {
      ok: result.ok,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ?? null,
    };
  });
}
