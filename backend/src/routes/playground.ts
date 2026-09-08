import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { streamChat } from "../lib/ollama.js";
import { canUseModel } from "../lib/permissions.js";

// Playground is deliberately stateless server-side: nothing is written to
// the database. The client keeps the message list in memory and resends
// the full array on every request, same shape as the chat endpoint's
// modelMessages so both code paths hit Ollama identically.
export default async function playgroundRoutes(app: FastifyInstance) {
  app.post(
    "/playground/stream",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const body = z
      .object({
        model: z.string(),
        systemPrompt: z.string().optional(),
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string(),
          })
        ),
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        num_ctx: z.number().min(512).max(131072).optional(),
      })
      .parse(req.body);

    const allowed = await canUseModel(app.prisma, userId, body.model);
    if (!allowed) return reply.code(403).send({ error: "No access to this model" });

    const modelMessages = [
      ...(body.systemPrompt ? [{ role: "system" as const, content: body.systemPrompt }] : []),
      ...body.messages,
    ];

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      for await (const chunk of streamChat({
        model: body.model,
        messages: modelMessages,
        temperature: body.temperature,
        top_p: body.top_p,
        num_ctx: body.num_ctx,
      })) {
        const token = chunk.message?.content ?? "";
        reply.raw.write(`data: ${JSON.stringify({ token, done: chunk.done })}\n\n`);
        if (chunk.done) break;
      }
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    }

    reply.raw.end();
  });
}
