import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { GENERATED_FILES_DIR } from "./generated-files.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const QUOTA_RETENTION_DAYS = Number(process.env.QUOTA_USAGE_RETENTION_DAYS || 90);
const DELIVERY_RETENTION_DAYS = Number(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || 30);
// User-uploaded reference images/motion videos (Character Image, Motion
// video, kling_elements photos — anything from POST /generate/media-upload,
// tagged with the "ref__" marker in its filename) only need to live long
// enough for kie.ai to fetch them once at the start of a generation job.
// Swept on a short, frequent cycle so they don't linger on disk — separate
// from the 24h cleanup below, which covers longer-lived AI-created files.
const REFERENCE_UPLOAD_RETENTION_MINUTES = Number(process.env.REFERENCE_UPLOAD_RETENTION_MINUTES || 15);
const REFERENCE_UPLOAD_SWEEP_INTERVAL_MS = 2 * MINUTE_MS;
// Generated (and user-uploaded vision) images are stored as base64 inline
// in the database, not as files on disk — so unlike GENERATED_FILES_DIR
// there's nothing for the OS to just delete after a day. Default to a
// longer retention since these are actual content the user made/sent,
// not throwaway download links; override with IMAGE_RETENTION_DAYS, or
// set it to 0 to disable this cleanup entirely and keep images forever.
const IMAGE_RETENTION_DAYS = Number(process.env.IMAGE_RETENTION_DAYS ?? 30);
// Media-generation results persisted locally by persistResultUrls() (see
// lib/persist-results.ts), tagged with the "out__" marker — these are the
// user's actual generated videos/images, not throwaway uploads, so default
// to keeping them indefinitely (0 = disabled). Override with
// RESULT_FILE_RETENTION_DAYS if disk space needs bounding.
const RESULT_FILE_RETENTION_DAYS = Number(process.env.RESULT_FILE_RETENTION_DAYS ?? 0);

async function cleanupGeneratedFiles(app: FastifyInstance): Promise<void> {
  try {
    const entries = await fs.readdir(GENERATED_FILES_DIR);
    const cutoff = Date.now() - DAY_MS;
    let deleted = 0;
    for (const name of entries) {
      // "__ref__" (short-lived reference uploads) and "__out__" (persisted
      // generation results) are swept on their own schedules below — this
      // generic 24h sweep is only for unmarked AI-tool-created files
      // (lib/tools.ts).
      if (name.includes("__ref__") || name.includes("__out__")) continue;
      const filePath = `${GENERATED_FILES_DIR}/${name}`;
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.unlink(filePath).catch(() => null);
        deleted++;
      }
    }
    if (deleted > 0) app.log.info({ deleted }, "scheduled cleanup: removed expired generated files");
  } catch {
    // Directory may not exist yet if no file has ever been created — fine.
  }
}

async function cleanupExpiredResultFiles(app: FastifyInstance): Promise<void> {
  if (RESULT_FILE_RETENTION_DAYS <= 0) return; // disabled — keep results forever
  try {
    const entries = await fs.readdir(GENERATED_FILES_DIR);
    const cutoff = Date.now() - RESULT_FILE_RETENTION_DAYS * DAY_MS;
    let deleted = 0;
    for (const name of entries) {
      if (!name.includes("__out__")) continue;
      const filePath = `${GENERATED_FILES_DIR}/${name}`;
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.unlink(filePath).catch(() => null);
        deleted++;
      }
    }
    if (deleted > 0) app.log.info({ deleted }, "scheduled cleanup: removed expired result files");
  } catch {
    // Directory may not exist yet if no file has ever been created — fine.
  }
}

async function cleanupExpiredReferenceUploads(app: FastifyInstance): Promise<void> {
  if (REFERENCE_UPLOAD_RETENTION_MINUTES <= 0) return; // disabled
  try {
    const entries = await fs.readdir(GENERATED_FILES_DIR);
    const cutoff = Date.now() - REFERENCE_UPLOAD_RETENTION_MINUTES * MINUTE_MS;
    let deleted = 0;
    for (const name of entries) {
      // Only touch files carrying the "ref__" marker set in
      // routes/generate.ts's /generate/media-upload handler — leaves
      // AI-created artifacts (lib/tools.ts) alone for the slower 24h sweep.
      if (!name.includes("__ref__")) continue;
      const filePath = `${GENERATED_FILES_DIR}/${name}`;
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.unlink(filePath).catch(() => null);
        deleted++;
      }
    }
    if (deleted > 0) app.log.info({ deleted }, "scheduled cleanup: removed expired reference uploads");
  } catch {
    // Directory may not exist yet if no file has ever been created — fine.
  }
}

// Matches every embedded `![...](data:image/...;base64,...)` markdown
// image in a message's content — used both to strip assistant-generated
// images out of old messages and to size-check before bothering to touch
// a row at all. Global so a message with more than one image is handled
// in one pass.
const EMBEDDED_IMAGE_RE = /!\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+\/=]+\)/g;
const EXPIRED_IMAGE_PLACEHOLDER = "![Image expired](about:blank)";

async function cleanupOldImages(app: FastifyInstance): Promise<void> {
  if (!IMAGE_RETENTION_DAYS || IMAGE_RETENTION_DAYS <= 0) return; // disabled
  const cutoff = new Date(Date.now() - IMAGE_RETENTION_DAYS * DAY_MS);

  // Assistant-generated images embedded in message content.
  const candidates = await app.prisma.message.findMany({
    where: { createdAt: { lt: cutoff }, content: { contains: "data:image" } },
    select: { id: true, content: true },
  });
  let contentCleared = 0;
  for (const msg of candidates) {
    if (!EMBEDDED_IMAGE_RE.test(msg.content)) continue;
    EMBEDDED_IMAGE_RE.lastIndex = 0;
    const cleaned = msg.content.replace(EMBEDDED_IMAGE_RE, EXPIRED_IMAGE_PLACEHOLDER);
    await app.prisma.message.update({ where: { id: msg.id }, data: { content: cleaned } });
    contentCleared++;
  }

  // User-uploaded vision attachments (the separate `images` array field).
  const { count: attachmentsCleared } = await app.prisma.message.updateMany({
    where: { createdAt: { lt: cutoff }, images: { isEmpty: false } },
    data: { images: [] },
  });

  if (contentCleared > 0 || attachmentsCleared > 0) {
    app.log.info(
      { contentCleared, attachmentsCleared, retentionDays: IMAGE_RETENTION_DAYS },
      "scheduled cleanup: cleared expired embedded images"
    );
  }
}

async function runCleanup(app: FastifyInstance): Promise<void> {
  const quotaCutoff = new Date(Date.now() - QUOTA_RETENTION_DAYS * DAY_MS);
  const deliveryCutoff = new Date(Date.now() - DELIVERY_RETENTION_DAYS * DAY_MS);

  try {
    const { count: quotaDeleted } = await app.prisma.quotaEvent.deleteMany({
      where: { createdAt: { lt: quotaCutoff } },
    });
    const { count: deliveriesDeleted } = await app.prisma.webhookDelivery.deleteMany({
      where: { createdAt: { lt: deliveryCutoff } },
    });
    if (quotaDeleted > 0 || deliveriesDeleted > 0) {
      app.log.info(
        { quotaDeleted, deliveriesDeleted },
        "scheduled cleanup: removed old QuotaEvent / WebhookDelivery rows"
      );
    }
    await cleanupGeneratedFiles(app);
    await cleanupExpiredResultFiles(app);
    await cleanupOldImages(app);
  } catch (err) {
    app.log.error({ err }, "scheduled cleanup failed");
  }
}

// Runs once at startup (so retention is enforced even if the process
// restarts daily, e.g. in a container that gets redeployed often) and then
// every 24h thereafter. This is the automatic counterpart to the manual
// "opruimen" buttons in the admin panel — an admin can still trigger it on
// demand, but nothing has to remember to click them for the tables to stay
// bounded.
export function scheduleCleanup(app: FastifyInstance): void {
  runCleanup(app);
  const timer = setInterval(() => runCleanup(app), DAY_MS);
  // Don't let the interval keep the process alive on its own during shutdown.
  timer.unref();

  // Reference uploads (Character Image, Motion video, kling_elements
  // photos) need a much shorter fuse than the daily sweep above — they're
  // only ever fetched once by kie.ai early in a job, so leaving them for a
  // full day just wastes disk. Run this one on its own frequent cycle.
  cleanupExpiredReferenceUploads(app);
  const refTimer = setInterval(() => cleanupExpiredReferenceUploads(app), REFERENCE_UPLOAD_SWEEP_INTERVAL_MS);
  refTimer.unref();
}
