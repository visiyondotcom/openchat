// Image/video generation via kie.ai's jobs API — powers the "Generate" page
// (Kling-style: prompt in the middle, model list in the sidebar).
//
// Separate from lib/images.ts (which powers inline chat image generation
// against OpenAI/Stability/self-hosted providers) because kie.ai's jobs API
// is its own wire format that fronts many third-party models by id:
//   POST {KIE_GEN_URL}/api/v1/jobs/createTask
//     body: { model: "<provider/model-id>", input: {...} }
//     resp: { code: 200, data: { taskId } }
//   GET {KIE_GEN_URL}/api/v1/jobs/recordInfo?taskId=...
//     resp: { code: 200, data: { state, resultUrls?, failMsg? } }
//
// Same "DB wins, falls back to env" config pattern as lib/music.ts.

import type { PrismaClient } from "@prisma/client";

export type MediaModality = "image" | "video";

export type MediaModel = {
  key: string;
  label: string;
  kieModelId: string;
  modality: MediaModality;
  resolution?: string;
  recommended?: boolean;
};

// Curated model list. Add/remove entries here to change what shows up in
// the sidebar's model picker on /generate — no other code needs to change.
//
// kieModelId strings verified against docs.kie.ai (Market > Kling / GPT /
// Flux). kie.ai has NO standalone "Kling" text-to-image model — Kling there
// is video-only — so the image tab uses GPT Image-2 / Flux-2 instead (same
// createTask/recordInfo flow). "Kling O3" from the kie.ai dashboard has no
// public docs page yet, so it's left out until an id is confirmed.
export const MEDIA_MODELS: MediaModel[] = [
  // ---- Images (kie.ai has no Kling image model; these are the real ones) ----
  { key: "gpt-image-2-t2i", label: "GPT Image 2", kieModelId: "gpt-image-2-text-to-image", modality: "image", resolution: "2K", recommended: true },
  { key: "flux-2-pro-t2i", label: "Flux 2 Pro", kieModelId: "flux-2/pro-text-to-image", modality: "image", resolution: "1K" },

  // ---- Kling video, via kie.ai Market ----
  { key: "kling-3-0", label: "Kling 3.0", kieModelId: "kling-3.0/video", modality: "video", resolution: "1080p", recommended: true },
  { key: "kling-v3-turbo-i2v", label: "Kling 3.0 Turbo", kieModelId: "kling/v3-turbo-image-to-video", modality: "video", resolution: "1080p" },
  { key: "kling-3-0-motion", label: "Kling 3.0 Motion Control", kieModelId: "kling-3.0/motion-control", modality: "video", resolution: "720p" },
  { key: "kling-2-6-t2v", label: "Kling 2.6", kieModelId: "kling-2.6/text-to-video", modality: "video", resolution: "1080p" },
  { key: "kling-2-6-i2v", label: "Kling 2.6 (image-to-video)", kieModelId: "kling-2.6/image-to-video", modality: "video", resolution: "1080p" },
  { key: "kling-2-6-motion", label: "Kling 2.6 Motion Control", kieModelId: "kling-2.6/motion-control", modality: "video", resolution: "720p" },
  { key: "kling-v2-5-turbo-pro", label: "Kling 2.5 Turbo", kieModelId: "kling/v2-5-turbo-text-to-video-pro", modality: "video", resolution: "1080p" },
  { key: "kling-ai-avatar", label: "Kling AI Avatar", kieModelId: "kling/ai-avatar-standard", modality: "video", resolution: "720p" },
  { key: "kling-ai-avatar-pro", label: "Kling AI Avatar Pro", kieModelId: "kling/ai-avatar-v1-pro", modality: "video", resolution: "720p" },
  { key: "kling-v2-1-standard", label: "Kling V2.1", kieModelId: "kling/v2-1-standard", modality: "video", resolution: "720p" },
];

export function getMediaModel(key: string): MediaModel | undefined {
  return MEDIA_MODELS.find((m) => m.key === key);
}

// kie.ai's kling-3.0/video (and only that model) accepts a `kling_elements`
// array — named reference images the prompt can call by @name for
// consistent characters/objects. Other Kling models on kie.ai don't support
// this input, so callers should only pass elements when modelKey is one
// that supports it (checked via supportsElements below).
export function supportsElements(modelKey: string): boolean {
  return modelKey === "kling-3-0";
}

// Kling's "motion-control" models are a different input shape entirely
// (input_urls/video_urls/character_orientation instead of a plain
// image_url + prompt) — used by the /generate/video route to build the
// right request body for these two models specifically.
export function isMotionControlModel(modelKey: string): boolean {
  return modelKey === "kling-3-0-motion" || modelKey === "kling-2-6-motion";
}

// Avatar models take a face image + an audio track (image_url + audio_url)
// instead of the plain image_url + prompt shape — used by /generate/video
// to build the right request body and to require the right uploads.
export function isAvatarModel(modelKey: string): boolean {
  return modelKey === "kling-ai-avatar" || modelKey === "kling-ai-avatar-pro";
}

// kie.ai's kling-3.0/video (the non-Turbo model) wants `mode` (std/pro/4k),
// `image_urls` (a plural array), and treats `multi_shots` as required
// despite its own docs calling it optional (a missing one gets rejected
// with "multi_shots cannot be empty"). Confirmed against the model's own
// playground schema at kie.ai/kling-3-0.
export function isKling3VideoModel(modelKey: string): boolean {
  return modelKey === "kling-3-0";
}

// kie.ai's kling/v3-turbo-image-to-video ("Kling 3.0 Turbo" here) is a
// DIFFERENT, simpler schema from plain kling-3.0/video above — no `mode`,
// `sound`, or `multi_shots` at all, `resolution` (720p/1080p) instead of
// `mode`, and `duration` as a NUMBER rather than a string. Confirmed
// against the model's own playground schema at kie.ai/kling-3-0-turbo
// ("expected fields": prompt, image_urls, duration:number, resolution).
// Treating it like plain kling-3.0 (as an earlier fix mistakenly did) sends
// fields this model doesn't recognize and a duration in the wrong type.
export function isKling3TurboVideoModel(modelKey: string): boolean {
  return modelKey === "kling-v3-turbo-i2v";
}

// Maps this app's simple resolution label to kie.ai's kling-3.0 `mode` enum.
export function klingResolutionToMode(resolution?: string): "std" | "pro" | "4k" {
  if (resolution === "4k" || resolution === "4K") return "4k";
  if (resolution === "1080p") return "pro";
  return "std";
}

// kie.ai's kling-2.6/text-to-video and kling-2.6/image-to-video use a THIRD
// distinct schema from both Kling 3.0 variants above: the native-audio flag
// is called `sound` (not `native_audio`) and is required, image input is
// `image_urls` (plural array, not `image_url`), and `duration` only accepts
// the literal strings "5" or "10" — this app's UI also offers a 15s option,
// which this model would reject, so it's clamped down to "10". Confirmed
// against the model's own playground schema at kie.ai/kling-2-6.
//
// Unlike Kling 3.0 (one model, image optional), Kling 2.6 is split into two
// SEPARATE kie.ai endpoints with mutually exclusive required fields:
// text-to-video wants `aspect_ratio` and has no image field at all, while
// image-to-video wants `image_urls` and has no `aspect_ratio` field. So the
// choice must follow which modelKey was picked, not just "is an image
// attached" — sending image_urls to the t2v endpoint (e.g. because a
// reference image happened to be attached) leaves its required
// aspect_ratio unset and kie.ai rejects the whole request.
export function isKling26VideoModel(modelKey: string): boolean {
  return modelKey === "kling-2-6-t2v" || modelKey === "kling-2-6-i2v";
}

export function isKling26ImageToVideoModel(modelKey: string): boolean {
  return modelKey === "kling-2-6-i2v";
}

// kie.ai's Kling 2.6 t2v/i2v are two separate endpoints under one "Kling
// 2.6" pick in this app's model list — most people just attach a reference
// image to the generic "Kling 2.6" entry expecting image-to-video, but its
// kieModelId is fixed to the text-only endpoint, which silently ignores any
// image and produces something unrelated to the photo. This picks the
// right kie.ai model id based on whether an image is actually attached,
// regardless of which "Kling 2.6" entry was selected in the sidebar.
export function kling26KieModelId(hasImage: boolean): string {
  return hasImage ? "kling-2.6/image-to-video" : "kling-2.6/text-to-video";
}

export function kling26Duration(durationSeconds: number): "5" | "10" {
  return durationSeconds > 7 ? "10" : "5";
}

export type MediaElementRef = { name: string; description?: string | null; imageUrls: string[] };

export function buildKlingElements(elements: MediaElementRef[]): Array<{
  name: string;
  description: string;
  element_input_urls: string[];
}> {
  return elements
    .filter((e) => e.imageUrls?.length)
    .map((e) => ({ name: e.name, description: e.description || e.name, element_input_urls: e.imageUrls }));
}

type KieGenConfig = {
  enabled: boolean;
  url: string | null;
  apiKey: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: KieGenConfig; expiresAt: number } | null = null;

export function invalidateKieGenConfigCache(): void {
  cache = null;
}

async function loadConfig(prisma?: PrismaClient): Promise<KieGenConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const row = prisma ? await prisma.appSettings.findFirst() : null;
  const url = row?.kieGenUrl || process.env.KIE_GEN_URL || "https://api.kie.ai";
  const apiKey = row?.kieGenApiKey || process.env.KIE_GEN_API_KEY || null;
  const value: KieGenConfig = {
    enabled: row ? row.kieGenEnabled && Boolean(apiKey) : Boolean(apiKey),
    url,
    apiKey,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function kieGenEnabled(prisma?: PrismaClient): Promise<boolean> {
  return (await loadConfig(prisma)).enabled;
}

async function headers(prisma?: PrismaClient): Promise<Record<string, string>> {
  const config = await loadConfig(prisma);
  return { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
}

async function baseUrl(prisma?: PrismaClient): Promise<string> {
  const config = await loadConfig(prisma);
  if (!config.url) throw new Error("Generation is not configured (no URL set in Admin > Settings or KIE_GEN_URL).");
  return config.url.replace(/\/$/, "");
}

export async function startMediaGeneration(
  model: MediaModel,
  input: Record<string, unknown>,
  prisma?: PrismaClient
): Promise<{ taskId: string }> {
  const config = await loadConfig(prisma);
  if (!config.enabled) throw new Error("Image/video generation is not configured on this server.");

  const res = await fetch(`${await baseUrl(prisma)}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: await headers(prisma),
    body: JSON.stringify({ model: model.kieModelId, input }),
  });
  const data: any = await res.json().catch(() => ({}));
  // kie.ai returns its own business-logic `code` in the body (separate from
  // the HTTP status — a request can be HTTP 200 and still be a kie.ai-side
  // failure, e.g. bad model id, insufficient credits, invalid key, rate
  // limit). Previously only `res.ok` was checked, so any such failure fell
  // through silently and surfaced as the unhelpful generic
  // "kie.ai did not return a taskId" instead of kie.ai's actual reason.
  const kieMessage = data?.message || data?.msg || data?.error;
  if (!res.ok) throw new Error(kieMessage || `kie.ai createTask failed (${res.status})`);
  if (data?.code !== undefined && data.code !== 200) {
    throw new Error(kieMessage || `kie.ai createTask failed (code ${data.code})`);
  }
  const taskId = data?.data?.taskId || data?.taskId;
  if (!taskId) throw new Error(kieMessage || "kie.ai did not return a taskId");
  return { taskId };
}

export type MediaGenerationStatus = {
  status: "PENDING" | "COMPLETE" | "FAILED";
  resultUrls?: string[];
  error?: string;
};

export async function checkMediaGeneration(taskId: string, prisma?: PrismaClient): Promise<MediaGenerationStatus> {
  const res = await fetch(`${await baseUrl(prisma)}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: await headers(prisma),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `kie.ai status check failed (${res.status})`);
  const record = data?.data || data;
  const state = String(record?.state || record?.status || "").toLowerCase();

  // kie.ai's Market jobs API puts results in `resultJson`, a JSON-*string*
  // like `{"resultUrls":["https://..."]}` — not a plain object/array. Some
  // other kie.ai endpoints (e.g. Veo) use a nested `response.resultUrls`
  // object instead, so we try both shapes before falling back.
  let parsedResultJson: any = null;
  if (typeof record?.resultJson === "string") {
    try {
      parsedResultJson = JSON.parse(record.resultJson);
    } catch {
      // ignore malformed resultJson, fall through to other shapes
    }
  }

  if (["success", "completed", "succeeded"].includes(state)) {
    const urls: string[] =
      parsedResultJson?.resultUrls ||
      record?.resultUrls ||
      record?.response?.resultUrls ||
      record?.result?.resultUrls ||
      record?.output ||
      (record?.url ? [record.url] : []);
    if (!urls.length) {
      // kie.ai says success but gave us nothing to show — surface this as a
      // failure instead of a silent black/blank result in the UI.
      return { status: "FAILED", error: "kie.ai reported success but returned no result URL." };
    }
    return { status: "COMPLETE", resultUrls: urls };
  }
  if (["fail", "failed", "error"].includes(state)) {
    return { status: "FAILED", error: record?.failMsg || record?.message || "Generation failed" };
  }
  return { status: "PENDING" };
}
