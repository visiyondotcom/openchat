// Music generation is optional and off by default — like image generation
// (see lib/images.ts), it needs an external paid service; there's no good
// local-only option. Point MUSIC_GEN_URL at a Suno-compatible API (e.g.
// https://api.kie.ai — see https://aimusic.so/features/ai-music-api /
// https://kie.ai/suno-api) and set MUSIC_GEN_API_KEY to your key and this
// just works.
//
// Suno-style generation is asynchronous: you kick off a task and poll for
// its result, typically 20s-2min later. This wraps that as two calls:
//   startMusicGeneration()  -> { taskId }
//   checkMusicGeneration()  -> { status, tracks? }
//
// Expected shape (kie.ai's Suno API):
//   POST {MUSIC_GEN_URL}/api/v1/generate
//     body: { prompt, customMode: false, instrumental, model }
//     resp: { code: 200, data: { taskId } }
//   GET {MUSIC_GEN_URL}/api/v1/generate/record-info?taskId=...
//     resp: { code: 200, data: { status, response?: { sunoData: [{ id, title, audioUrl, duration }] } } }
//
// If your provider's response shape differs, adjust the two parsing spots
// below (marked ADAPT) — the rest of the app only depends on this file's
// exported types, not on the provider's wire format.

import type { PrismaClient } from "@prisma/client";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { MUSIC_FILES_DIR, ensureMusicFilesDir } from "../routes/music-files.js";

// Provider audio URLs (e.g. kie.ai's tempfile.aiquickdraw.com links) are
// temporary and expire after a while, which silently turned older library
// tracks into permanent 404s. This downloads the file once, right after
// generation completes, and stores it under our own /music-files/ route so
// playback never depends on the provider's URL staying alive. Filename is
// a hash of the source URL, so calling this twice for the same track is a
// harmless no-op (checks the file exists before re-downloading).
const PUBLIC_BASE_URL = (process.env.MUSIC_GEN_CALLBACK_URL || "").replace(/\/music\/callback\/?$/, "") || "";

async function persistTrackAudio(sourceUrl: string): Promise<string> {
  if (!sourceUrl) return sourceUrl;
  try {
    await ensureMusicFilesDir();
    const hash = crypto.createHash("sha1").update(sourceUrl).digest("hex");
    const extMatch = sourceUrl.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
    const ext = (extMatch?.[1] || "mp3").toLowerCase();
    const filename = `${hash}.${ext}`;
    const filePath = path.join(MUSIC_FILES_DIR, filename);

    let alreadyExists = true;
    try {
      await fs.access(filePath);
    } catch {
      alreadyExists = false;
    }

    if (!alreadyExists) {
      const res = await fetch(sourceUrl);
      if (!res.ok) return sourceUrl; // fall back to original URL rather than lose the track
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(filePath, buf);
    }

    // Always route through the /api/ prefix — that's the only nginx
    // location proxying to the backend (see nginx.conf); a bare
    // /music-files/... path only exists on the frontend and 404s there.
    return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/music-files/${filename}` : `/api/music-files/${filename}`;
  } catch {
    // Best-effort — if anything goes wrong, keep the original (temporary)
    // URL rather than failing the whole generation.
    return sourceUrl;
  }
}

export interface MusicTrack {
  id: string;
  title: string;
  audioUrl: string;
  coverUrl?: string;
  durationSeconds?: number;
}

export type MusicTaskStatus = "pending" | "complete" | "failed";

// ---- Config resolution ----
// Same "DB wins, falls back to env" pattern as lib/billing.ts: config can
// come from Admin > Settings > Music (stored on the AppSettings singleton
// row) or from MUSIC_GEN_* env vars. A field left empty in the DB falls
// back to its env var. Cached in-memory for CACHE_TTL_MS; admin.ts calls
// invalidateMusicConfigCache() right after a save so a key change takes
// effect immediately.

type MusicConfig = {
  enabled: boolean;
  url: string | null;
  apiKey: string | null;
  model: string | null;
  callbackUrl: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: MusicConfig; expiresAt: number } | null = null;

export function invalidateMusicConfigCache(): void {
  cache = null;
}

async function loadConfig(prisma?: PrismaClient): Promise<MusicConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    musicGenEnabled: boolean;
    musicGenUrl: string | null;
    musicGenApiKey: string | null;
    musicGenModel: string | null;
    musicGenCallbackUrl: string | null;
  } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          musicGenEnabled: true,
          musicGenUrl: true,
          musicGenApiKey: true,
          musicGenModel: true,
          musicGenCallbackUrl: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every music call.
      row = null;
    }
  }

  const url = row?.musicGenUrl || process.env.MUSIC_GEN_URL || null;
  const apiKey = row?.musicGenApiKey || process.env.MUSIC_GEN_API_KEY || null;
  const value: MusicConfig = {
    // The DB "enabled" toggle only turns things off when explicitly
    // unchecked with url/key already present via env; if nothing sets it
    // in the DB, enabled just follows whether url+key are configured at
    // all (same behavior as before this DB-backed config existed).
    enabled: row ? row.musicGenEnabled && Boolean(url && apiKey) : Boolean(url && apiKey),
    url,
    apiKey,
    model: row?.musicGenModel || process.env.MUSIC_GEN_MODEL || null,
    callbackUrl: row?.musicGenCallbackUrl || process.env.MUSIC_GEN_CALLBACK_URL || null,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function musicGenEnabled(prisma?: PrismaClient): Promise<boolean> {
  const config = await loadConfig(prisma);
  return config.enabled;
}

async function baseUrl(prisma?: PrismaClient): Promise<string> {
  const config = await loadConfig(prisma);
  if (!config.url) throw new Error("Music generation is not configured (no URL set in Admin > Settings or MUSIC_GEN_URL).");
  return config.url.replace(/\/$/, "");
}

async function authHeaders(prisma?: PrismaClient): Promise<Record<string, string>> {
  const config = await loadConfig(prisma);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

export async function startMusicGeneration(
  prompt: string,
  opts: { instrumental?: boolean; model?: string; customMode?: boolean; title?: string; style?: string } = {},
  prisma?: PrismaClient
): Promise<{ taskId: string }> {
  const config = await loadConfig(prisma);
  if (!config.enabled) throw new Error("Music generation is not configured on this server.");

  // kie.ai's Suno API requires callBackUrl on every generate call (it POSTs
  // the result there when done) — omitting it fails with code 422 "Please
  // enter callBackUrl". We don't actually rely on that callback for
  // correctness (checkMusicGeneration polls the record-info endpoint
  // instead), but the field is mandatory, so point it at a reachable no-op
  // endpoint. Set via Admin > Settings > Music, or MUSIC_GEN_CALLBACK_URL,
  // e.g. https://your-domain.com/api/music/callback (see routes/music.ts).
  const callBackUrl = config.callbackUrl;
  if (!callBackUrl) {
    throw new Error(
      "Music generation is missing a callback URL — the provider requires a public callback URL " +
        "(e.g. https://your-domain.com/api/music/callback). Set this in Admin > Settings > Music " +
        "or the MUSIC_GEN_CALLBACK_URL env var."
    );
  }

  // Suno-style APIs require customMode:true + title/style (and prompt acts as
  // lyrics rather than a free-form description) when the caller wants the
  // "Custom mode" fields honored, mirroring suno.com's own UI. In simple mode
  // (the default), prompt is treated as a plain description and title/style
  // are omitted.
  const customMode = Boolean(opts.customMode);
  const body: Record<string, unknown> = {
    prompt,
    customMode,
    instrumental: Boolean(opts.instrumental),
    model: opts.model || config.model || "V4_5PLUS",
    callBackUrl,
  };
  if (customMode) {
    if (opts.title) body.title = opts.title;
    if (opts.style) body.style = opts.style;
  }

  const res = await fetch(`${await baseUrl(prisma)}/api/v1/generate`, {
    method: "POST",
    headers: await authHeaders(prisma),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Music generation failed to start (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  // ADAPT: swap this line if your provider returns the task id elsewhere.
  const taskId = data?.data?.taskId || data?.taskId;
  if (!taskId) {
    // Surface the provider's own error instead of a generic message — kie.ai
    // (and Suno-compatible APIs generally) return a non-2xx-looking body
    // with `code !== 200` and a human-readable `msg` even on HTTP 200, e.g.
    // { code: 400, msg: "insufficient credits" } or a validation error for
    // customMode requiring title/style. Without this, all such failures
    // looked identical ("no taskId") which made them impossible to debug.
    const code = data?.code;
    const msg = data?.msg || data?.message || data?.error;
    if (msg) throw new Error(code != null ? `Music generation failed (code ${code}): ${msg}` : `Music generation failed: ${msg}`);
    throw new Error("Music generation start returned no taskId.");
  }
  return { taskId };
}

// ---- Upload-cover: re-render ONE uploaded track in a new style/prompt.
// This is the real kie.ai Suno-wrapper capability — there is no genuine
// "blend two audio files into one" endpoint on this class of API, so a
// true two-track mashup isn't possible here. `uploadUrl` must be a
// publicly reachable URL (the caller uploads the file somewhere first,
// e.g. this server's own /uploads static route) since kie.ai fetches it
// server-side rather than accepting raw bytes.
//
// Expected shape (kie.ai's Suno API, mirrors /api/v1/generate):
//   POST {MUSIC_GEN_URL}/api/v1/generate/upload-cover
//     body: { uploadUrl, prompt, customMode, instrumental, model, callBackUrl }
//     resp: { code: 200, data: { taskId } }
// If your provider's response shape differs, adjust the ADAPT spot below —
// checkMusicGeneration() (below) is reused as-is to poll the result since
// it's the same record-info endpoint and response shape as normal generate.
export async function startCoverGeneration(
  uploadUrl: string,
  prompt: string,
  opts: { instrumental?: boolean; model?: string; customMode?: boolean; title?: string; style?: string } = {},
  prisma?: PrismaClient
): Promise<{ taskId: string }> {
  const config = await loadConfig(prisma);
  if (!config.enabled) throw new Error("Music generation is not configured on this server.");

  const callBackUrl = config.callbackUrl;
  if (!callBackUrl) {
    throw new Error(
      "Music generation is missing a callback URL — the provider requires a public callback URL " +
        "(e.g. https://your-domain.com/api/music/callback). Set this in Admin > Settings > Music " +
        "or the MUSIC_GEN_CALLBACK_URL env var."
    );
  }

  const customMode = Boolean(opts.customMode);
  const body: Record<string, unknown> = {
    uploadUrl,
    prompt,
    customMode,
    instrumental: Boolean(opts.instrumental),
    model: opts.model || config.model || "V4_5PLUS",
    callBackUrl,
  };
  if (customMode) {
    if (opts.title) body.title = opts.title;
    if (opts.style) body.style = opts.style;
  }

  const res = await fetch(`${await baseUrl(prisma)}/api/v1/generate/upload-cover`, {
    method: "POST",
    headers: await authHeaders(prisma),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cover generation failed to start (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  // ADAPT: swap this line if your provider returns the task id elsewhere.
  const taskId = data?.data?.taskId || data?.taskId;
  if (!taskId) {
    const code = data?.code;
    const msg = data?.msg || data?.message || data?.error;
    if (msg) throw new Error(code != null ? `Cover generation failed (code ${code}): ${msg}` : `Cover generation failed: ${msg}`);
    throw new Error("Cover generation start returned no taskId.");
  }
  return { taskId };
}

// ---- Extend: continue an EXISTING track's own audio past a given point.
// Mirrors startCoverGeneration — same reasons, same shape — except this
// actually sends the track's own audio (uploadUrl) plus where to pick up
// from (continueAt, in seconds), so the result is a genuine continuation
// of that audio rather than a fresh text-only guess at "the same vibe".
//
// Expected shape (kie.ai's Suno API):
//   POST {MUSIC_GEN_URL}/api/v1/generate/upload-extend
//     body: { uploadUrl, continueAt, defaultParamFlag: true, prompt, customMode, instrumental, model, callBackUrl }
//     resp: { code: 200, data: { taskId } }
// If your provider's response shape or param names differ, adjust the
// ADAPT spot below — checkMusicGeneration() is reused as-is to poll.
export async function startExtendGeneration(
  uploadUrl: string,
  continueAt: number,
  opts: { prompt?: string; instrumental?: boolean; model?: string; customMode?: boolean; title?: string; style?: string } = {},
  prisma?: PrismaClient
): Promise<{ taskId: string }> {
  const config = await loadConfig(prisma);
  if (!config.enabled) throw new Error("Music generation is not configured on this server.");

  const callBackUrl = config.callbackUrl;
  if (!callBackUrl) {
    throw new Error(
      "Music generation is missing a callback URL — the provider requires a public callback URL " +
        "(e.g. https://your-domain.com/api/music/callback). Set this in Admin > Settings > Music " +
        "or the MUSIC_GEN_CALLBACK_URL env var."
    );
  }

  const customMode = Boolean(opts.customMode);
  // ROOT CAUSE (previous fix was wrong): this used to hardcode
  // defaultParamFlag: true, which forces kie.ai's "Custom Parameter Mode"
  // — strict validation of prompt/title/style as a full custom generation
  // spec. That's the wrong mode for this feature: our UI only ever
  // collects a free-text "direction", never a real title/style, so kie.ai
  // kept rejecting the request no matter what fallback text we invented
  // (that's why the error looked identical after the last "fix" — the
  // guessed fallback values weren't the problem, defaultParamFlag was).
  //
  // kie.ai's docs are explicit that "Non-Custom Parameter Mode"
  // (defaultParamFlag: false) is the fit for exactly this case: only
  // uploadUrl is required, prompt is optional (kie.ai auto-generates
  // lyrics when it's empty and instrumental is false), and every other
  // parameter — style included — is inherited from the original audio.
  // We only opt into Custom Parameter Mode when the caller actually
  // supplied both a title and a style (i.e. customMode was deliberately
  // turned on with real values), matching how startMusicGeneration/
  // startCoverGeneration already gate customMode elsewhere in this file.
  const hasCustomFields = customMode && Boolean(opts.title) && Boolean(opts.style);
  const trimmedPrompt = (opts.prompt || "").trim();
  const body: Record<string, unknown> = {
    uploadUrl,
    continueAt: Math.max(0, continueAt),
    defaultParamFlag: hasCustomFields,
    prompt: trimmedPrompt,
    customMode,
    instrumental: Boolean(opts.instrumental),
    model: opts.model || config.model || "V4_5PLUS",
    callBackUrl,
  };
  if (hasCustomFields) {
    body.title = String(opts.title).trim().slice(0, 80);
    body.style = String(opts.style).trim().slice(0, 1000);
  }

  const res = await fetch(`${await baseUrl(prisma)}/api/v1/generate/upload-extend`, {
    method: "POST",
    headers: await authHeaders(prisma),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Extend generation failed to start (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  // ADAPT: swap this line if your provider returns the task id elsewhere.
  const taskId = data?.data?.taskId || data?.taskId;
  if (!taskId) {
    const code = data?.code;
    const msg = data?.msg || data?.message || data?.error;
    if (msg) throw new Error(code != null ? `Extend generation failed (code ${code}): ${msg}` : `Extend generation failed: ${msg}`);
    throw new Error("Extend generation start returned no taskId.");
  }
  return { taskId };
}

export async function checkMusicGeneration(
  taskId: string,
  prisma?: PrismaClient
): Promise<{ status: MusicTaskStatus; tracks?: MusicTrack[]; error?: string }> {
  const config = await loadConfig(prisma);
  if (!config.enabled) throw new Error("Music generation is not configured on this server.");

  const res = await fetch(`${await baseUrl(prisma)}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
    headers: await authHeaders(prisma),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Checking music generation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  // ADAPT: this block assumes kie.ai's Suno API response shape.
  const status: string = data?.data?.status || data?.status || "";
  const sunoData: any[] = data?.data?.response?.sunoData || data?.data?.sunoData || [];

  if (/fail|error/i.test(status)) {
    return { status: "failed", error: data?.data?.errorMessage || data?.msg || "Generation failed." };
  }

  // kie.ai's Suno API reports several intermediate statuses (PENDING,
  // TEXT_SUCCESS, FIRST_SUCCESS) before the audio itself is actually ready.
  // Crucially, sunoData entries (title/id) can already show up at
  // FIRST_SUCCESS — *without* an audioUrl yet. Treating "sunoData has
  // entries" as "done" (the old behavior) surfaced tracks in the UI with no
  // playable audio file. Only report "complete" once the provider's status
  // is the actual terminal success state AND every returned track has a
  // real, non-empty audioUrl — otherwise keep polling.
  const tracks: MusicTrack[] = sunoData.map((t: any, i: number) => ({
    id: t.id || `${taskId}-${i}`,
    title: t.title || "Untitled",
    audioUrl: t.audioUrl || t.audio_url || "",
    coverUrl: t.imageUrl || t.image_url,
    durationSeconds: t.duration,
  }));

  const isFinalStatus = /^(success|complete|completed)$/i.test(status.trim());
  const allHaveAudio = tracks.length > 0 && tracks.every((t) => Boolean(t.audioUrl));

  if (isFinalStatus && allHaveAudio) {
    // Download each track's audio (and cover, if present) to our own
    // storage before reporting "complete" — see persistTrackAudio() above.
    // Runs once per track since this function is only reached once all
    // audioUrls are present; a later re-check of the same taskId would
    // recompute the same tracks array (cheap, idempotent) but the caller
    // (routes/music.ts) only persists to the DB on the first "complete".
    await Promise.all(
      tracks.map(async (t) => {
        t.audioUrl = await persistTrackAudio(t.audioUrl);
      })
    );
    return { status: "complete", tracks };
  }

  // Still generating (PENDING / TEXT_SUCCESS / FIRST_SUCCESS / status not
  // yet final, or tracks present but audioUrl missing).
  return { status: "pending" };
}
