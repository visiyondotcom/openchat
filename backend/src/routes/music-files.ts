import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

// Permanent storage for generated track audio (see lib/music.ts's
// persistTrackAudio()). Deliberately separate from GENERATED_FILES_DIR:
// that directory is swept by the scheduled cleanup job (IMAGE_RETENTION_DAYS,
// default 30 days) which is fine for throwaway chat attachments but would
// silently delete a user's music library over time. Filenames are
// content-derived (sha1 of the source URL) so re-persisting the same
// provider URL is idempotent and never creates duplicates.
export const MUSIC_FILES_DIR = process.env.MUSIC_FILES_DIR || "/app/music";

let ensured = false;
export async function ensureMusicFilesDir(): Promise<void> {
  if (ensured) return;
  await fs.mkdir(MUSIC_FILES_DIR, { recursive: true });
  ensured = true;
}

export default async function musicFilesRoutes(app: FastifyInstance) {
  app.get("/music-files/:filename", async (req, reply) => {
    const { filename } = req.params as { filename: string };
    // Only ever our own generated names (sha1 hex + extension) — blocks
    // any path traversal attempt outright.
    if (!/^[a-f0-9]{40}\.[a-z0-9]{2,5}$/i.test(filename)) {
      return reply.code(400).send({ error: "Invalid filename" });
    }
    const filePath = path.join(MUSIC_FILES_DIR, filename);
    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType =
      ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : ext === "m4a" ? "audio/mp4" : "application/octet-stream";

    reply
      .header("Content-Type", contentType)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      // Required for the browser's audio element to allow seeking at all —
      // without this it won't even attempt a Range request.
      .header("Accept-Ranges", "bytes");

    // Support HTTP Range requests (needed for scrubbing/seeking in the
    // audio player). Without this, every request returns the full file
    // from byte 0, so seeking always jumps back to the start.
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      let start = match[1] ? parseInt(match[1], 10) : undefined;
      let end = match[2] ? parseInt(match[2], 10) : undefined;
      if (start === undefined) {
        // suffix range: "bytes=-500" = last 500 bytes
        const suffixLength = end as number;
        start = Math.max(size - suffixLength, 0);
        end = size - 1;
      } else if (end === undefined || end >= size) {
        end = size - 1;
      }
      if (start > end || start >= size) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      const chunkSize = end - start + 1;
      reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${size}`)
        .header("Content-Length", chunkSize);
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header("Content-Length", size);
    return reply.send(createReadStream(filePath));
  });
}
