"use client";

import { askConfirm } from "@/components/PromptDialog";
import Select from "@/components/Select";
import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useRef, useState } from "react";
import {
  adminListTrainingBaseModels,
  adminListTrainingDatasets,
  adminUploadTrainingDataset,
  adminDeleteTrainingDataset,
  adminListTrainingJobs,
  adminCreateTrainingJob,
  adminCancelTrainingJob,
  adminDeleteTrainingJob,
  TrainingBaseModel,
  TrainingDataset,
  TrainingJob,
} from "@/lib/api";
import { Upload, Trash2, Play, Square, ChevronDown, ChevronUp, Sparkles } from "lucide-react";

const STATUS_COLORS: Record<TrainingJob["status"], string> = {
  QUEUED: "text-visiyon-text-3",
  PREPARING: "text-yellow-300",
  TRAINING: "text-yellow-300",
  CONVERTING: "text-yellow-300",
  REGISTERING: "text-yellow-300",
  COMPLETE: "text-emerald-400",
  FAILED: "text-red-400",
  CANCELLED: "text-visiyon-text-3",
};

const RUNNING_STATUSES = new Set(["QUEUED", "PREPARING", "TRAINING", "CONVERTING", "REGISTERING"]);

export default function AdminTrainingPage() {
  const ready = useRequireAdmin();
  const [datasets, setDatasets] = useState<TrainingDataset[] | null>(null);
  const [baseModels, setBaseModels] = useState<TrainingBaseModel[] | null>(null);
  const [jobs, setJobs] = useState<TrainingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New-job form state
  const [jobName, setJobName] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedDataset, setSelectedDataset] = useState("");
  const [epochs, setEpochs] = useState(3);
  const [learningRate, setLearningRate] = useState(0.0002);
  const [loraR, setLoraR] = useState(16);
  const [loraAlpha, setLoraAlpha] = useState(32);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [starting, setStarting] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  async function refresh() {
    try {
      const [d, m, j] = await Promise.all([
        adminListTrainingDatasets(),
        adminListTrainingBaseModels(),
        adminListTrainingJobs(),
      ]);
      setDatasets(d.datasets);
      setBaseModels(m.models);
      setJobs(j.jobs);
    } catch {
      setError("Could not reach the server — the database migration may still need to run.");
    }
  }

  useEffect(() => {
    refresh();
    // Poll while any job is actively running so status/log/progress stay
    // live without needing a websocket.
    const interval = setInterval(() => {
      setJobs((prev) => {
        if (prev && prev.some((j) => RUNNING_STATUSES.has(j.status))) refresh();
        return prev;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      await adminUploadTrainingDataset(file);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeleteDataset(d: TrainingDataset) {
    if (!(await askConfirm({ title: `Delete dataset "${d.name}"?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await adminDeleteTrainingDataset(d.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete dataset");
    }
  }

  async function handleStartJob() {
    if (!jobName.trim() || !selectedModel || !selectedDataset) return;
    setStarting(true);
    setError(null);
    try {
      await adminCreateTrainingJob({
        name: jobName.trim(),
        baseModelTag: selectedModel,
        datasetId: selectedDataset,
        epochs,
        learningRate,
        loraR,
        loraAlpha,
      });
      setJobName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start training job");
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel(j: TrainingJob) {
    await adminCancelTrainingJob(j.id);
    await refresh();
  }

  async function handleDeleteJob(j: TrainingJob) {
    if (!(await askConfirm({ title: `Delete job "${j.name}"?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await adminDeleteTrainingJob(j.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete job");
    }
  }

  if (!ready) return null;

  const readyDatasets = (datasets || []).filter((d) => d.status === "READY");

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        </div>

        <div className="max-w-3xl pb-24">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={18} />
            <h2 className="text-lg font-semibold">Training</h2>
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Upload a dataset and LoRA-finetune one of your installed Ollama models on it. When a
            job completes, the result is registered as a new tag in Ollama and shows up in the
            normal model picker — no extra setup needed on the frontend side. Actually{" "}
            <em>running</em> a job needs Python ML packages installed on the backend — see{" "}
            <code className="text-[12px]">backend/training/README.md</code>.
          </p>

          {error && (
            <div className="mb-5 text-[12.5px] border border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-200 rounded-[6px] px-3.5 py-2.5">
              {error}
            </div>
          )}

          {/* ---- Datasets ---- */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-visiyon-text-3">
                Datasets
              </h3>
              <label className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black hover:opacity-90 transition-opacity cursor-pointer">
                <Upload size={14} /> {uploading ? "Uploading…" : "Upload .jsonl"}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jsonl,.json"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(f);
                  }}
                />
              </label>
            </div>
            <p className="text-[12px] text-visiyon-text-3 mb-3">
              One JSON object per line:{" "}
              <code className="text-[11.5px]">{'{"prompt": "...", "completion": "..."}'}</code> or{" "}
              <code className="text-[11.5px]">{'{"messages": [...]}'}</code>.
            </p>
            <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
              {datasets === null && (
                <div className="px-3.5 py-3 text-[13px] text-visiyon-text-3">Loading…</div>
              )}
              {datasets && datasets.length === 0 && (
                <div className="px-3.5 py-3 text-[13px] text-visiyon-text-3">No datasets uploaded yet.</div>
              )}
              {datasets?.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] text-visiyon-text truncate">{d.name}</div>
                    <div className="text-[11.5px] text-visiyon-text-3">
                      {(d.sizeBytes / 1024).toFixed(0)} KB
                      {d.exampleCount != null && ` · ${d.exampleCount} examples`}
                      {d.status !== "READY" && (
                        <span className={d.status === "FAILED" ? "text-red-400" : "text-yellow-300"}>
                          {" "}
                          · {d.status.toLowerCase()}
                          {d.error ? `: ${d.error}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteDataset(d)}
                    className="p-1.5 rounded-[6px] text-visiyon-text-3 hover:text-red-400 hover:bg-visiyon-text/[0.06] transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ---- New job form ---- */}
          <div className="mb-8">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-visiyon-text-3 mb-2">
              Start a training job
            </h3>
            <div className="border border-visiyon-border rounded-[6px] p-4 space-y-2.5">
              <input
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                placeholder={'Job name (e.g. "support-tone-v1")'}
                className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />
              <Select
                value={selectedModel}
                onChange={setSelectedModel}
                placeholder="Select a base model…"
                options={(baseModels ?? []).map((m) => ({
                  value: m.tag,
                  label: `${m.label} (${m.tag})${m.installed ? "" : " — not pulled yet"}`,
                }))}
                className="w-full"
              />
              <Select
                value={selectedDataset}
                onChange={setSelectedDataset}
                placeholder="Select a dataset…"
                options={readyDatasets.map((d) => ({ value: d.id, label: `${d.name} (${d.exampleCount} examples)` }))}
                className="w-full"
              />

              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-[12px] text-visiyon-text-3 hover:text-visiyon-text transition-colors pt-1"
              >
                {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                Advanced hyperparameters
              </button>
              {showAdvanced && (
                <div className="grid grid-cols-2 gap-2.5 pt-1">
                  <LabeledNumber label="Epochs" value={epochs} onChange={setEpochs} step={1} min={1} />
                  <LabeledNumber
                    label="Learning rate"
                    value={learningRate}
                    onChange={setLearningRate}
                    step={0.00005}
                    min={0.00001}
                  />
                  <LabeledNumber label="LoRA r" value={loraR} onChange={setLoraR} step={1} min={1} />
                  <LabeledNumber label="LoRA alpha" value={loraAlpha} onChange={setLoraAlpha} step={1} min={1} />
                </div>
              )}

              <button
                onClick={handleStartJob}
                disabled={starting || !jobName.trim() || !selectedModel || !selectedDataset}
                className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity mt-1"
              >
                <Play size={14} /> {starting ? "Starting…" : "Start training"}
              </button>
            </div>
          </div>

          {/* ---- Jobs ---- */}
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-visiyon-text-3 mb-2">
              Jobs
            </h3>
            <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
              {jobs === null && <div className="px-3.5 py-3 text-[13px] text-visiyon-text-3">Loading…</div>}
              {jobs && jobs.length === 0 && (
                <div className="px-3.5 py-3 text-[13px] text-visiyon-text-3">No training jobs yet.</div>
              )}
              {jobs?.map((j) => {
                const expanded = expandedJob === j.id;
                return (
                  <div key={j.id}>
                    <button
                      onClick={() => setExpandedJob(expanded ? null : j.id)}
                      className="w-full flex items-center justify-between px-3.5 py-2.5 text-left hover:bg-visiyon-text/[0.03] transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] text-visiyon-text truncate">{j.name}</div>
                        <div className="text-[11.5px] text-visiyon-text-3">
                          {j.baseModelTag} · {j.dataset?.name}
                          {j.resultModelTag && ` → ${j.resultModelTag}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-[12px] font-medium ${STATUS_COLORS[j.status]}`}>
                          {j.status}
                          {RUNNING_STATUSES.has(j.status) && ` ${j.progressPercent}%`}
                        </span>
                        {RUNNING_STATUSES.has(j.status) ? (
                          <span
                            role="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancel(j);
                            }}
                            className="p-1.5 rounded-[6px] text-visiyon-text-3 hover:text-red-400 hover:bg-visiyon-text/[0.06] transition-colors"
                          >
                            <Square size={14} />
                          </span>
                        ) : (
                          <span
                            role="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteJob(j);
                            }}
                            className="p-1.5 rounded-[6px] text-visiyon-text-3 hover:text-red-400 hover:bg-visiyon-text/[0.06] transition-colors"
                          >
                            <Trash2 size={14} />
                          </span>
                        )}
                      </div>
                    </button>
                    {expanded && (
                      <div className="px-3.5 pb-3">
                        {j.error && <div className="text-[12px] text-red-400 mb-2">{j.error}</div>}
                        <pre className="text-[11px] leading-relaxed bg-black/40 border border-visiyon-border rounded-[6px] p-3 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-visiyon-text-2">
                          {j.log || "No log output yet."}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  min: number;
}) {
  return (
    <label className="block">
      <span className="block text-[11.5px] text-visiyon-text-3 mb-1">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full text-[13px] bg-transparent text-visiyon-text border border-visiyon-border rounded-[6px] px-3 py-1.5 outline-none focus:border-visiyon-text"
      />
    </label>
  );
}
