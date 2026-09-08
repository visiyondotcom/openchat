import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../lib/jwt.js";
import { encryptConnectionSecrets, loadServerConnection, testServerConnection, listRemoteFilesStructured, writeRemoteFile } from "../lib/server-connection.js";
import { GENERATED_FILES_DIR } from "../lib/generated-files.js";

const upsertSchema = z
  .object({
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: z.string().min(1).max(255),
    authType: z.enum(["password", "privateKey"]),
    password: z.string().max(2000).optional(),
    privateKey: z.string().max(20000).optional(),
    passphrase: z.string().max(2000).optional(),
    baseDir: z.string().max(1024).optional().nullable(),
  })
  .refine((v) => (v.authType === "password" ? !!v.password : !!v.privateKey), {
    message: "Missing credential for the selected auth type",
  });

function toPublicShape(row: {
  id: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  baseDir: string | null;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.authType,
    baseDir: row.baseDir,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    updatedAt: row.updatedAt,
    // Credentials are never sent back — the client only ever knows one is set.
  };
}

export default async function serverConnectionRoutes(app: FastifyInstance) {
  // ---- Get the current user's connection (credential-free) ----
  app.get("/server-connection", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const row = await app.prisma.serverConnection.findUnique({ where: { userId } });
    return { connection: row ? toPublicShape(row) : null };
  });

  // ---- Create or replace the connection ----
  app.put("/server-connection", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const input = parsed.data;
    const secrets = encryptConnectionSecrets(input);

    const row = await app.prisma.serverConnection.upsert({
      where: { userId },
      create: {
        userId,
        host: input.host,
        port: input.port,
        username: input.username,
        authType: input.authType,
        baseDir: input.baseDir || null,
        ...secrets,
      },
      update: {
        host: input.host,
        port: input.port,
        username: input.username,
        authType: input.authType,
        baseDir: input.baseDir || null,
        // lastTestedAt/lastTestOk are stale after any credential/host change
        lastTestedAt: null,
        lastTestOk: null,
        ...secrets,
      },
    });
    return { connection: toPublicShape(row) };
  });

  // ---- Disconnect (delete) ----
  app.delete("/server-connection", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const existing = await app.prisma.serverConnection.findUnique({ where: { userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.serverConnection.delete({ where: { userId } });
    return { ok: true };
  });

  // ---- Test the stored connection ----
  app.post("/server-connection/test", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const conn = await loadServerConnection(app.prisma, userId);
    if (!conn) return reply.code(404).send({ error: "No server connection configured" });

    const result = await testServerConnection(conn);
    await app.prisma.serverConnection.update({
      where: { userId },
      data: { lastTestedAt: new Date(), lastTestOk: result.ok },
    });
    return result;
  });

  // ---- Browse a directory (FileZilla-style file browser in the chat UI).
  // `path` is relative to the connection's baseDir (or root if unset). ----
  app.get("/server-connection/browse", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { path: dirPath } = z.object({ path: z.string().max(1024).optional() }).parse(req.query);
    const conn = await loadServerConnection(app.prisma, userId);
    if (!conn) return reply.code(404).send({ error: "No server connection configured" });
    try {
      const result = await listRemoteFilesStructured(conn, dirPath || ".");
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Could not list directory" });
    }
  });

  // ---- Drag-and-drop target: takes a file the AI already generated (via
  // the create_file tool, served from GENERATED_FILES_DIR) and writes it
  // straight onto the connected server, without round-tripping the bytes
  // through the browser. ----
  const uploadSchema = z.object({
    token: z.string().regex(/^[a-f0-9-]{36}$/i, "Invalid file token"),
    remoteDir: z.string().max(1024).optional(),
  });
  app.post("/server-connection/upload-from-generated", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    const { token, remoteDir } = parsed.data;

    const conn = await loadServerConnection(app.prisma, userId);
    if (!conn) return reply.code(404).send({ error: "No server connection configured" });

    let entries: string[];
    try {
      entries = await fs.readdir(GENERATED_FILES_DIR);
    } catch {
      return reply.code(404).send({ error: "Generated file not found (it may have expired)" });
    }
    const match = entries.find((f) => f.startsWith(`${token}__`));
    if (!match) return reply.code(404).send({ error: "Generated file not found (it may have expired)" });

    const originalName = match.slice(token.length + 2);
    const data = await fs.readFile(path.join(GENERATED_FILES_DIR, match));

    try {
      const remotePath = path.posix.join(remoteDir || ".", originalName);
      const message = await writeRemoteFile(conn, remotePath, data);
      return { ok: true, message, filename: originalName };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Upload failed" });
    }
  });
}
