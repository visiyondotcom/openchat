import { spawn } from "child_process";
import { createHash } from "crypto";
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";
import type { PrismaClient } from "@prisma/client";
import { MODEL_CATALOG } from "./model-catalog.js";
import { logEvent } from "./logger.js";

// ---- Fine-tuning pipeline ----
// Ollama only ever serves quantized GGUF weights, which aren't trainable —
// so a job here (1) resolves the admin's chosen Ollama tag to its
// full-precision Hugging Face base model via MODEL_CATALOG[].hfRepo,
// (2) runs training/train_lora.py out-of-process to LoRA-finetune that
// base model on the uploaded dataset, merge the adapter, and convert the
// result to GGUF via llama.cpp's converter, then (3) shells out to
// `ollama create` so the finished model shows up in the normal model
// list/picker like any pulled model. Everything is tracked on the
// TrainingJob row so the admin panel can poll status/log instead of
// needing a websocket.

export const TRAINING_DATA_DIR = process.env.TRAINING_DATA_DIR || "/data/training/datasets";
export const TRAINING_OUTPUT_DIR = process.env.TRAINING_OUTPUT_DIR || "/data/training/output";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").split(",")[0].trim();
const PYTHON_BIN = process.env.TRAINING_PYTHON_BIN || "python3";
const TRAIN_SCRIPT = path.resolve(process.cwd(), "training/train_lora.py");

// One job runs at a time — LoRA fine-tuning is GPU/VRAM-heavy, and a
// self-hosted deployment realistically has one GPU to give it. Extra
// starts just queue behind whatever's currently TRAINING.
let activeJobId: string | null = null;
const queue: string[] = [];

export function resolveHfRepo(ollamaTag: string): string | undefined {
  return MODEL_CATALOG.find((m) => m.tag === ollamaTag)?.hfRepo;
}

// Ollama tags that actually have a known trainable base model — this is
// what the admin "Base model" dropdown offers, filtered further by
// routes/training.ts to whatever's actually installed.
export function listTrainableTags(): string[] {
  return MODEL_CATALOG.filter((m) => !!m.hfRepo).map((m) => m.tag);
}

export async function ensureDirs() {
  await mkdir(TRAINING_DATA_DIR, { recursive: true });
  await mkdir(TRAINING_OUTPUT_DIR, { recursive: true });
}

export interface DatasetValidation {
  ok: boolean;
  exampleCount: number;
  error?: string;
}

// Each line must be a JSON object shaped either
// {"prompt": "...", "completion": "..."} or {"messages": [{role, content}, ...]}
// — the two formats train_lora.py accepts. Read fully but cheaply (this is
// a one-time check right after upload, not a hot path).
export async function validateDataset(filePath: string): Promise<DatasetValidation> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (err: any) {
    return { ok: false, exampleCount: 0, error: `Could not read file: ${err.message}` };
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, exampleCount: 0, error: "File is empty." };
  }

  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    let obj: any;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { ok: false, exampleCount: 0, error: `Line ${i + 1} is not valid JSON.` };
    }
    const hasPromptPair = typeof obj.prompt === "string" && typeof obj.completion === "string";
    const hasMessages = Array.isArray(obj.messages) && obj.messages.length > 0 &&
      obj.messages.every((m: any) => m && typeof m.role === "string" && typeof m.content === "string");
    if (!hasPromptPair && !hasMessages) {
      return {
        ok: false,
        exampleCount: 0,
        error: `Line ${i + 1} must have either {"prompt","completion"} or {"messages":[...]}.`,
      };
    }
    count++;
  }

  return { ok: true, exampleCount: count };
}

export async function saveDatasetFile(buffer: Buffer, originalFilename: string): Promise<{ path: string; filename: string }> {
  await ensureDirs();
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${hash}-${safeName}`;
  const fullPath = path.join(TRAINING_DATA_DIR, filename);
  await writeFile(fullPath, buffer);
  return { path: fullPath, filename };
}

export async function deleteDatasetFile(filePath: string) {
  try {
    await unlink(filePath);
  } catch {
    // already gone — fine, this is best-effort cleanup
  }
}

// Kicks off (or queues) a job. Returns immediately; all progress is
// written to the TrainingJob row as the background process runs.
export function enqueueJob(prisma: PrismaClient, jobId: string) {
  queue.push(jobId);
  void pump(prisma);
}

async function pump(prisma: PrismaClient) {
  if (activeJobId) return; // something already running — it'll call pump() again when done
  const jobId = queue.shift();
  if (!jobId) return;
  activeJobId = jobId;
  try {
    await runJob(prisma, jobId);
  } finally {
    activeJobId = null;
    if (queue.length > 0) void pump(prisma);
  }
}

async function appendLog(prisma: PrismaClient, jobId: string, chunk: string) {
  // Cap the stored log to the last ~200KB so a very chatty run can't grow
  // the row unboundedly — the admin panel only ever shows a tail anyway.
  const job = await prisma.trainingJob.findUnique({ where: { id: jobId }, select: { log: true } });
  const combined = (job?.log || "") + chunk;
  const trimmed = combined.length > 200_000 ? combined.slice(combined.length - 200_000) : combined;
  await prisma.trainingJob.update({ where: { id: jobId }, data: { log: trimmed } }).catch(() => {});
}

async function runJob(prisma: PrismaClient, jobId: string) {
  const job = await prisma.trainingJob.findUnique({ where: { id: jobId }, include: { dataset: true } });
  if (!job) return;

  // Might have been cancelled while it sat in the queue.
  if (job.status === "CANCELLED" as any) return;

  await prisma.trainingJob.update({
    where: { id: jobId },
    data: { status: "PREPARING", startedAt: new Date() },
  });
  await logEvent(prisma, "INFO", "training", `Training job "${job.name}" started`, { jobId });

  const outDir = path.join(TRAINING_OUTPUT_DIR, jobId);
  await mkdir(outDir, { recursive: true });

  const resultTag = `${job.baseModelTag.split(":")[0]}-${job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}:latest`;

  const args = [
    TRAIN_SCRIPT,
    "--base-model", job.baseModelHfRepo,
    "--dataset", job.dataset.path,
    "--output-dir", outDir,
    "--epochs", String(job.epochs),
    "--learning-rate", String(job.learningRate),
    "--lora-r", String(job.loraR),
    "--lora-alpha", String(job.loraAlpha),
    "--ollama-url", OLLAMA_URL,
    "--result-tag", resultTag,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args, { env: process.env });

    proc.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString();
      void appendLog(prisma, jobId, text);
      // train_lora.py prints machine-readable status lines of the form
      // "##STATUS## <STAGE> <percent>" so we can drive the UI's progress
      // bar without parsing free-form log text.
      const m = text.match(/##STATUS##\s+(\w+)\s+(\d+)/);
      if (m) {
        const [, stage, pct] = m;
        void prisma.trainingJob.update({
          where: { id: jobId },
          data: { status: stage as any, progressPercent: Math.min(100, Number(pct)) },
        }).catch(() => {});
      }
    });
    proc.stderr.on("data", (buf: Buffer) => void appendLog(prisma, jobId, buf.toString()));

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`train_lora.py exited with code ${code}`));
    });

    // Store the pid so a cancel request can kill it — best-effort, not
    // persisted across a backend restart (a restart just orphans the
    // process, which is an acceptable edge case for a self-hosted tool).
    runningProcs.set(jobId, proc);
  })
    .then(async () => {
      await prisma.trainingJob.update({
        where: { id: jobId },
        data: { status: "COMPLETE", progressPercent: 100, resultModelTag: resultTag, finishedAt: new Date() },
      });
      await logEvent(prisma, "INFO", "training", `Training job "${job.name}" completed -> ${resultTag}`, { jobId });
    })
    .catch(async (err) => {
      const current = await prisma.trainingJob.findUnique({ where: { id: jobId }, select: { status: true } });
      if (current?.status === ("CANCELLED" as any)) return; // cancel() already set the final state
      await prisma.trainingJob.update({
        where: { id: jobId },
        data: { status: "FAILED", error: String(err?.message || err), finishedAt: new Date() },
      });
      await logEvent(prisma, "ERROR", "training", `Training job "${job.name}" failed: ${err?.message || err}`, { jobId });
    })
    .finally(() => {
      runningProcs.delete(jobId);
    });
}

const runningProcs = new Map<string, ReturnType<typeof spawn>>();

export async function cancelJob(prisma: PrismaClient, jobId: string): Promise<boolean> {
  const job = await prisma.trainingJob.findUnique({ where: { id: jobId } });
  if (!job) return false;
  if (job.status === "COMPLETE" || job.status === "FAILED" || job.status === ("CANCELLED" as any)) return false;

  const proc = runningProcs.get(jobId);
  if (proc) proc.kill("SIGTERM");
  const idx = queue.indexOf(jobId);
  if (idx !== -1) queue.splice(idx, 1);

  await prisma.trainingJob.update({
    where: { id: jobId },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  return true;
}

// Called once at startup: any job left in a non-terminal state from before
// a backend restart (process died mid-run, orphaning it) gets marked
// FAILED rather than sitting forever as "TRAINING" in the admin UI.
export async function reapOrphanedJobs(prisma: PrismaClient) {
  await prisma.trainingJob.updateMany({
    where: { status: { in: ["QUEUED", "PREPARING", "TRAINING", "CONVERTING", "REGISTERING"] as any } },
    data: { status: "FAILED", error: "Backend restarted while this job was running." },
  });
}
