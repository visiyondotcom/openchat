import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Readable } from "node:stream";
import { requireAuth } from "../lib/jwt.js";
import { musicGenEnabled, startMusicGeneration, startCoverGeneration, startExtendGeneration, checkMusicGeneration } from "../lib/music.js";
import { logEvent } from "../lib/logger.js";
import { assertTokenQuota, recordTokenUsage, QuotaExceededError } from "../lib/quota.js";

// Reuses the same rolling token-quota bucket as chat/image generation
// (IMAGE_TOKEN_COST's sibling) — override with MUSIC_TOKEN_COST if a
// deployment wants music generations to weigh differently.
const MUSIC_TOKEN_COST = Number(process.env.MUSIC_TOKEN_COST) || 1500;

export default async function musicRoutes(app: FastifyInstance) {
  // ---- Whether music generation is configured at all — the frontend uses
  // this to decide whether to show the "Music" nav item / page at all. ----
  app.get("/music/config", async () => {
    return { enabled: await musicGenEnabled(app.prisma) };
  });

  // ---- Kick off a generation. Suno-style APIs are async, so this only
  // starts the task; the frontend polls /music/generate/:taskId below. ----
  app.post(
    "/music/generate",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await musicGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Music generation is not configured on this server." });
      }
      const { id: userId } = req.user as { id: string };
      try {
        const { prompt, instrumental, customMode, title, style } = z
          .object({
            // In custom mode, `prompt` doubles as lyrics — blank is valid
            // there as long as `instrumental` is also on (matches the
            // frontend's own rule and the music page's own placeholder
            // text: "leave blank and enable Instrumental above"). Outside
            // that combination, prompt is the free-form description and
            // must not be empty.
            prompt: z.string().max(5000),
            instrumental: z.boolean().optional(),
            customMode: z.boolean().optional(),
            title: z.string().min(1).max(80).optional(),
            style: z.string().min(1).max(1000).optional(),
          })
          .refine((v) => v.prompt.trim().length > 0 || (v.customMode && v.instrumental), {
            message: "Prompt is required unless customMode + instrumental are both enabled.",
            path: ["prompt"],
          })
          .parse(req.body);

        try {
          await assertTokenQuota(app.prisma, userId);
        } catch (err) {
          if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
          throw err;
        }

        const { taskId } = await startMusicGeneration(prompt, { instrumental, customMode, title, style }, app.prisma);
        // Charged up front on start, same as image generation — the
        // external provider bills per generation request regardless of
        // whether the caller keeps polling for the result.
        await recordTokenUsage(app.prisma, userId, MUSIC_TOKEN_COST);
        // Persisted row is what backs the public library page — created
        // PENDING here, filled in with tracks (or marked FAILED) once the
        // poll route below observes the provider finish.
        await app.prisma.musicGeneration.create({
          data: { userId, taskId, prompt, instrumental: Boolean(instrumental), style: customMode ? style : null, title: customMode ? title : null },
        });
        return { taskId };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "music", `Music generation failed to start: ${message}`);
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Extend: continue an EXISTING track's own audio from a point
  // onward. Actually sends the track's audio upstream (uploadUrl +
  // continueAt) — unlike the old text-only "extend" that just described
  // the vibe in a prompt and generated an unrelated new track.
  app.post(
    "/music/upload-extend",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await musicGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Music generation is not configured on this server." });
      }
      const { id: userId } = req.user as { id: string };
      try {
        const { uploadUrl, continueAt, prompt, instrumental, customMode, title, style } = z
          .object({
            uploadUrl: z.string().url(),
            continueAt: z.number().min(0).max(3600),
            prompt: z.string().max(5000).optional(),
            instrumental: z.boolean().optional(),
            customMode: z.boolean().optional(),
            title: z.string().min(1).max(80).optional(),
            style: z.string().min(1).max(1000).optional(),
          })
          .parse(req.body);

        try {
          await assertTokenQuota(app.prisma, userId);
        } catch (err) {
          if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
          throw err;
        }

        const { taskId } = await startExtendGeneration(
          uploadUrl,
          continueAt,
          { prompt, instrumental, customMode, title, style },
          app.prisma
        );
        await recordTokenUsage(app.prisma, userId, MUSIC_TOKEN_COST);
        await app.prisma.musicGeneration.create({
          data: { userId, taskId, prompt: prompt || "", instrumental: Boolean(instrumental), style: customMode ? style : null, title: customMode ? title : null },
        });
        return { taskId };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "music", `Extend generation failed to start: ${message}`);
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Cover: re-render ONE uploaded track under a new prompt/style.
  // NOTE: kie.ai (and Suno-wrapper APIs generally) do not offer a true
  // "blend two audio files together" endpoint — this only ever takes a
  // single uploadUrl. Callers that want a "mashup" of two tracks should
  // pick one as the source and describe the other's style in `prompt`.
  app.post(
    "/music/upload-cover",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await musicGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Music generation is not configured on this server." });
      }
      const { id: userId } = req.user as { id: string };
      try {
        const { uploadUrl, prompt, instrumental, customMode, title, style } = z
          .object({
            uploadUrl: z.string().url(),
            prompt: z.string().max(5000),
            instrumental: z.boolean().optional(),
            customMode: z.boolean().optional(),
            title: z.string().min(1).max(80).optional(),
            style: z.string().min(1).max(1000).optional(),
          })
          .refine((v) => v.prompt.trim().length > 0 || (v.customMode && v.instrumental), {
            message: "Prompt is required unless customMode + instrumental are both enabled.",
            path: ["prompt"],
          })
          .parse(req.body);

        try {
          await assertTokenQuota(app.prisma, userId);
        } catch (err) {
          if (err instanceof QuotaExceededError) return reply.code(429).send({ error: err.message, resetAt: err.resetAt });
          throw err;
        }

        const { taskId } = await startCoverGeneration(uploadUrl, prompt, { instrumental, customMode, title, style }, app.prisma);
        await recordTokenUsage(app.prisma, userId, MUSIC_TOKEN_COST);
        await app.prisma.musicGeneration.create({
          data: { userId, taskId, prompt, instrumental: Boolean(instrumental), style: customMode ? style : null, title: customMode ? title : null },
        });
        return { taskId };
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
        }
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "music", `Cover generation failed to start: ${message}`);
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Callback endpoint for the music provider (kie.ai's Suno API POSTs
  // here when a generation finishes). callBackUrl is a required field on
  // /music/generate, but we don't actually need its payload — the frontend
  // gets its result via polling GET /music/generate/:taskId below, which
  // hits the provider's own record-info endpoint directly. This route just
  // has to exist, be publicly reachable, and answer 200 so the provider
  // doesn't retry/alert on delivery failure. No auth: the provider can't
  // send our JWT, and we don't trust or act on the body anyway.
  app.post("/music/callback", async (req, reply) => {
    logEvent(app.prisma, "INFO", "music", "Received music provider callback").catch(() => {});
    return reply.code(200).send({ ok: true });
  });

  // ---- Poll for a generation's result. ----
  app.get(
    "/music/generate/:taskId",
    { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (!(await musicGenEnabled(app.prisma))) {
        return reply.code(503).send({ error: "Music generation is not configured on this server." });
      }
      const { taskId } = req.params as { taskId: string };
      try {
        const result = await checkMusicGeneration(taskId, app.prisma);
        if (result.status === "complete" || result.status === "failed") {
          // Best-effort — a failure to persist shouldn't break the response
          // the frontend is waiting on for this poll.
          app.prisma.musicGeneration
            .update({
              where: { taskId },
              data:
                result.status === "complete"
                  ? { status: "COMPLETE", tracks: result.tracks as any }
                  : { status: "FAILED", error: result.error },
            })
            .catch((err) => logEvent(app.prisma, "ERROR", "music", `Failed to persist result for ${taskId}: ${err}`));
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "music", `Checking music generation failed: ${message}`, { taskId });
        return reply.code(502).send({ error: message });
      }
    }
  );

  // ---- Library: every completed track across all users, for the public
  // "browse, listen, download" page. Requires login (same as the rest of
  // the app) but isn't scoped to the current user — this is a shared,
  // deployment-wide catalog, not a personal history list. ----
  app.get(
    "/music/library",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
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

      // Each generation can produce multiple tracks (Suno-style APIs return
      // 2 takes per request) — flatten to one library entry per track,
      // carrying the parent generation's title/style/genre along.
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

      return { tracks: entries };
    }
  );

  // ---- Distinct genre/style tags across all completed generations, for
  // the library page's filter chips. Since `style` is free-text
  // comma-separated (e.g. "synthwave, upbeat, 120bpm"), this splits and
  // dedupes into individual tags rather than treating the whole field as
  // one genre. ----
  app.get("/music/library/genres", { preHandler: requireAuth }, async () => {
    const rows = await app.prisma.musicGeneration.findMany({
      where: { status: "COMPLETE", style: { not: null } },
      select: { style: true },
    });
    const tags = new Set<string>();
    for (const row of rows) {
      for (const part of (row.style || "").split(",")) {
        const tag = part.trim();
        if (tag) tags.add(tag);
      }
    }
    return { genres: Array.from(tags).sort((a, b) => a.localeCompare(b)) };
  });

  // ---- Force-download proxy: track audio lives on the music provider's
  // own CDN, so a plain `<a href=... download>` silently fails cross-origin
  // (the browser just opens/streams it instead of saving it). We fetch the
  // file server-side and set Content-Disposition ourselves, which makes
  // downloading work regardless of the CDN's own CORS/headers. Requires
  // login like the rest of /music, and only ever forwards responses that
  // actually look like audio — so this can't be used as a general proxy for
  // arbitrary URLs.
  app.get(
    "/music/download",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      // Not `.url()` — persistTrackAudio() now returns our own *permanent*
      // storage path, which is relative (`/api/music-files/<hash>.mp3`)
      // whenever MUSIC_GEN_CALLBACK_URL isn't set. That's the normal case,
      // not an error, so plain non-empty strings are accepted here and
      // resolved against this request's own origin below. Requiring an
      // absolute URL made every download of a permanently-stored track
      // fail with "Invalid url."
      const { url, title } = z
        .object({ url: z.string().min(1), title: z.string().max(120).optional() })
        .parse(req.query);

      const AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|flac|aac|webm)(?:$|[?#])/i;
      let target: URL;
      try {
        target = url.startsWith("/")
          ? new URL(url, `${req.protocol}://${req.headers.host}`)
          : new URL(url);
      } catch {
        return reply.code(400).send({ error: "Invalid url." });
      }
      if (!/^https?:$/.test(target.protocol)) {
        return reply.code(400).send({ error: "Invalid url." });
      }

      try {
        const upstream = await fetch(target.toString());
        if (!upstream.ok || !upstream.body) {
          return reply.code(502).send({ error: "Could not fetch the track." });
        }
        const contentType = upstream.headers.get("content-type") || "";
        const looksLikeAudio = contentType.startsWith("audio/") || AUDIO_EXT_RE.test(target.pathname);
        if (!looksLikeAudio) {
          return reply.code(502).send({ error: "That does not look like an audio file." });
        }
        const safeName = (title || "track").replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 80) || "track";
        const extMatch = target.pathname.match(AUDIO_EXT_RE);
        const ext = extMatch ? extMatch[1] : (contentType.split("/")[1] || "mp3").slice(0, 5);
        reply
          .header("Content-Disposition", `attachment; filename="${safeName}.${ext}"`)
          .header("Content-Type", contentType || "application/octet-stream");
        const len = upstream.headers.get("content-length");
        if (len) reply.header("Content-Length", len);
        return reply.send(Readable.fromWeb(upstream.body as any));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(app.prisma, "ERROR", "music", `Download proxy failed: ${message}`);
        return reply.code(502).send({ error: "Download failed." });
      }
    }
  );
}
