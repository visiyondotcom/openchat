import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { streamChat, listModels } from "../lib/ollama.js";
import { SUPPORT_SYSTEM_PROMPT } from "../lib/support-knowledge.js";

// Built-in "Platform Support" chat — answers questions about how to use
// Visiyon itself (where a setting lives, what a feature does, why
// something isn't showing up) for anyone who gets lost in the UI.
//
// Deliberately NOT backed by any external AI API: it reuses this
// deployment's own local Ollama instance(s) (see lib/ollama.ts), the same
// way every other chat model on the platform works, so there's no extra
// API key, no extra cost, and no data leaving the server. The only thing
// that makes it "support" rather than a normal chat is the fixed system
// prompt in lib/support-knowledge.ts — nothing here is chat-history-aware
// or persisted server-side (same stateless shape as /playground/stream),
// since a help widget just needs question in, answer out.
const SUPPORT_MODEL = process.env.SUPPORT_MODEL || "";

// Falls back to whatever's actually installed if SUPPORT_MODEL isn't set,
// so this works out of the box on a fresh install with zero extra config —
// it just picks the first chat-capable model Ollama currently has pulled.
async function resolveSupportModel(): Promise<string | null> {
  if (SUPPORT_MODEL) return SUPPORT_MODEL;
  try {
    const models = await listModels();
    const chatCapable = models.find((m) => !/embed|bge-|minilm|e5-|gte-/i.test(m.name));
    return chatCapable?.name ?? models[0]?.name ?? null;
  } catch {
    return null;
  }
}

const chatBodySchema = z.object({
  // Short recent history so a follow-up question ("what about for
  // admins?") still makes sense, without persisting anything
  // server-side. The client keeps and resends this, same pattern
  // as /playground/stream.
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(20),
});

async function handleSupportChat(
  body: z.infer<typeof chatBodySchema>,
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply
) {
  const model = await resolveSupportModel();
  if (!model) {
    return reply.code(503).send({ error: "No local model is available to answer support questions yet." });
  }

  // Using reply.raw directly for SSE bypasses Fastify's normal response
  // pipeline, which means the @fastify/cors plugin (registered with
  // origin: true, i.e. "reflect whatever Origin sent the request") never
  // gets a chance to add its header here. Every other reply.raw route in
  // this codebase (playground.ts, chats.ts, channels.ts) is only ever
  // called same-origin from the app itself, so this never mattered there —
  // but /support/public-chat is called cross-origin from the marketing
  // site (visiyon.com), so it's echoed back explicitly.
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  reply.raw.writeHead(200, headers);

  try {
    for await (const chunk of streamChat({
      model,
      messages: [{ role: "system", content: SUPPORT_SYSTEM_PROMPT }, ...body.messages],
      temperature: 0.3,
      num_ctx: 4096,
    })) {
      const token = chunk.message?.content ?? "";
      reply.raw.write(`data: ${JSON.stringify({ token, done: chunk.done })}\n\n`);
      if (chunk.done) break;
    }
  } catch (err) {
    reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
  }

  reply.raw.end();
}

export default async function supportRoutes(app: FastifyInstance) {
  // Any logged-in user can ask — this is meant to help people who are
  // stuck, not an admin-only tool.
  app.post(
    "/support/chat",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = chatBodySchema.parse(req.body);
      return handleSupportChat(body, req, reply);
    }
  );

  // Public counterpart used by the "Need help?" widget embedded on the
  // marketing site (visiyon.com), which is a separate static site with no
  // login of its own — see index.html there. Deliberately unauthenticated,
  // so kept behind a tighter IP-based rate limit than /support/chat to
  // avoid it becoming an open door to the local model.
  app.post(
    "/support/public-chat",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = chatBodySchema.parse(req.body);
      return handleSupportChat(body, req, reply);
    }
  );
}
