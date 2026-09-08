import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../lib/jwt.js";
import { processDocument } from "../lib/rag.js";
import { logEvent } from "../lib/logger.js";
import { loadUploadLimits } from "../lib/uploads.js";
import { UPLOADED_DOCUMENTS_DIR, ensureUploadedDocumentsDir } from "../lib/uploaded-documents.js";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  // Zip archives: browsers/OSes report different mimetypes for the same
  // .zip file depending on how it was created, so allow the common set.
  // Contents are unpacked and each supported file inside is extracted —
  // see extractText() in lib/rag.ts.
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
]);

// Per-user total document storage cap (sum of sizeBytes across all their
// documents). Configurable via env; defaults to 500MB per user.
const USER_QUOTA_BYTES = Number(process.env.DOCUMENT_USER_QUOTA_BYTES ?? 500 * 1024 * 1024);

// Documents older than this are auto-deleted (cascades to chunks/embeddings
// via Prisma's onDelete). Configurable via env; defaults to 3 days.
const DOCUMENT_MAX_AGE_MS = Number(process.env.DOCUMENT_MAX_AGE_DAYS ?? 3) * 24 * 60 * 60 * 1000;

function startDocumentCleanupJob(app: FastifyInstance) {
  const run = async () => {
    try {
      const cutoff = new Date(Date.now() - DOCUMENT_MAX_AGE_MS);
      const expired = await app.prisma.document.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
      });
      if (expired.length === 0) return;
      const { count } = await app.prisma.document.deleteMany({
        where: { id: { in: expired.map((d) => d.id) } },
      });
      // Best-effort — an orphaned file on disk isn't worse than what
      // happened before this feature existed, so a failed unlink here
      // never blocks the DB cleanup above.
      await Promise.all(
        expired.map((d) => fs.unlink(path.join(UPLOADED_DOCUMENTS_DIR, d.id)).catch(() => {}))
      );
      if (count > 0) {
        app.log.info({ count }, "auto-deleted expired documents");
      }
    } catch (err) {
      app.log.error({ err }, "document cleanup job failed");
    }
  };
  run(); // also run once at startup
  setInterval(run, 60 * 60 * 1000); // then every hour
}

export default async function documentsRoutes(app: FastifyInstance) {
  // ---- Upload a document into the user's library ----
  // multipart/form-data, field name "file". Processing (extract -> chunk ->
  // embed) runs in the background; the response returns immediately with
  // status PENDING so the UI can poll /documents for READY/FAILED.
  app.post("/documents", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { documentMaxUploadBytes, documentUploadEnabled } = await loadUploadLimits(app.prisma);
    if (!documentUploadEnabled) {
      return reply.code(403).send({ error: "Document uploads are currently disabled by the administrator." });
    }
    const file = await req.file({ limits: { fileSize: documentMaxUploadBytes } });
    if (!file) return reply.code(400).send({ error: "No file uploaded" });

    // Some browsers/OSes send a generic "application/octet-stream" (or
    // similar) mimetype for .zip files instead of a proper zip mimetype —
    // fall back to the file extension in that case rather than rejecting it.
    const isZipByName = file.filename.toLowerCase().endsWith(".zip");
    if (!ALLOWED_MIME.has(file.mimetype) && !isZipByName) {
      return reply.code(415).send({
        error: "Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV, or ZIP.",
      });
    }
    const effectiveMimeType = isZipByName ? "application/zip" : file.mimetype;

    const buffer = await file.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "Empty file" });
    if (file.file.truncated) {
      return reply.code(413).send({
        error: `File is too large. Max ${(documentMaxUploadBytes / 1024 / 1024).toFixed(0)}MB.`,
      });
    }

    const { _sum } = await app.prisma.document.aggregate({
      where: { userId },
      _sum: { sizeBytes: true },
    });
    const currentUsage = _sum.sizeBytes ?? 0;
    if (currentUsage + buffer.length > USER_QUOTA_BYTES) {
      return reply.code(413).send({
        error: `Storage quota exceeded. You're using ${(currentUsage / 1024 / 1024).toFixed(1)}MB of your ${(USER_QUOTA_BYTES / 1024 / 1024).toFixed(0)}MB limit. Delete old documents to free up space.`,
      });
    }

    const document = await app.prisma.document.create({
      data: {
        userId,
        filename: file.filename,
        mimeType: effectiveMimeType,
        sizeBytes: buffer.length,
        status: "PENDING",
      },
    });

    // Keep the original bytes around too (previously only the
    // extracted/embedded text was persisted) so the document can be
    // downloaded again later — see GET /documents/:documentId/download
    // below. Best-effort: a failed write here shouldn't fail the whole
    // upload, since RAG (the primary purpose) still works without it —
    // it just means this particular document won't be downloadable.
    await ensureUploadedDocumentsDir();
    await fs.writeFile(path.join(UPLOADED_DOCUMENTS_DIR, document.id), buffer).catch((err) => {
      app.log.error({ err, documentId: document.id }, "failed to persist original document bytes");
    });

    // Fire-and-forget: don't block the HTTP response on embedding every chunk.
    processDocument(app.prisma, document.id, buffer, effectiveMimeType).catch((err) => {
      app.log.error({ err }, "document processing failed");
      logEvent(app.prisma, "ERROR", "document", `Processing failed for "${document.filename}": ${err}`, {
        documentId: document.id,
      });
    });

    return { document };
  });

  // ---- List the user's document library ----
  app.get("/documents", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    const documents = await app.prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        status: true,
        error: true,
        createdAt: true,
        _count: { select: { chunks: true } },
      },
    });
    return { documents };
  });

  // ---- Delete a document (cascades to chunks + chat links) ----
  app.delete("/documents/:documentId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { documentId } = req.params as { documentId: string };
    const doc = await app.prisma.document.findFirst({ where: { id: documentId, userId } });
    if (!doc) return reply.code(404).send({ error: "Not found" });
    await app.prisma.document.delete({ where: { id: documentId } });
    await fs.unlink(path.join(UPLOADED_DOCUMENTS_DIR, documentId)).catch(() => {});
    return { ok: true };
  });

  // ---- Download a document's original file ----
  // Auth'd + ownership-checked (unlike /files/:token, this is the user's
  // own uploaded library, not a short-lived AI-generated file), so a plain
  // <a href> won't carry the Authorization header — the frontend appends
  // the JWT as ?token=, same fallback requireAuth already supports for
  // SSE/EventSource (see lib/jwt.ts).
  app.get("/documents/:documentId/download", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { documentId } = req.params as { documentId: string };
    const doc = await app.prisma.document.findFirst({ where: { id: documentId, userId } });
    if (!doc) return reply.code(404).send({ error: "Not found" });

    let data: Buffer;
    try {
      data = await fs.readFile(path.join(UPLOADED_DOCUMENTS_DIR, documentId));
    } catch {
      // Uploaded before this feature existed, or the on-disk copy was
      // otherwise lost — there's genuinely nothing to serve.
      return reply.code(404).send({ error: "Original file is no longer available for download." });
    }

    reply
      .header("Content-Disposition", `attachment; filename="${doc.filename.replace(/"/g, "")}"`)
      .header("Content-Type", doc.mimeType || "application/octet-stream")
      .send(data);
  });

  // ---- List documents attached to a specific chat ----
  app.get("/chats/:chatId/documents", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    const links = await app.prisma.chatDocument.findMany({
      where: { chatId },
      include: { document: { select: { id: true, filename: true, status: true } } },
    });
    return { documents: links.map((l) => l.document) };
  });

  // ---- Attach a library document to a chat's RAG context ----
  app.post("/chats/:chatId/documents", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId } = req.params as { chatId: string };
    const { documentId } = z.object({ documentId: z.string() }).parse(req.body);

    const [chat, document] = await Promise.all([
      app.prisma.chat.findFirst({ where: { id: chatId, userId } }),
      app.prisma.document.findFirst({ where: { id: documentId, userId } }),
    ]);
    if (!chat || !document) return reply.code(404).send({ error: "Not found" });

    const link = await app.prisma.chatDocument.upsert({
      where: { chatId_documentId: { chatId, documentId } },
      create: { chatId, documentId },
      update: {},
    });
    return { link };
  });

  // ---- Detach a document from a chat ----
  app.delete("/chats/:chatId/documents/:documentId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { chatId, documentId } = req.params as { chatId: string; documentId: string };
    const chat = await app.prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return reply.code(404).send({ error: "Not found" });

    await app.prisma.chatDocument
      .delete({ where: { chatId_documentId: { chatId, documentId } } })
      .catch(() => null);
    return { ok: true };
  });

  startDocumentCleanupJob(app);
}
