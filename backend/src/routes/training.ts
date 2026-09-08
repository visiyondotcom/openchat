import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { listModels } from "../lib/ollama.js";
import { MODEL_CATALOG } from "../lib/model-catalog.js";
import { logEvent } from "../lib/logger.js";
import {
  saveDatasetFile,
  deleteDatasetFile,
  validateDataset,
  resolveHfRepo,
  listTrainableTags,
  enqueueJob,
  cancelJob,
} from "../lib/training.js";

const DATASET_MAX_UPLOAD_BYTES = Number(process.env.TRAINING_DATASET_MAX_MB ?? 200) * 1024 * 1024;

const createJobSchema = z.object({
  name: z.string().min(1).max(80),
  baseModelTag: z.string().min(1),
  datasetId: z.string().min(1),
  epochs: z.number().int().min(1).max(50).default(3),
  learningRate: z.number().positive().max(1).default(0.0002),
  loraR: z.number().int().min(1).max(256).default(16),
  loraAlpha: z.number().int().min(1).max(512).default(32),
});

export default async function trainingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  // ---- Which installed Ollama models can actually be trained ----
  // Intersection of "admin has it pulled" and "we know its HF base repo"
  // (MODEL_CATALOG[].hfRepo) — that's what train_lora.py needs to load.
  app.get("/admin/training/base-models", async () => {
    const [installed, trainableTags] = await Promise.all([
      listModels().catch(() => []),
      Promise.resolve(listTrainableTags()),
    ]);
    const installedNames = new Set(installed.map((m: any) => m.name));
    const options = MODEL_CATALOG
      .filter((m) => m.hfRepo && trainableTags.includes(m.tag))
      .map((m) => ({
        tag: m.tag,
        label: m.label,
        family: m.family,
        paramsB: m.paramsB,
        hfRepo: m.hfRepo,
        installed: installedNames.has(m.tag),
      }));
    return { models: options };
  });

  // ---- Datasets ----
  app.get("/admin/training/datasets", async () => {
    const datasets = await app.prisma.trainingDataset.findMany({
      orderBy: { createdAt: "desc" },
    });
    return { datasets };
  });

  app.post("/admin/training/datasets", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const file = await req.file({ limits: { fileSize: DATASET_MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: "No file uploaded" });

    const name = ((file.fields?.name as any)?.value as string) || file.filename.replace(/\.jsonl?$/i, "");
    if (!/\.(jsonl|json)$/i.test(file.filename)) {
      return reply.code(415).send({ error: "Upload a .jsonl (or .json, one object per line) file." });
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "Empty file" });
    if (file.file.truncated) {
      return reply.code(413).send({
        error: `File is too large. Max ${(DATASET_MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB.`,
      });
    }

    const { path: savedPath, filename } = await saveDatasetFile(buffer, file.filename);

    const dataset = await app.prisma.trainingDataset.create({
      data: {
        name,
        filename,
        sizeBytes: buffer.length,
        path: savedPath,
        status: "VALIDATING",
        createdById: userId,
      },
    });

    // Validate inline — datasets are text files well under the upload cap,
    // so this is fast enough to not need a background job of its own.
    const validation = await validateDataset(savedPath);
    const updated = await app.prisma.trainingDataset.update({
      where: { id: dataset.id },
      data: validation.ok
        ? { status: "READY", exampleCount: validation.exampleCount }
        : { status: "FAILED", error: validation.error },
    });

    await logEvent(app.prisma, "INFO", "training", `Dataset "${name}" uploaded (${updated.status})`, { datasetId: dataset.id });

    return { dataset: updated };
  });

  app.delete("/admin/training/datasets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dataset = await app.prisma.trainingDataset.findUnique({ where: { id } });
    if (!dataset) return reply.code(404).send({ error: "Dataset not found" });

    const jobCount = await app.prisma.trainingJob.count({ where: { datasetId: id } });
    if (jobCount > 0) {
      return reply.code(409).send({ error: "Dataset is used by one or more training jobs. Delete those jobs first." });
    }

    await deleteDatasetFile(dataset.path);
    await app.prisma.trainingDataset.delete({ where: { id } });
    return { ok: true };
  });

  // ---- Jobs ----
  app.get("/admin/training/jobs", async () => {
    const jobs = await app.prisma.trainingJob.findMany({
      orderBy: { createdAt: "desc" },
      include: { dataset: { select: { name: true } } },
    });
    return { jobs };
  });

  app.get("/admin/training/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await app.prisma.trainingJob.findUnique({
      where: { id },
      include: { dataset: { select: { name: true } } },
    });
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return { job };
  });

  app.post("/admin/training/jobs", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message || "Invalid input" });
    const body = parsed.data;

    const dataset = await app.prisma.trainingDataset.findUnique({ where: { id: body.datasetId } });
    if (!dataset) return reply.code(404).send({ error: "Dataset not found" });
    if (dataset.status !== "READY") return reply.code(400).send({ error: "Dataset is not ready (check its validation status)." });

    const hfRepo = resolveHfRepo(body.baseModelTag);
    if (!hfRepo) {
      return reply.code(400).send({ error: "This model has no known trainable base — pick one from the training model list." });
    }

    const job = await app.prisma.trainingJob.create({
      data: {
        name: body.name,
        baseModelTag: body.baseModelTag,
        baseModelHfRepo: hfRepo,
        datasetId: body.datasetId,
        epochs: body.epochs,
        learningRate: body.learningRate,
        loraR: body.loraR,
        loraAlpha: body.loraAlpha,
        status: "QUEUED",
        createdById: userId,
      },
    });

    enqueueJob(app.prisma, job.id);
    await logEvent(app.prisma, "INFO", "training", `Training job "${job.name}" queued`, { jobId: job.id, baseModelTag: body.baseModelTag });

    return { job };
  });

  app.post("/admin/training/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await cancelJob(app.prisma, id);
    if (!ok) return reply.code(400).send({ error: "Job can't be cancelled (already finished, or not found)." });
    return { ok: true };
  });

  app.delete("/admin/training/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await app.prisma.trainingJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (["QUEUED", "PREPARING", "TRAINING", "CONVERTING", "REGISTERING"].includes(job.status)) {
      return reply.code(409).send({ error: "Cancel the job before deleting it." });
    }
    await app.prisma.trainingJob.delete({ where: { id } });
    return { ok: true };
  });
}
