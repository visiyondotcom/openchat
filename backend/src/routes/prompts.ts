import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { chatOnceRouted } from "../lib/meta-model.js";
import { listModels } from "../lib/ollama.js";

export default async function promptsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ---- Prompt improver: takes a short idea typed in the composer and
  // expands it into a full, detailed prompt — shown back to the user in
  // the composer so they can review/edit it before actually sending it.
  // Runs a single one-shot completion (no chat history, nothing saved).
  //
  // The composer always asks for a fixed default model (e.g. "glm4:9b").
  // If that specific model isn't currently pulled/available on the Ollama
  // server, the request used to just fail outright with a bare 502 and no
  // way to tell why. Now: on failure, fall back to whatever chat model IS
  // actually available right now and retry once before giving up — and if
  // it still fails, the real underlying reason is included in the error. ----
  app.post("/prompts/improve", async (req, reply) => {
    const body = z
      .object({
        text: z.string().min(1).max(4000),
        model: z.string().min(1),
      })
      .parse(req.body);

    const instruction =
      "You turn a short, rough idea into a single, clear, detailed prompt " +
      "for an AI assistant. Expand it with concrete goals, relevant context " +
      "and constraints, and the desired output format. Reply with ONLY the " +
      "improved prompt itself — no preamble, no quotes, no explanation.";

    const messages = [
      { role: "system" as const, content: instruction },
      { role: "user" as const, content: body.text },
    ];

    try {
      const result = await chatOnceRouted(app.prisma, body.model, messages, { temperature: 0.4 });
      return { improved: result.content.trim() };
    } catch (firstErr) {
      req.log.warn({ err: firstErr, model: body.model }, "prompt improve: requested model failed, trying fallback");

      // Requested model didn't work (most likely: not pulled in Ollama).
      // Find a model that's actually available right now and retry with it,
      // instead of failing the whole request.
      try {
        const available = await listModels();
        const fallbackModel = available.find((m) => m.name !== body.model)?.name;
        if (!fallbackModel) throw firstErr;

        const result = await chatOnceRouted(app.prisma, fallbackModel, messages, { temperature: 0.4 });
        return { improved: result.content.trim() };
      } catch (fallbackErr) {
        const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        req.log.error({ err: fallbackErr, firstErr, model: body.model }, "prompt improve failed");
        return reply.code(502).send({
          error: `Couldn't improve the prompt: ${reason}`,
        });
      }
    }
  });

  // ---- Describe image: given a hosted image URL, asks a vision-capable
  // chat model to write a detailed generation prompt describing it. Used by
  // the Generate page to auto-fill the prompt box when a reference image is
  // dropped in, so the person doesn't have to type a description by hand.
  app.post("/prompts/describe-image", async (req, reply) => {
    const body = z
      .object({
        imageUrl: z.string().url(),
        model: z.string().min(1),
      })
      .parse(req.body);

    let base64: string;
    try {
      const imgRes = await fetch(body.imageUrl);
      if (!imgRes.ok) throw new Error(`fetch failed (${imgRes.status})`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      base64 = buf.toString("base64");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `Couldn't load the image: ${reason}` });
    }

    const instruction =
      "Describe this image as a single, detailed AI image/video generation " +
      "prompt: subject, setting, composition, lighting, mood, and style. " +
      "Reply with ONLY the prompt itself — no preamble, no quotes, no " +
      "explanation.";

    const messages = [{ role: "user" as const, content: instruction, images: [base64] }];

    try {
      const result = await chatOnceRouted(app.prisma, body.model, messages, { temperature: 0.4 });
      return { description: result.content.trim() };
    } catch (firstErr) {
      req.log.warn({ err: firstErr, model: body.model }, "describe-image: requested model failed, trying fallback");
      try {
        const available = await listModels();
        const fallbackModel = available.find((m) => m.name !== body.model)?.name;
        if (!fallbackModel) throw firstErr;
        const result = await chatOnceRouted(app.prisma, fallbackModel, messages, { temperature: 0.4 });
        return { description: result.content.trim() };
      } catch (fallbackErr) {
        const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        req.log.error({ err: fallbackErr, firstErr, model: body.model }, "describe-image failed");
        return reply.code(502).send({ error: `Couldn't describe the image: ${reason}` });
      }
    }
  });

  // ---- List: own prompts + everything shared with all ----
  app.get("/prompts", async (req) => {
    const { id: userId } = req.user as { id: string };
    const prompts = await app.prisma.prompt.findMany({
      where: { OR: [{ userId }, { sharedWithAll: true }] },
      orderBy: [{ sharedWithAll: "desc" }, { updatedAt: "desc" }],
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return { prompts };
  });

  // ---- Create ----
  app.post("/prompts", async (req, reply) => {
    const { id: userId, role } = req.user as { id: string; role: string };
    const body = z
      .object({
        title: z.string().min(1),
        content: z.string().min(1),
        description: z.string().optional(),
        sharedWithAll: z.boolean().optional(),
      })
      .parse(req.body);

    if (body.sharedWithAll && role !== "ADMIN") {
      return reply.code(403).send({ error: "Only admins can share a prompt with everyone" });
    }

    const prompt = await app.prisma.prompt.create({
      data: { ...body, userId },
    });
    return { prompt };
  });

  // ---- Update ----
  app.patch("/prompts/:promptId", async (req, reply) => {
    const { id: userId, role } = req.user as { id: string; role: string };
    const { promptId } = req.params as { promptId: string };
    const body = z
      .object({
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        description: z.string().optional(),
        sharedWithAll: z.boolean().optional(),
      })
      .parse(req.body);

    const existing = await app.prisma.prompt.findUnique({ where: { id: promptId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    if (existing.userId !== userId && role !== "ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (body.sharedWithAll && role !== "ADMIN") {
      return reply.code(403).send({ error: "Only admins can share a prompt with everyone" });
    }

    const prompt = await app.prisma.prompt.update({ where: { id: promptId }, data: body });
    return { prompt };
  });

  // ---- Delete ----
  app.delete("/prompts/:promptId", async (req, reply) => {
    const { id: userId, role } = req.user as { id: string; role: string };
    const { promptId } = req.params as { promptId: string };
    const existing = await app.prisma.prompt.findUnique({ where: { id: promptId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    if (existing.userId !== userId && role !== "ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    await app.prisma.prompt.delete({ where: { id: promptId } });
    return { ok: true };
  });
}
