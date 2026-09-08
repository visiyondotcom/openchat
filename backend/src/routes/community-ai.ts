import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { chatOnce, listModels } from "../lib/ollama.js";
import { generateImage } from "../lib/images.js";
import { musicGenEnabled, startMusicGeneration, checkMusicGeneration } from "../lib/music.js";

// Backs two things on community.visiyon.com (a separate Express app/VM —
// see the "community" project — that has no LLM of its own):
//   - POST /community/moderate : classify a question/answer as spam/abuse
//     before it's saved, so the 24/7 "guard" role doesn't depend on a human
//     being online.
//   - POST /community/answer   : draft an automatic first answer to a new
//     question, so nothing sits unanswered while waiting for real users.
//
// This is server-to-server (community's Express backend calling this
// Fastify backend over the network), not a user in a browser, so it's
// authenticated with a shared secret header instead of a user JWT/cookie —
// there's no logged-in Visiyon user on the other end to check.
const COMMUNITY_AI_KEY = process.env.COMMUNITY_AI_KEY || "";
const COMMUNITY_MODEL = process.env.COMMUNITY_MODEL || process.env.SUPPORT_MODEL || "";

async function resolveModel(): Promise<string | null> {
  if (COMMUNITY_MODEL) return COMMUNITY_MODEL;
  try {
    const models = await listModels();
    const chatCapable = models.find((m) => !/embed|bge-|minilm|e5-|gte-/i.test(m.name));
    return chatCapable?.name ?? models[0]?.name ?? null;
  } catch {
    return null;
  }
}

function requireServiceKey(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  if (!COMMUNITY_AI_KEY) {
    reply.code(503).send({ error: "Community AI integration is not configured on this server (set COMMUNITY_AI_KEY)." });
    return;
  }
  const key = req.headers["x-community-ai-key"];
  if (key !== COMMUNITY_AI_KEY) {
    reply.code(401).send({ error: "Invalid or missing service key." });
    return;
  }
  done();
}

// Models sometimes wrap JSON in a markdown fence or add a stray sentence
// before/after it despite instructions — pull out the first {...} block
// rather than trusting content to be pure JSON.
function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model output.");
  return JSON.parse(match[0]);
}

const MODERATE_SYSTEM_PROMPT = `You are an automated moderation filter for Visiyon's public community Q&A forum (community.visiyon.com), a technical support/discussion site about the Visiyon AI platform.

Your only job is to decide whether a submitted post should be allowed. Block content that is:
- Spam: promotional links unrelated to Visiyon, SEO link-dropping, repeated/copy-pasted text, cryptocurrency or gambling promotion, affiliate schemes.
- Abuse: harassment, hate speech, sexual content, threats.
- Scams or phishing attempts (fake support links, credential harvesting, requests to message off-platform for "help").

Do NOT block posts just because they're low-effort, off-topic-but-benign, poorly written, or critical/negative about Visiyon — genuine complaints and questions are welcome even if blunt. When in doubt, allow it; false positives block real users from a real community.

Respond with ONLY a single JSON object, nothing else, no markdown fence:
{"allow": true or false, "reason": "short reason if blocked, empty string if allowed"}`;

const ANSWER_SYSTEM_PROMPT = `You are "Visiyon AI", an automatic first-responder on Visiyon's public community Q&A forum (community.visiyon.com). A new question just got posted with no answers yet.

Write a genuinely helpful, direct answer using what you know about the Visiyon platform (an open-source, self-hostable AI chat platform with enterprise deployment options). If the question is too specific to this person's own setup/logs/config for you to know the answer, say so plainly and suggest what info they should share, rather than guessing or inventing specifics. Keep it focused — a few short paragraphs at most, no filler intro like "Great question!". Plain text only, no markdown headers.

Make clear near the start, briefly and naturally, that this is an automatic AI answer — real community members may follow up.`;

const moderateBodySchema = z.object({
  title: z.string().max(300).optional(),
  body: z.string().min(1).max(8000),
});

const imageBodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  size: z.string().max(20).optional(),
});

const answerBodySchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(8000),
  tags: z.array(z.string()).optional(),
});

export default async function communityAiRoutes(app: FastifyInstance) {
  app.post(
    "/community/moderate",
    { preHandler: requireServiceKey, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = moderateBodySchema.parse(req.body);

      const model = await resolveModel();
      if (!model) {
        // Fail open: no model available shouldn't mean the whole community
        // site can't accept posts. The guard is defense-in-depth, not the
        // only line of defense (rate limiting/captcha still apply upstream).
        return reply.send({ allow: true, reason: "" });
      }

      try {
        const result = await chatOnce({
          model,
          messages: [
            { role: "system", content: MODERATE_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify({ title: body.title || "", body: body.body }) },
          ],
          temperature: 0,
          num_ctx: 2048,
        });
        const parsed = extractJson(result.content) as { allow?: unknown; reason?: unknown };
        return reply.send({
          allow: parsed.allow !== false,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
        });
      } catch (err) {
        req.log.warn({ err }, "community moderation call failed — allowing by default");
        return reply.send({ allow: true, reason: "" });
      }
    }
  );

  app.post(
    "/community/answer",
    { preHandler: requireServiceKey, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = answerBodySchema.parse(req.body);

      const model = await resolveModel();
      if (!model) {
        return reply.code(503).send({ error: "No local model is available to draft an answer yet." });
      }

      try {
        const result = await chatOnce({
          model,
          messages: [
            { role: "system", content: ANSWER_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Title: ${body.title}\nTags: ${(body.tags || []).join(", ") || "(none)"}\n\n${body.body}`,
            },
          ],
          temperature: 0.4,
          num_ctx: 4096,
        });
        return reply.send({ answer: result.content.trim() });
      } catch (err) {
        req.log.error({ err }, "community auto-answer generation failed");
        return reply.code(502).send({ error: "Failed to generate an answer." });
      }
    }
  );
  app.post(
    "/community/image",
    { preHandler: requireServiceKey, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = imageBodySchema.parse(req.body);
      try {
        const url = await generateImage(body.prompt, body.size || "1024x1024", app.prisma);
        return reply.send({ url });
      } catch (err) {
        req.log.error({ err }, "community image generation failed");
        const message = err instanceof Error ? err.message : "Failed to generate an image.";
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Public/community music generation (no user login — same
  // shared-secret pattern as /community/image above). Anonymous
  // generations are attributed to a fixed system account since
  // MusicGeneration.userId is a required foreign key. ----
  const COMMUNITY_MUSIC_USER_ID = process.env.COMMUNITY_MUSIC_USER_ID || "cmryinscg00066qyrmphxd6sq";

  const musicGenerateBody = z
    .object({
      prompt: z.string().max(2000),
      instrumental: z.boolean().optional(),
      style: z.string().max(200).optional(),
      title: z.string().max(80).optional(),
    })
    .refine((v) => v.prompt.trim().length > 0, { message: "Prompt is required.", path: ["prompt"] });

  app.post(
    "/community/music/generate",
    { preHandler: requireServiceKey, config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await musicGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Music generation is not configured on this server." });
      }
      try {
        const body = musicGenerateBody.parse(req.body);
        const { taskId } = await startMusicGeneration(
          body.prompt,
          { instrumental: body.instrumental, customMode: false, title: body.title, style: body.style },
          app.prisma
        );
        await app.prisma.musicGeneration.create({
          data: {
            userId: COMMUNITY_MUSIC_USER_ID,
            taskId,
            prompt: body.prompt,
            instrumental: Boolean(body.instrumental),
            style: body.style || null,
            title: body.title || null,
          },
        });
        return reply.send({ taskId });
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        req.log.error({ err }, "community music generation failed to start");
        const message = err instanceof Error ? err.message : "Failed to start music generation.";
        return reply.code(502).send({ error: message });
      }
    }
  );

  app.get(
    "/community/music/generate/:taskId",
    { preHandler: requireServiceKey, config: { rateLimit: { max: 120, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      try {
        const result = await checkMusicGeneration(taskId, app.prisma);
        if (result.status === "complete" || result.status === "failed") {
          app.prisma.musicGeneration
            .update({
              where: { taskId },
              data:
                result.status === "complete"
                  ? { status: "COMPLETE", tracks: result.tracks as any }
                  : { status: "FAILED", error: result.error },
            })
            .catch((err) => req.log.error({ err }, "failed to persist community music result"));
        }
        return reply.send(result);
      } catch (err) {
        req.log.error({ err }, "checking community music generation failed");
        const message = err instanceof Error ? err.message : "Failed to check music generation.";
        return reply.code(502).send({ error: message });
      }
    }
  );

  app.get(
    "/community/music/library",
    { preHandler: requireServiceKey, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { genre, search } = z
        .object({ genre: z.string().max(100).optional(), search: z.string().max(200).optional() })
        .parse(req.query);
      const rows = await app.prisma.musicGeneration.findMany({
        where: {
          status: "COMPLETE",
          ...(genre ? { style: { contains: genre, mode: "insensitive" } } : {}),
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: "insensitive" } },
                  { prompt: { contains: search, mode: "insensitive" } },
                  { style: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, prompt: true, title: true, style: true, instrumental: true, tracks: true, createdAt: true },
      });
      const entries = rows.flatMap((row) => {
        const tracks = (row.tracks as any[]) || [];
        return tracks.map((t: any) => ({
          id: t.id,
          generationId: row.id,
          title: t.title || row.title || "Untitled",
          style: row.style,
          instrumental: row.instrumental,
          audioUrl: t.audioUrl,
          coverUrl: t.coverUrl,
          durationSeconds: t.durationSeconds,
          createdAt: row.createdAt,
        }));
      });
      return reply.send({ tracks: entries });
    }
  );
}
