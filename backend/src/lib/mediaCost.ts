// Credit pricing for every model in lib/kieGen.ts's MEDIA_MODELS.
//
// 1 credit = €0.01 (same convention as the Stripe checkout amounts in
// routes/credits.ts — a "1000 credit" pack costs €10.00).
//
// Prices below are set from kie.ai's own published per-call pricing
// (docs.kie.ai/api-pricing, checked against the Market catalog) with a
// ~55-90% margin on top, rounded up to a whole credit. kie.ai's prices can
// change — if a deployment's actual cost drifts, override the numbers here
// (or move them to Admin > Settings if this needs to be admin-editable
// later); nothing else in the app hardcodes these values, they're only
// ever read through creditsForImage / creditsForVideo below.
//
// Video prices are "credits per 5 seconds" — actual charge scales with the
// requested duration (see creditsForVideo), rounded UP to the next 5s block
// so a 6s request is billed as a full 10s block rather than under-charged.
const IMAGE_CREDITS: Record<string, number> = {
  // kie.ai ~$0.06/image -> ~€0.055 -> charge €0.12 (~120% margin)
  "gpt-image-2-t2i": 12,
  // kie.ai ~$0.035/image -> ~€0.032 -> charge €0.08 (~150% margin, kept a
  // bit higher in absolute terms since credits round to whole numbers)
  "flux-2-pro-t2i": 8,
};

// credits per 5-second block
const VIDEO_CREDITS_PER_5S: Record<string, number> = {
  // Flagship, 1080p, supports elements — kie.ai ~$0.55-0.70/5s depending on
  // mode (std/pro/4k), but Native Audio (sound: true) pushes real usage
  // higher — observed ~135 kie.ai credits (~$0.675) for a single 5s
  // pro+sound generation. Priced with headroom above that so audio-heavy
  // generations still carry a safe margin, not just the silent baseline.
  "kling-3-0": 150,
  "kling-v3-turbo-i2v": 80,
  "kling-3-0-motion": 95,
  "kling-2-6-t2v": 75,
  "kling-2-6-i2v": 75,
  "kling-2-6-motion": 85,
  "kling-v2-5-turbo-pro": 65,
  // Avatar models are billed by kie.ai per generated second of the output
  // audio track, similar order of magnitude to standard video.
  "kling-ai-avatar": 75,
  "kling-ai-avatar-pro": 95,
  "kling-v2-1-standard": 50,
};

// Fallback if a model is ever added to MEDIA_MODELS without a price entry
// above — deliberately high so a missing price fails safe (toward "too
// expensive, go add a real price") rather than silently giving generations
// away for less than they cost.
const DEFAULT_IMAGE_CREDITS = 15;
const DEFAULT_VIDEO_CREDITS_PER_5S = 120;

export function creditsForImage(modelKey: string, count = 1): number {
  const perImage = IMAGE_CREDITS[modelKey] ?? DEFAULT_IMAGE_CREDITS;
  return perImage * Math.max(1, count);
}

export function creditsForVideo(modelKey: string, durationSeconds: number): number {
  const per5s = VIDEO_CREDITS_PER_5S[modelKey] ?? DEFAULT_VIDEO_CREDITS_PER_5S;
  const blocks = Math.max(1, Math.ceil((durationSeconds || 5) / 5));
  return per5s * blocks;
}

// Used by /generate/config so the frontend can show "~N credits" on the
// Generate button before the user even submits, and by the admin-facing
// cost table if that's ever exposed. durationSeconds only matters for
// video models; ignored for image ones.
export function estimateCredits(modelKey: string, modality: "image" | "video", durationSeconds?: number): number {
  return modality === "image" ? creditsForImage(modelKey, 1) : creditsForVideo(modelKey, durationSeconds || 5);
}
