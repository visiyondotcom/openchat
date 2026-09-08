import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { GENERATED_FILES_DIR, ensureGeneratedFilesDir } from "./generated-files.js";

// kie.ai's result URLs (tempfile.aiquickdraw.com and similar) are only
// hosted for a limited, undocumented window. Once a MediaGeneration flips
// to COMPLETE we only get one good shot at the file before it can 404 on
// us, so we fetch it once here and re-host it ourselves — everything after
// that (the gallery, downloads, publishing) points at our own permanent
// /api/media/:token URL instead of kie.ai's temporary one.
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};

function guessExtension(contentType: string | null, sourceUrl: string): string {
  const fromType = contentType && EXT_BY_CONTENT_TYPE[contentType.split(";")[0].trim().toLowerCase()];
  if (fromType) return fromType;
  const fromUrl = path.extname(new URL(sourceUrl).pathname).replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{2,5}$/.test(fromUrl)) return fromUrl;
  return "bin";
}

async function persistOne(sourceUrl: string, hostname: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Fetch failed with ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = guessExtension(res.headers.get("content-type"), sourceUrl);
  const token = crypto.randomUUID();
  // "__out__" marks this as a persisted generation result (kept
  // long-term/indefinitely, see cleanupExpiredResultFiles in lib/cleanup.ts)
  // rather than a short-lived "__ref__" upload or an unmarked AI-tool file.
  await ensureGeneratedFilesDir();
  await fs.writeFile(path.join(GENERATED_FILES_DIR, `${token}__out__result.${ext}`), buffer);
  return `https://${hostname}/api/media/${token}`;
}

// Best-effort: any URL that fails to download (network hiccup, kie.ai
// already expired it, unexpected format) just falls back to the original
// kie.ai URL rather than failing the whole generation — a generation the
// user can currently see is strictly better than one that errors out here.
export async function persistResultUrls(urls: string[], hostname: string): Promise<string[]> {
  return Promise.all(
    urls.map(async (url) => {
      try {
        return await persistOne(url, hostname);
      } catch {
        return url;
      }
    })
  );
}
