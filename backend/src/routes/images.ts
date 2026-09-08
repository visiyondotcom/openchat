import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { imageGenEnabled, generateImage } from "../lib/images.js";
import { chatOnce } from "../lib/ollama.js";
import { logEvent } from "../lib/logger.js";
import { assertTokenQuota, recordTokenUsage, recordImageGenerated, IMAGE_TOKEN_COST, QuotaExceededError } from "../lib/quota.js";
import { dispatchWebhook } from "../lib/webhooks.js";

// Image models have zero memory of the conversation — they only ever see
// the literal string we hand them. Left as-is, "generate an image of him"
// or "now make it nighttime" (referring to something described a few
// messages earlier) produces nonsense, because the SD model has no idea
// what "him" or "it" refers to. This asks the chat's own LLM to first
// rewrite the user's raw request into a self-contained, detailed image
// prompt using the recent conversation as context — same model the chat
// is already using, so no extra config needed. Falls back to the raw
// prompt on any failure (missing model, Ollama down, etc.) so a broken
// enrichment step never blocks image generation entirely.
async function buildContextualImagePrompt(
  model: string,
  rawPrompt: string,
  recentMessages: { role: string; content: string }[]
): Promise<string> {
  try {
    const history = recentMessages
      .slice(-8)
      .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
      .map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${m.content}`.slice(0, 500))
      .join("\n");

    const result = await chatOnce({
      model,
      think: false,
      temperature: 0.4,
      num_predict: 200,
      messages: [
        {
          role: "system",
          content:
            "You turn a user's image request into a single, self-contained, detailed " +
            "image-generation prompt in English, using the conversation so far for context " +
            "(e.g. resolve \"him\"/\"her\"/\"it\"/\"that\" to whatever was actually being " +
            "discussed, and carry over relevant details already mentioned like appearance, " +
            "setting, or style). Reply with ONLY the finished prompt — no preamble, no " +
            "quotes, no explanation, one line.",
        },
        ...(history ? [{ role: "user" as const, content: `Conversation so far:\n${history}` }] : []),
        { role: "user", content: `Image request: ${rawPrompt}` },
      ],
    });

    const enriched = result.content.trim().replace(/^["']|["']$/g, "");
    return enriched || rawPrompt;
  } catch {
    // Ollama down, model not pulled, etc. — generate from the raw prompt
    // rather than failing the whole request over an optional enhancement.
    return rawPrompt;
  }
}

export default async function imagesRoutes(app: FastifyInstance) {
  // ---- Whether image generation is configured at all — the frontend uses
  // this to decide whether to show the "Generate image" affordance. ----
  app.get("/images/config", async () => {
    return { enabled: await imageGenEnabled(app.prisma) };
  });

  // ---- Standalone generation (e.g. from the playground) — returns the
  // image directly without touching any chat. ----
  app.post(
    "/images/generate",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    if (!(await imageGenEnabled(app.prisma))) {
      return reply.code(503).send({ error: "Image generation is not configured on this server." });
    }
    const { id: userId } = req.user as { id: string };
    const { prompt, size } = z
      .object({
        prompt: z.string().min(1),
        size: z.enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"]).optional(),
      })
      .parse(req.body);
    try {
      await assertTokenQuota(app.prisma, userId);
    } catch (err) {
      if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
      throw err;
    }
    try {
      const url = await generateImage(prompt, size, app.prisma);
      await recordTokenUsage(app.prisma, userId, IMAGE_TOKEN_COST);
      await recordImageGenerated(app.prisma, userId);
      dispatchWebhook(app.prisma, "IMAGE_GENERATED", { userId, prompt });
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent(app.prisma, "ERROR", "image", `Image generation failed: ${message}`);
      return reply.code(502).send({ error: message });
    }
  });

  // ---- Generate an image and drop it straight into a chat as an assistant
  // message, so it shows up in history like any other reply. ----
  app.post(
    "/chats/:chatId/image",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    if (!(await imageGenEnabled(app.prisma))) {
      return reply.code(503).send({ error: "Image generation is not configured on this server." });
    }
    const { prompt, size } = z
      .object({
        prompt: z.string().min(1),
        size: z.enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"]).optional(),
      })
      .parse(req.body);

    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    try {
      await assertTokenQuota(app.prisma, userId);
    } catch (err) {
      if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
      throw err;
    }

    // Grab recent history *before* inserting this turn's own USER message,
    // so the enrichment step sees "what came before", not the prompt
    // talking to itself.
    const recentMessages = await app.prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { role: true, content: true },
    });
    recentMessages.reverse();

    await app.prisma.message.create({ data: { chatId, role: "USER", content: prompt } });

    const effectivePrompt = await buildContextualImagePrompt(chat.model, prompt, recentMessages);

    // Auto-title new chats from the first exchange — mirrors the same
    // logic in the text-completion route (chats.ts). Image-only chats
    // never went through that route, so a chat opened with a generation
    // request (image mode, or "draw me a...") stayed stuck on "New chat"
    // forever, both in the sidebar and in the browser tab title.
    // (isNewChat is captured here, not read from `chat` inside the closure
    // below, because TS can't carry the earlier `if (!chat) return` null
    // check across into a nested function.)
    const isNewChat = chat.title === "New chat";
    async function titleFromPromptIfNew() {
      if (isNewChat) {
        const title = prompt.slice(0, 60);
        await app.prisma.chat.update({ where: { id: chatId }, data: { title } });
      } else {
        await app.prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
      }
    }

    try {
      const url = await generateImage(effectivePrompt, size, app.prisma);
      const message = await app.prisma.message.create({
        data: { chatId, role: "ASSISTANT", content: `![Generated image](${url})` },
      });
      await recordTokenUsage(app.prisma, userId, IMAGE_TOKEN_COST);
      await recordImageGenerated(app.prisma, userId);
      await titleFromPromptIfNew();
      dispatchWebhook(app.prisma, "IMAGE_GENERATED", { userId, chatId, prompt });
      return { message };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logEvent(app.prisma, "ERROR", "image", `Image generation failed: ${errMessage}`, { chatId });
      const message = await app.prisma.message.create({
        data: { chatId, role: "ASSISTANT", content: `Sorry, image generation failed: ${errMessage}` },
      });
      await titleFromPromptIfNew();
      return reply.code(502).send({ error: errMessage, message });
    }
  });
}
