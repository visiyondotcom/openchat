import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_FILES_DIR } from "../lib/generated-files.js";

// Serves files the AI created via the `create_file` tool (see lib/tools.ts).
// Files are named "<token>__<original filename>" on disk; the token is an
// unguessable UUID, so knowing/guessing a valid URL is the only "auth" here
// — fine for short-lived, non-sensitive generated output, not for anything
// a user uploaded themselves (that's the separate, authenticated /documents
// flow). Files are swept away after 24h by the scheduled cleanup job.
export default async function filesRoutes(app: FastifyInstance) {
  app.get("/files/:token", async (req, reply) => {
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

    const match = entries.find((f) => f.startsWith(`${token}__`));
    if (!match) return reply.code(404).send({ error: "Not found" });

    const filePath = path.join(GENERATED_FILES_DIR, match);
    // Strip the "ref__" marker (see routes/generate.ts's media-upload
    // handler) so it never leaks into a downloaded file's name.
    const originalName = match.slice(token.length + 2).replace(/^ref__/, "");
    const data = await fs.readFile(filePath);

    reply
      .header("Content-Disposition", `attachment; filename="${originalName.replace(/"/g, "")}"`)
      .header("Content-Type", "application/octet-stream")
      .send(data);
  });
}
