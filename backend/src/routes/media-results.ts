import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_FILES_DIR } from "../lib/generated-files.js";

// Serves media-generation results that persistResultUrls() (lib/persist-
// results.ts) downloaded from kie.ai's temporary hosting and saved locally
// as "<token>__out__result.<ext>". Separate from routes/files.ts (which
// forces an "attachment" download and a generic content-type meant for
// AI-created documents) because these results are rendered inline in
// <img>/<video> tags in the results grid — they need a real content-type
// and no forced download, or the browser won't preview them.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

export default async function mediaResultsRoutes(app: FastifyInstance) {
  app.get("/media/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[a-f0-9-]{36}$/i.test(token)) {
      return reply.code(400).send({ error: "Invalid file token" });
    }

    let entries: string[];
    try {
      entries = await fs.readdir(GENERATED_FILES_DIR);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }

    const match = entries.find((f) => f.startsWith(`${token}__out__`));
    if (!match) return reply.code(404).send({ error: "Not found" });

    const ext = path.extname(match).replace(/^\./, "").toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";
    const data = await fs.readFile(path.join(GENERATED_FILES_DIR, match));

    // Persisted results never change once written, so a long, immutable
    // cache is safe and saves re-serving the same video/image repeatedly.
    reply.header("Content-Type", contentType).header("Cache-Control", "public, max-age=31536000, immutable").send(data);
  });
}
