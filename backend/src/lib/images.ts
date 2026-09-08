// Image generation supports several providers, chosen in Admin > Settings
// > Image generation:
//
//  - "custom"     any endpoint that speaks the OpenAI images API shape
//                  (LocalAI, ComfyUI's OpenAI-compatible wrapper, fal.ai's
//                  compatibility endpoint, our own sd-wrapper, etc).
//  - "selfhosted" same wire format as "custom" — it's the friendly label
//                  + prefilled URL for the bundled sd-wrapper service
//                  (see docker-compose.yml, profile "selfhosted-images"),
//                  which fronts AUTOMATIC1111/stable-diffusion-webui.
//  - "openai"     OpenAI's own DALL-E endpoint.
//  - "stability"  Stability AI's REST API (different request/response
//                  shape from the other three, translated below).
//
// This lets an operator run everything self-hosted end to end (their own
// GPU via sd-wrapper) while still giving other self-hosters the option to
// point at a cloud provider instead, without needing the wrapper at all.
//
// ---- Config resolution ----
// Same "DB wins, falls back to env" pattern as lib/music.ts and
// lib/billing.ts: config can come from Admin > Settings > Image
// generation (the AppSettings singleton row) or from IMAGE_GEN_* env
// vars. Cached in-memory for CACHE_TTL_MS; admin.ts calls
// invalidateImageGenConfigCache() right after a save so a key/provider
// change takes effect immediately, no restart needed.

import type { PrismaClient } from "@prisma/client";

export type ImageGenProvider = "custom" | "selfhosted" | "openai" | "stability";

type ImageGenConfig = {
  enabled: boolean;
  provider: ImageGenProvider;
  url: string | null;
  apiKey: string | null;
  stabilityApiKey: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: ImageGenConfig; expiresAt: number } | null = null;

// Default in-cluster address of the bundled wrapper (see docker-compose.yml).
// Only used when provider is "selfhosted" and no explicit URL was set.
const SELFHOSTED_DEFAULT_URL = "http://sd-wrapper:8000";
const OPENAI_DEFAULT_URL = "https://api.openai.com";

export function invalidateImageGenConfigCache(): void {
  cache = null;
}

function normalizeProvider(value: string | null | undefined): ImageGenProvider {
  return value === "selfhosted" || value === "openai" || value === "stability" ? value : "custom";
}

async function loadConfig(prisma?: PrismaClient): Promise<ImageGenConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    imageGenEnabled: boolean | null;
    imageGenProvider: string | null;
    imageGenUrl: string | null;
    imageGenApiKey: string | null;
    stabilityApiKey: string | null;
  } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          imageGenEnabled: true,
          imageGenProvider: true,
          imageGenUrl: true,
          imageGenApiKey: true,
          stabilityApiKey: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every image call.
      row = null;
    }
  }

  const provider = normalizeProvider(row?.imageGenProvider ?? process.env.IMAGE_GEN_PROVIDER);
  const url = row?.imageGenUrl || process.env.IMAGE_GEN_URL || null;
  const apiKey = row?.imageGenApiKey || process.env.IMAGE_GEN_API_KEY || null;
  const stabilityApiKey = row?.stabilityApiKey || process.env.STABILITY_API_KEY || null;

  // What counts as "configured" differs per provider: selfhosted needs no
  // key at all (it defaults to the bundled wrapper's URL), openai/stability
  // need their key, custom needs a URL.
  const configured =
    provider === "selfhosted" ? true :
    provider === "openai" ? Boolean(apiKey) :
    provider === "stability" ? Boolean(stabilityApiKey) :
    Boolean(url);

  // imageGenEnabled is nullable: null means no explicit admin choice yet,
  // so fall back to "provider is configured" — same as the old
  // env-var-only behavior, so an existing deployment isn't silently
  // disabled after upgrading to this DB-backed config.
  const value: ImageGenConfig = {
    enabled: (row?.imageGenEnabled ?? configured) && configured,
    provider,
    url,
    apiKey,
    stabilityApiKey,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function imageGenEnabled(prisma?: PrismaClient): Promise<boolean> {
  const config = await loadConfig(prisma);
  return config.enabled;
}

export async function imageGenProvider(prisma?: PrismaClient): Promise<ImageGenProvider> {
  const config = await loadConfig(prisma);
  return config.provider;
}

async function generateViaOpenAiShape(
  baseUrl: string,
  apiKey: string | null,
  prompt: string,
  size: string
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/images/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, n: 1, size, response_format: "b64_json" }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image generation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("Image generation returned no image.");

  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  throw new Error("Image generation response had neither b64_json nor url.");
}

async function generateViaStability(apiKey: string, prompt: string, size: string): Promise<string> {
  let [width, height] = size.split("x").map((n) => parseInt(n, 10));
  if (!width || !height) {
    width = 1024;
    height = 1024;
  }
  // Stability's SD3 endpoint takes an aspect ratio rather than raw
  // pixels; approximate from the requested size.
  const ratio = width / height;
  const aspectRatio =
    ratio > 1.7 ? "16:9" :
    ratio > 1.2 ? "3:2" :
    ratio < 0.6 ? "9:16" :
    ratio < 0.85 ? "2:3" :
    "1:1";

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("aspect_ratio", aspectRatio);
  form.append("output_format", "png");

  const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stability AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { image?: string; errors?: string[] };
  if (!data.image) {
    throw new Error(`Stability AI returned no image${data.errors ? `: ${data.errors.join(", ")}` : ""}.`);
  }
  return `data:image/png;base64,${data.image}`;
}

export async function generateImage(prompt: string, size = "1024x1024", prisma?: PrismaClient): Promise<string> {
  const config = await loadConfig(prisma);

  switch (config.provider) {
    case "selfhosted": {
      const url = config.url || SELFHOSTED_DEFAULT_URL;
      return generateViaOpenAiShape(url, config.apiKey, prompt, size);
    }
    case "openai": {
      if (!config.apiKey) {
        throw new Error(
          "Image generation is not configured — set an OpenAI API key in Admin > Settings > Image generation."
        );
      }
      return generateViaOpenAiShape(OPENAI_DEFAULT_URL, config.apiKey, prompt, size);
    }
    case "stability": {
      if (!config.stabilityApiKey) {
        throw new Error(
          "Image generation is not configured — set a Stability AI API key in Admin > Settings > Image generation."
        );
      }
      return generateViaStability(config.stabilityApiKey, prompt, size);
    }
    case "custom":
    default: {
      if (!config.url) {
        throw new Error(
          "Image generation is not configured — set a URL in Admin > Settings > Image generation, or the IMAGE_GEN_URL env var."
        );
      }
      return generateViaOpenAiShape(config.url, config.apiKey, prompt, size);
    }
  }
}
