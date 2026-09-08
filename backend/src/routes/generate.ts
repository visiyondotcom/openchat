import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { requireAuth, optionalAuth } from "../lib/jwt.js";
import { logEvent } from "../lib/logger.js";
import { assertTokenQuota, recordTokenUsage, QuotaExceededError } from "../lib/quota.js";
import {
  MEDIA_MODELS,
  getMediaModel,
  kieGenEnabled,
  startMediaGeneration,
  checkMediaGeneration,
  supportsElements,
  buildKlingElements,
  isMotionControlModel,
  isAvatarModel,
  isKling3VideoModel,
  isKling3TurboVideoModel,
  isKling26VideoModel,
  kling26Duration,
  kling26KieModelId,
  klingResolutionToMode,
} from "../lib/kieGen.js";
import { GENERATED_FILES_DIR, ensureGeneratedFilesDir } from "../lib/generated-files.js";
import { persistResultUrls } from "../lib/persist-results.js";
import { creditsForImage, creditsForVideo } from "../lib/mediaCost.js";
import { chargeCredits, refundCredits, InsufficientCreditsError } from "../lib/credits.js";
import { createNotification } from "../lib/notify.js";

// Same rolling token-quota bucket as chat/image/music generation. Video is
// weighed heavier than image since it's a materially more expensive call
// upstream — override per-deployment with the env vars below if needed.
const IMAGE_GEN_TOKEN_COST = Number(process.env.GENERATE_IMAGE_TOKEN_COST) || 1200;
const VIDEO_GEN_TOKEN_COST_PER_SECOND = Number(process.env.GENERATE_VIDEO_TOKEN_COST_PER_SECOND) || 900;

export default async function generateRoutes(app: FastifyInstance) {
  // ---- Whether generation is configured at all, + the model catalog for
  // the sidebar's model picker on /generate. Public (no auth) so the page
  // can render its model list before the user is necessarily logged in. ----
  app.get("/generate/config", async () => {
    // creditsPerUse lets the frontend show "~N credits" on the Generate
    // button before the user submits — image models: flat cost; video
    // models: cost for a 5s clip (the actual per-call charge scales with
    // the chosen duration, see creditsForVideo).
    const models = MEDIA_MODELS.map((m) => ({
      ...m,
      creditsPerUse: m.modality === "image" ? creditsForImage(m.key, 1) : creditsForVideo(m.key, 5),
    }));
    return { enabled: await kieGenEnabled(app.prisma), models };
  });

  app.post(
    "/generate/image",
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await kieGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Image generation is not configured on this server." });
      }
      const { id: userId, role } = req.user as { id: string; role?: string };
      try {
        const { prompt, modelKey, aspectRatio, imageUrl, count } = z
          .object({
            prompt: z.string().min(1).max(4000),
            modelKey: z.string(),
            aspectRatio: z.string().max(16).optional(),
            imageUrl: z.string().url().optional(),
            count: z.number().min(1).max(2).optional(),
          })
          .parse(req.body);

        const model = getMediaModel(modelKey);
        if (!model || model.modality !== "image") return reply.code(400).send({ error: "unknown_model" });

        const n = count || 1;
        try {
          await assertTokenQuota(app.prisma, userId);
        } catch (err) {
          if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
          throw err;
        }

        // Credits are charged up front, before the (paid, external) kie.ai
        // call is made — admins are exempt, same convention as the token
        // quota in quota.ts effectiveQuota. If the charge fails
        // (insufficient credits), nothing has been sent to kie.ai yet.
        const creditsCost = creditsForImage(modelKey, n);
        const isAdmin = role === "ADMIN";
        if (!isAdmin) {
          try {
            await chargeCredits(app.prisma, userId, creditsCost);
          } catch (err) {
            if (err instanceof InsufficientCreditsError) {
              return reply
                .code(402)
                .send({ error: `Not enough credits. This needs ${err.required}, you have ${err.available}.`, needsCredits: true, required: err.required, available: err.available });
            }
            throw err;
          }
        }

        // kie.ai's Market jobs API is one task per call — no native
        // "generate N variants" param — so 2 variants = 2 parallel
        // createTask calls with the same input, each with its own taskId.
        let taskIds: string[];
        try {
          taskIds = await Promise.all(
            Array.from({ length: n }, () =>
              startMediaGeneration(
                model,
                { prompt, resolution: model.resolution, aspect_ratio: aspectRatio || "1:1", image_url: imageUrl || undefined },
                app.prisma
              ).then((r) => r.taskId)
            )
          );
        } catch (err) {
          // kie.ai rejected the request outright (bad input, upstream
          // down, etc.) — refund immediately rather than waiting for a
          // poll that will never happen, since no taskId/MediaGeneration
          // row exists yet to refund later.
          if (!isAdmin) await refundCredits(app.prisma, userId, creditsCost);
          throw err;
        }
        await recordTokenUsage(app.prisma, userId, IMAGE_GEN_TOKEN_COST * n);
        // Split evenly across the n parallel tasks so a per-row refund (if
        // one of the n images fails while the other succeeds) refunds only
        // that image's share, not the whole batch's credits.
        const creditsPerTask = Math.round(creditsCost / n);
        await app.prisma.mediaGeneration.createMany({
          data: taskIds.map((taskId) => ({
            userId,
            taskId,
            modality: "IMAGE" as const,
            modelKey,
            prompt,
            aspectRatio: aspectRatio || "1:1",
            creditsCharged: isAdmin ? 0 : creditsPerTask,
          })),
        });
        return { taskIds };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "generate", `Image generation failed to start: ${message}`);
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Upload a reference image or motion video and get back a URL that
  // kie.ai (an external server) can fetch directly — needed for Motion
  // Control, which requires real hosted file URLs, not inline data. Reuses
  // the same unguessable-token file store as the "AI created a file" flow
  // (GET /files/:token), just written to from here instead. ----
  app.post(
    "/generate/media-upload",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const file = await req.file({ limits: { fileSize: 100 * 1024 * 1024 } });
      if (!file) return reply.code(400).send({ error: "No file uploaded" });

      const ALLOWED = new Set([
        "image/jpeg",
        "image/png",
        "image/jpg",
        "video/mp4",
        "video/quicktime",
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/x-wav",
        "audio/m4a",
        "audio/x-m4a",
        "audio/mp4",
        "audio/aac",
      ]);
      if (!ALLOWED.has(file.mimetype)) {
        return reply.code(415).send({ error: "Unsupported file type. Upload a JPEG/PNG image, an MP4/MOV video, or an MP3/WAV/M4A/AAC audio file." });
      }

      const buffer = await file.toBuffer();
      if (buffer.length === 0) return reply.code(400).send({ error: "Empty file" });
      if (file.file.truncated) {
        return reply.code(413).send({ error: "File is too large. Max 100MB." });
      }

      await ensureGeneratedFilesDir();
      const token = crypto.randomUUID();
      // "ref__" marks this as a user-uploaded reference (character image,
      // motion video, kling_elements photo, etc.) rather than an AI-created
      // artifact from lib/tools.ts — the frequent cleanupExpiredReferenceUploads
      // job (see lib/cleanup.ts) only sweeps files carrying this marker, on a
      // much shorter fuse (15 min) than the general 24h cleanup, since kie.ai
      // only ever needs to fetch these once, early in a generation job.
      const safeName = "ref__" + file.filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
      await fs.writeFile(path.join(GENERATED_FILES_DIR, `${token}__${safeName}`), buffer);

      // Built from the request's own host, not an env var, so this keeps
      // working whatever domain the server is reached at (ai.visiyon.com in
      // production). Assumes TLS-terminating nginx in front (see
      // nginx.conf) — adjust to http:// for a plain local/dev setup.
      const url = `https://${req.hostname}/api/files/${token}`;
      return { url };
    }
  );

  app.post(
    "/generate/video",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await kieGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Video generation is not configured on this server." });
      }
      const { id: userId, role } = req.user as { id: string; role?: string };
      try {
        const { prompt, modelKey, durationSeconds, aspectRatio, imageUrl, nativeAudio, elementNames, motionVideoUrl, characterOrientation, audioUrl } = z
          .object({
            prompt: z.string().min(1).max(4000),
            modelKey: z.string(),
            durationSeconds: z.number().min(1).max(30).optional(),
            aspectRatio: z.string().max(16).optional(),
            imageUrl: z.string().url().optional(),
            nativeAudio: z.boolean().optional(),
            elementNames: z.array(z.string()).max(6).optional(),
            // Motion Control only: the reference video whose movement gets
            // transferred onto `imageUrl`'s character.
            motionVideoUrl: z.string().url().optional(),
            characterOrientation: z.enum(["image", "video"]).optional(),
            // Avatar only: the audio track the face image will lip-sync to.
            audioUrl: z.string().url().optional(),
          })
          .parse(req.body);

        const model = getMediaModel(modelKey);
        if (!model || model.modality !== "video") return reply.code(400).send({ error: "unknown_model" });

        if (isMotionControlModel(modelKey) && (!imageUrl || !motionVideoUrl)) {
          return reply.code(400).send({ error: "Motion Control needs both a reference image and a motion video." });
        }
        if (isAvatarModel(modelKey) && (!imageUrl || !audioUrl)) {
          return reply.code(400).send({ error: "Avatar needs both a face image and an audio track." });
        }

        // Bound elements (@name references) only apply to models that
        // accept kie.ai's kling_elements input — silently ignored otherwise
        // rather than erroring, so switching models doesn't break the call.
        let klingElements: ReturnType<typeof buildKlingElements> | undefined;
        if (elementNames?.length && supportsElements(modelKey)) {
          const rows = await app.prisma.mediaElement.findMany({ where: { userId, name: { in: elementNames } } });
          klingElements = buildKlingElements(
            rows.map((r) => ({ name: r.name, description: r.description, imageUrls: (r.imageUrls as string[]) || [] }))
          );
        }

        const duration = durationSeconds || 5;
        try {
          await assertTokenQuota(app.prisma, userId);
        } catch (err) {
          if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
          throw err;
        }

        const creditsCost = creditsForVideo(modelKey, duration);
        const isAdmin = role === "ADMIN";
        if (!isAdmin) {
          try {
            await chargeCredits(app.prisma, userId, creditsCost);
          } catch (err) {
            if (err instanceof InsufficientCreditsError) {
              return reply
                .code(402)
                .send({ error: `Not enough credits. This needs ${err.required}, you have ${err.available}.`, needsCredits: true, required: err.required, available: err.available });
            }
            throw err;
          }
        }

        // Motion Control uses a completely different input shape than every
        // other video model here (input_urls/video_urls, no duration/audio —
        // the output length just matches the motion video's own length), so
        // it's built separately instead of bolting extra fields onto the
        // normal prompt/image_url/duration shape below.
        const input = isMotionControlModel(modelKey)
          ? {
              prompt,
              input_urls: [imageUrl],
              video_urls: [motionVideoUrl],
              mode: model.resolution === "1080p" ? "1080p" : "720p",
              character_orientation: characterOrientation || "image",
              background_source: "input_video",
            }
          : isAvatarModel(modelKey)
          ? {
              prompt,
              image_url: imageUrl,
              audio_url: audioUrl,
            }
          : isKling3VideoModel(modelKey)
          ? {
              // kling-3.0/video (non-Turbo): wants `mode`, `image_urls`
              // (plural), and treats `multi_shots` as required — see
              // isKling3VideoModel's comment in kieGen.ts.
              prompt,
              duration: String(duration),
              mode: klingResolutionToMode(model.resolution),
              image_urls: imageUrl ? [imageUrl] : undefined,
              aspect_ratio: imageUrl ? undefined : aspectRatio || "16:9",
              sound: nativeAudio ?? false,
              multi_shots: false,
              kling_elements: klingElements?.length ? klingElements : undefined,
            }
          : isKling3TurboVideoModel(modelKey)
          ? {
              // kling/v3-turbo-image-to-video ("Kling 3.0 Turbo"): a
              // simpler, DIFFERENT schema from plain kling-3.0 above — no
              // mode/sound/multi_shots, `resolution` instead of `mode`, and
              // `duration` as a number, not a string. See
              // isKling3TurboVideoModel's comment in kieGen.ts.
              prompt,
              duration,
              resolution: model.resolution,
              image_urls: imageUrl ? [imageUrl] : undefined,
              aspect_ratio: imageUrl ? undefined : aspectRatio || "16:9",
            }
          : isKling26VideoModel(modelKey)
          ? {
              // kling-2.6/*-video: `sound` (required boolean, not
              // `native_audio`), `image_urls` (plural array), and
              // `duration` restricted to "5" or "10" only — see
              // isKling26VideoModel's comment in kieGen.ts.
              prompt,
              sound: nativeAudio ?? false,
              duration: kling26Duration(duration),
              // Follows the actual attached image, not just which "Kling
              // 2.6" entry was picked — see kling26KieModelId's comment.
              image_urls: imageUrl ? [imageUrl] : undefined,
              aspect_ratio: imageUrl ? undefined : aspectRatio || "16:9",
            }
          : {
              prompt,
              duration: String(duration),
              aspect_ratio: aspectRatio || "16:9",
              image_url: imageUrl || undefined,
              native_audio: nativeAudio ?? false,
              kling_elements: klingElements?.length ? klingElements : undefined,
            };

        let taskId: string;
        try {
          ({ taskId } = await startMediaGeneration(
            isKling26VideoModel(modelKey) ? { ...model, kieModelId: kling26KieModelId(Boolean(imageUrl)) } : model,
            input,
            app.prisma
          ));
        } catch (err) {
          // kie.ai rejected the request outright — refund now, since no
          // MediaGeneration row exists yet for the poll endpoint to
          // refund later.
          if (!isAdmin) await refundCredits(app.prisma, userId, creditsCost);
          throw err;
        }
        await recordTokenUsage(app.prisma, userId, Math.round(VIDEO_GEN_TOKEN_COST_PER_SECOND * duration));
        await app.prisma.mediaGeneration.create({
          data: { userId, taskId, modality: "VIDEO", modelKey, prompt, durationSeconds: duration, creditsCharged: isAdmin ? 0 : creditsCost },
        });
        return { taskId };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "generate", `Video generation failed to start: ${message}`);
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Poll for a generation's result (image or video — same shape). ----
  app.get(
    "/generate/:taskId",
    { preHandler: requireAuth, config: { rateLimit: { max: 240, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      try {
        const result = await checkMediaGeneration(taskId, app.prisma);
        if (result.status === "COMPLETE" || result.status === "FAILED") {
          // Re-host kie.ai's (temporary) result URLs on our own server
          // before they ever reach the DB or the response — kie.ai's temp
          // hosting can expire, but the gallery/download/publish flows all
          // assume a durable URL. Best-effort: persistResultUrls() falls
          // back to the original URL per-file if a download fails, so this
          // never blocks a completed generation from being usable.
          if (result.status === "COMPLETE" && result.resultUrls?.length) {
            result.resultUrls = await persistResultUrls(result.resultUrls, req.hostname);
          }
          // Guarded with a status-not-already-terminal `where`, same
          // exactly-once pattern as the credits refund below — the poll
          // endpoint gets hit repeatedly (every ~few seconds) while a
          // generation is in flight, and once more after it's done, so an
          // unconditional update would fire a duplicate notification on
          // every subsequent poll of an already-COMPLETE/FAILED row.
          app.prisma.mediaGeneration
            .updateMany({
              where: { taskId, status: { notIn: ["COMPLETE", "FAILED"] } },
              data:
                result.status === "COMPLETE"
                  ? { status: "COMPLETE", resultUrls: (result.resultUrls || []) as any }
                  : { status: "FAILED", error: result.error },
            })
            .then(async (updated) => {
              if (updated.count === 0) return;
              const gen = await app.prisma.mediaGeneration.findUnique({
                where: { taskId },
                select: { userId: true, modality: true, modelKey: true },
              });
              if (!gen) return;
              const label = gen.modality === "VIDEO" ? "Video" : "Image";
              await createNotification(app.prisma, {
                userId: gen.userId,
                type: result.status === "COMPLETE" ? "GENERATION_COMPLETE" : "GENERATION_FAILED",
                title: result.status === "COMPLETE" ? `${label} generation ready` : `${label} generation failed`,
                body: result.status === "COMPLETE" ? undefined : result.error,
                sourceId: taskId,
              });
            })
            .catch((err) => logEvent(app.prisma, "ERROR", "generate", `Failed to persist result for ${taskId}: ${err}`));

          if (result.status === "FAILED") {
            // Refund the credits this generation was charged, exactly
            // once — guarded by creditsRefunded so a second poll hitting
            // the same already-FAILED row (a race, or the frontend
            // re-checking) can never refund twice. Best-effort/fire-and-
            // forget like the persist above: a refund hiccup here
            // shouldn't block the FAILED response from reaching the user.
            app.prisma.mediaGeneration
              .findUnique({ where: { taskId }, select: { userId: true, creditsCharged: true, creditsRefunded: true } })
              .then(async (gen) => {
                if (!gen || gen.creditsRefunded || !gen.creditsCharged) return;
                const updated = await app.prisma.mediaGeneration.updateMany({
                  where: { taskId, creditsRefunded: false },
                  data: { creditsRefunded: true },
                });
                if (updated.count > 0) {
                  await refundCredits(app.prisma, gen.userId, gen.creditsCharged);
                }
              })
              .catch((err) => logEvent(app.prisma, "ERROR", "generate", `Failed to refund credits for ${taskId}: ${err}`));
          }
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "generate", `Checking generation failed: ${message}`, { taskId });
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Upscale a previously generated image (Topaz, via kie.ai). Separate
  // from /generate/image because Topaz's input shape (image_url +
  // upscale_factor) doesn't match the prompt/aspect_ratio shape above. Not
  // in MEDIA_MODELS since it's not a pickable "model" — it's an action on
  // an existing result, triggered from the hover toolbar on a finished image.
  app.post(
    "/generate/upscale",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await kieGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Image generation is not configured on this server." });
      }
      const { id: userId } = req.user as { id: string };
      try {
        const { imageUrl, factor } = z
          .object({ imageUrl: z.string().url(), factor: z.number().min(1).max(4).optional() })
          .parse(req.body);

        try {
          await assertTokenQuota(app.prisma, userId);
        } catch (err) {
          if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
          throw err;
        }

        const { taskId } = await startMediaGeneration(
          { key: "topaz-upscale", label: "Upscale", kieModelId: "topaz/image-upscale", modality: "image" },
          { image_url: imageUrl, upscale_factor: String(factor || 2) },
          app.prisma
        );
        await recordTokenUsage(app.prisma, userId, IMAGE_GEN_TOKEN_COST);
        await app.prisma.mediaGeneration.create({
          data: { userId, taskId, modality: "IMAGE", modelKey: "topaz-upscale", prompt: "Upscale" },
        });
        return { taskId };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "generate", `Upscale failed to start: ${message}`);
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Named reference-image "elements" (@name) a user can bind into a
  // Kling 3.0 video prompt for consistent characters/objects. ----
  app.get("/generate/elements", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    return app.prisma.mediaElement.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  });

  app.post("/generate/elements", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    try {
      const { name, description, imageUrls } = z
        .object({
          name: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[a-zA-Z0-9_]+$/, "Name can only contain letters, numbers and underscores (used as @name)."),
          description: z.string().max(500).optional(),
          imageUrls: z.array(z.string().url()).min(1).max(6),
        })
        .parse(req.body);

      const element = await app.prisma.mediaElement.upsert({
        where: { userId_name: { userId, name } },
        update: { description, imageUrls },
        create: { userId, name, description, imageUrls },
      });
      return element;
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
      }
      throw err;
    }
  });

  app.delete("/generate/elements/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id } = req.params as { id: string };
    const result = await app.prisma.mediaElement.deleteMany({ where: { id, userId } });
    if (result.count === 0) return reply.code(404).send({ error: "not_found" });
    return { deleted: true };
  });

  // ---- Delete a generation. Local-only removal (old "Delete" button) just
  // hid it until the next page load re-fetched history from the DB — this
  // actually removes the row, scoped to the owning user so no one can
  // delete someone else's generation by taskId. ----
  app.delete("/generate/:taskId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { taskId } = req.params as { taskId: string };
    const result = await app.prisma.mediaGeneration.deleteMany({ where: { taskId, userId } });
    if (result.count === 0) return reply.code(404).send({ error: "not_found" });
    return { deleted: true };
  });

  // ---- Recent generations for the current user (fills the results grid
  // on page load, so refreshing /generate doesn't lose your history). ----
  app.get("/generate/history/mine", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    return app.prisma.mediaGeneration.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
  });

  // ---- Download proxy for a completed generation's result file.
  //
  // The frontend used to fetch() the result URL directly from the browser
  // to build a downloadable blob. That works fine when the media host
  // sends CORS headers — but kie.ai's result CDN doesn't always, so the
  // fetch was silently rejected by the browser and the UI fell back to
  // window.open(url), which just opens the file in a new tab instead of
  // downloading it (no CORS restrictions apply to a server-to-server
  // fetch, so doing the fetch here sidesteps the problem entirely).
  //
  // Only proxies URLs already stored against a generation the caller
  // owns (looked up by taskId, like the routes above) rather than an
  // arbitrary ?url= param, so this can't be turned into an open proxy.
  app.get("/generate/:taskId/download", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { taskId } = req.params as { taskId: string };

    const gen = await app.prisma.mediaGeneration.findFirst({ where: { taskId, userId } });
    if (!gen) return reply.code(404).send({ error: "not_found" });
    const resultUrls = (gen.resultUrls as string[] | null) || [];
    const sourceUrl = resultUrls[0];
    if (!sourceUrl) return reply.code(404).send({ error: "no_result" });

    let upstream: Response;
    try {
      upstream = await fetch(sourceUrl);
    } catch {
      return reply.code(502).send({ error: "fetch_failed" });
    }
    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ error: "fetch_failed" });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const ext = gen.modality === "VIDEO" ? "mp4" : contentType.includes("png") ? "png" : "jpg";

    reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="visiyon-${taskId}.${ext}"`);
    return reply.send(upstream.body as any);
  });

  // ---- Publish / unpublish a completed generation to the Explore feed.
  // Owner-only (scoped by userId like delete above). Only COMPLETE
  // generations can be published — there's nothing to show otherwise. ----
  app.post("/generate/:taskId/publish", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { taskId } = req.params as { taskId: string };
    const body = (req.body as { publish?: boolean }) || {};
    const publish = body.publish !== false;

    const existing = await app.prisma.mediaGeneration.findFirst({ where: { taskId, userId } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (publish && existing.status !== "COMPLETE") {
      return reply.code(400).send({ error: "not_ready", message: "Only completed generations can be published" });
    }

    const updated = await app.prisma.mediaGeneration.update({
      where: { taskId },
      data: publish
        ? { isPublic: true, publishedAt: existing.publishedAt || new Date() }
        : { isPublic: false },
    });
    return { generation: updated };
  });

  // ---- Like/unlike a published generation. One like per account,
  // enforced by a MediaGenerationLike row with a unique (userId,
  // mediaGenerationId) constraint — previously this just incremented a
  // raw counter with no record of who'd liked what, so the same account
  // could click Like (or replay the request) any number of times. ----
  app.post("/generate/:taskId/like", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { taskId } = req.params as { taskId: string };
    const body = (req.body as { like?: boolean }) || {};
    const like = body.like !== false;

    const existing = await app.prisma.mediaGeneration.findFirst({ where: { taskId, isPublic: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    if (like) {
      // create() with the unique constraint throws on a duplicate — catch
      // that instead of pre-checking, so two rapid clicks can't both pass
      // a "does it exist" check and then both insert.
      try {
        await app.prisma.mediaGenerationLike.create({
          data: { userId, mediaGenerationId: existing.id },
        });
        await app.prisma.mediaGeneration.update({
          where: { taskId },
          data: { likeCount: { increment: 1 } },
        });
      } catch (err: any) {
        if (err?.code !== "P2002") throw err; // already liked — no-op, not an error
      }
    } else {
      const deleted = await app.prisma.mediaGenerationLike
        .delete({ where: { userId_mediaGenerationId: { userId, mediaGenerationId: existing.id } } })
        .catch(() => null);
      if (deleted) {
        await app.prisma.mediaGeneration.update({
          where: { taskId },
          data: { likeCount: { decrement: 1 } },
        });
      }
    }

    const updated = await app.prisma.mediaGeneration.findUniqueOrThrow({ where: { taskId } });
    return { likeCount: Math.max(0, updated.likeCount), liked: like };
  });

  // ---- Public Explore feed: published generations from all users, newest
  // first. No auth required so the feed can render before login (Like
  // itself still requires auth, enforced by /generate/:taskId/like) —
  // but if a session IS attached, use it to report which items the
  // current user has already liked so the button reflects real state
  // instead of resetting to "not liked" on every reload. ----
  app.get("/generate/explore/feed", { preHandler: optionalAuth }, async (req) => {
    const { cursor, take: takeRaw } = req.query as { cursor?: string; take?: string };
    const take = Math.min(Number(takeRaw) || 30, 60);
    const userId = (req.user as { id: string } | undefined)?.id;
    const items = await app.prisma.mediaGeneration.findMany({
      where: { isPublic: true, status: "COMPLETE" },
      orderBy: { publishedAt: "desc" },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        taskId: true,
        modality: true,
        modelKey: true,
        prompt: true,
        aspectRatio: true,
        resultUrls: true,
        likeCount: true,
        publishedAt: true,
        user: { select: { id: true, name: true } },
        ...(userId ? { likes: { where: { userId }, select: { id: true } } } : {}),
      },
    });
    const nextCursor = items.length === take ? items[items.length - 1].id : null;
    const withLiked = items.map(({ likes, ...rest }: any) => ({
      ...rest,
      likedByMe: userId ? (likes?.length ?? 0) > 0 : false,
    }));
    return { items: withLiked, nextCursor };
  });
}
