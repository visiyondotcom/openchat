import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { chatOnce, listModels } from "../lib/ollama.js";

// Backs cvmaker.visiyon.com's "Genereer sollicitatiebrief" feature (a
// separate Express app/VM — see the "cvmaker" project — that has no LLM of
// its own). cvmaker's backend/server/index.js POSTs directly to whatever
// AI_API_URL is configured, using an OpenAI-style payload
// ({ model, messages, temperature }) and an `Authorization: Bearer <key>`
// header, and reads the reply back out of `choices[0].message.content` —
// see cvmaker/backend/server/index.js's /api/generate-letter handler. So
// this route speaks that exact shape rather than Visiyon's native
// /api/chat shape, and authenticates with Bearer instead of the
// x-community-ai-key header community-ai.ts uses, to match cvmaker's
// client as-is with no changes needed on that side beyond its .env.
//
// No /api prefix here, same as /community/... below — nginx's /api/
// location strips that prefix (rewrite ^/api/(.*)$ /$1 break;) before
// proxying to this backend, so the externally-visible URL is
// https://ai.visiyon.com/api/cvmaker/chat/completions but the route
// registered here must be just /cvmaker/chat/completions.
//
// This is server-to-server (cvmaker's Express backend calling this Fastify
// backend over the network), not a user in a browser, so it's
// authenticated with a shared secret instead of a user JWT/cookie —
// there's no logged-in Visiyon user on the other end to check.
const CVMAKER_AI_KEY = process.env.CVMAKER_AI_KEY || "";
const CVMAKER_MODEL = process.env.CVMAKER_MODEL || process.env.SUPPORT_MODEL || "";

async function resolveModel(requested?: string): Promise<string | null> {
  if (requested) return requested;
  if (CVMAKER_MODEL) return CVMAKER_MODEL;
  try {
    const models = await listModels();
    const chatCapable = models.find((m) => !/embed|bge-|minilm|e5-|gte-/i.test(m.name));
    return chatCapable?.name ?? models[0]?.name ?? null;
  } catch {
    return null;
  }
}

function requireBearerKey(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  if (!CVMAKER_AI_KEY) {
    reply.code(503).send({ error: "cvmaker AI integration is not configured on this server (set CVMAKER_AI_KEY)." });
    return;
  }
  const auth = req.headers["authorization"];
  const key = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!key || key !== CVMAKER_AI_KEY) {
    reply.code(401).send({ error: "Invalid or missing API key." });
    return;
  }
  done();
}

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

// Mirrors the subset of the OpenAI chat-completions request body that
// cvmaker's index.js actually sends — no need to model the rest of the
// spec since this endpoint only ever has one caller.
const completionsBodySchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
});

export default async function cvmakerAiRoutes(app: FastifyInstance) {
  app.post(
    "/cvmaker/chat/completions",
    { preHandler: requireBearerKey, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = completionsBodySchema.parse(req.body);

      const model = await resolveModel(body.model);
      if (!model) {
        return reply.code(503).send({ error: "No local model is available to generate a letter yet." });
      }

      try {
        const result = await chatOnce({
          model,
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          num_ctx: 4096,
        });

        // Shaped like an OpenAI chat-completions response since that's
        // what cvmaker's index.js parses (data.choices[0].message.content).
        return reply.send({
          id: `cvmaker-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.content },
              finish_reason: "stop",
            },
          ],
        });
      } catch (err) {
        req.log.error({ err }, "cvmaker letter generation failed");
        return reply.code(502).send({ error: "Failed to generate a letter." });
      }
    }
  );
}
