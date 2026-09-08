"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import {
  adminGetHealth,
  adminListModelSettings,
  adminSetModelSetting,
  adminDeleteModelSetting,
  adminPullModel,
  adminDeleteOllamaModel,
  adminGetModelCatalog,
  listPipes,
  listProviders,
  ModelSetting,
  CatalogGpu,
  CatalogModel,
} from "@/lib/api";
import { Check, CircleCheck, CircleX, Cpu, Download, Eye, EyeOff, Loader2, Pencil, Plug, RotateCcw, Settings, Trash2, Zap } from "lucide-react";
import ModelParamsModal from "@/components/ModelParamsModal";

type Row = {
  name: string;
  kind: "ollama" | "pipe" | "provider";
  rawLabel: string; // original name / pipe name, shown as fallback
  override?: ModelSetting;
};

// Mirrors the embedding-model detection used server-side (see
// EMBEDDING_NAME_PATTERN in backend/src/routes/models.ts) to filter these
// out of this page specifically — they're not chat models, so there's
// nothing here to give a display name to or hide from the picker; they're
// already excluded from the picker automatically. Other admin pages that
// read the same /admin/health data (e.g. Pull/Delete Models) intentionally
// keep showing every installed model, embeddings included.
const EMBEDDING_NAME_PATTERN = /nomic-embed|embed|bge-|minilm|e5-|gte-/i;

export default function AdminModelsPage() {
  const ready = useRequireAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingName, setSavingName] = useState<string | null>(null);
  const [paramsRow, setParamsRow] = useState<Row | null>(null);

  // ---- Pull / delete models straight from Ollama ----
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  // ---- "Will it run?" GPU scan + model catalog ----
  const [catalogGpus, setCatalogGpus] = useState<CatalogGpu[] | null>(null);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[] | null>(null);
  const [gpuStatsAvailable, setGpuStatsAvailable] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);

  async function loadCatalog() {
    setCatalogLoading(true);
    try {
      const { gpus, gpuStatsAvailable, models } = await adminGetModelCatalog();
      setCatalogGpus(gpus);
      setGpuStatsAvailable(gpuStatsAvailable);
      setCatalogModels(models);
    } catch {
      setCatalogGpus(null);
      setCatalogModels(null);
    } finally {
      setCatalogLoading(false);
    }
  }

  async function load() {
    try {
      const [health, { settings }, pipesRes, providersRes] = await Promise.all([
        adminGetHealth().catch(() => ({ ollama: { up: false, models: [] }, searxng: { up: false } })),
        adminListModelSettings(),
        listPipes().catch(() => ({ pipes: [] })),
        listProviders().catch(() => ({ providers: [] })),
      ]);
      const overrideByName = new Map(settings.map((s) => [s.name, s]));
      const ollamaRows: Row[] = health.ollama.models
        .filter((name) => !EMBEDDING_NAME_PATTERN.test(name))
        .map((name) => ({
          name,
          kind: "ollama",
          rawLabel: name,
          override: overrideByName.get(name),
        }));
      const pipeRows: Row[] = (pipesRes.pipes ?? []).map((p: any) => ({
        name: `pipe:${p.slug}`,
        kind: "pipe",
        rawLabel: p.name,
        override: overrideByName.get(`pipe:${p.slug}`),
      }));
      // Models offered by an external AI provider (OpenAI, Anthropic, or
      // any OpenAI-compatible endpoint — see Admin > AI Providers). Same
      // rename/hide mechanism as Ollama models and Pipes, keyed the same
      // way routes/models.ts names them ("provider:<providerId>:<model>").
      const providerRows: Row[] = (providersRes.providers ?? []).flatMap((p) =>
        p.models.map((modelName) => {
          const name = `provider:${p.id}:${modelName}`;
          return {
            name,
            kind: "provider" as const,
            rawLabel: `${p.name}: ${modelName}`,
            override: overrideByName.get(name),
          };
        })
      );
      setRows([...ollamaRows, ...pipeRows, ...providerRows]);
      setLoadError(false);
    } catch {
      setLoadError(true);
      setRows([]);
    }
  }

  useEffect(() => {
    load();
    loadCatalog();
  }, []);

  function startEdit(row: Row) {
    setEditing(row.name);
    setDraft(row.override?.displayName ?? row.rawLabel);
  }

  async function saveEdit(row: Row) {
    const trimmed = draft.trim();
    setSavingName(row.name);
    try {
      // Empty (or equal to the raw label) means "no override" — clear it
      // instead of storing a redundant row.
      if (!trimmed || trimmed === row.rawLabel) {
        if (row.override) await adminDeleteModelSetting(row.name);
      } else {
        await adminSetModelSetting(row.name, { displayName: trimmed });
      }
      await load();
      setEditing(null);
    } catch {
      setLoadError(true);
    } finally {
      setSavingName(null);
    }
  }

  async function resetName(row: Row) {
    if (!row.override) return;
    setSavingName(row.name);
    try {
      if (row.override.hidden) {
        // Keep the hidden flag, just drop the display-name part.
        await adminSetModelSetting(row.name, { displayName: null, hidden: true });
      } else {
        await adminDeleteModelSetting(row.name);
      }
      await load();
    } catch {
      setLoadError(true);
    } finally {
      setSavingName(null);
    }
  }

  async function toggleHidden(row: Row) {
    setSavingName(row.name);
    try {
      await adminSetModelSetting(row.name, {
        displayName: row.override?.displayName ?? undefined,
        hidden: !(row.override?.hidden ?? false),
      });
      await load();
    } catch {
      setLoadError(true);
    } finally {
      setSavingName(null);
    }
  }

  async function handlePull(overrideName?: string) {
    const name = (overrideName ?? pullName).trim();
    if (!name || pulling) return;
    setPulling(true);
    setPullError(null);
    try {
      const result = await adminPullModel(name);
      if (!result.ok) {
        setPullError(
          `Pull failed${result.failed?.length ? ` on: ${result.failed.join(", ")}` : ""}.`
        );
      } else {
        setPullName("");
        await Promise.all([load(), loadCatalog()]);
      }
    } catch {
      setPullError("Pull failed — check that Ollama is reachable and the model name is correct.");
    } finally {
      setPulling(false);
    }
  }

  async function handleDeleteOllamaModel(row: Row) {
    if (row.kind !== "ollama") return;
    if (!confirm(`Delete "${row.name}" from Ollama? This removes the model file itself.`)) return;
    setDeletingName(row.name);
    try {
      const result = await adminDeleteOllamaModel(row.name);
      if (!result.ok) {
        setPullError(
          `Delete failed${result.failed?.length ? ` on: ${result.failed.join(", ")}` : ""}.`
        );
      } else {
        await load();
      }
    } catch {
      setPullError("Delete failed — check that Ollama is reachable.");
    } finally {
      setDeletingName(null);
    }
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        </div>

        <div className="max-w-3xl pb-24">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold">Will it run?</h2>
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-4">
            Scans the GPU(s) attached to the server and checks which popular models actually
            fit, before you pull anything.
          </p>

          {catalogLoading ? (
            <p className="text-sm text-visiyon-text-3 mb-6">Scanning GPUs…</p>
          ) : !gpuStatsAvailable || !catalogGpus || catalogGpus.length === 0 ? (
            <div className="mb-6 text-[12.5px] border border-visiyon-border bg-visiyon-text/[0.03] text-visiyon-text-3 rounded-[6px] px-3.5 py-2.5">
              No GPU could be detected from the server container, so fit can't be checked here.
              This is normal unless the stack was started with the GPU override (
              <code>docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build</code>
              ). You can still pull any model by tag below.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-4">
                {catalogGpus.map((g) => (
                  <div
                    key={g.index}
                    className="flex items-center gap-2 text-[12.5px] border border-visiyon-border rounded-[6px] px-3 py-1.5"
                  >
                    <Cpu size={13} className="text-visiyon-text-3" />
                    <span>GPU {g.index}: {g.name}</span>
                    <span className="text-visiyon-text-3">
                      {g.freeVramGB.toFixed(1)} / {g.totalVramGB.toFixed(1)} GB free
                    </span>
                  </div>
                ))}
              </div>

              <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border mb-6">
                {(catalogModels ?? []).map((m) => (
                  <div key={m.tag} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="shrink-0">
                      {m.fits === null ? null : m.fitsNow ? (
                        <CircleCheck size={15} className="text-green-400" />
                      ) : m.fits ? (
                        <span title="Fits the card, but not with current free VRAM">
                          <CircleCheck size={15} className="text-yellow-400" />
                        </span>
                      ) : (
                        <CircleX size={15} className="text-red-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13.5px] truncate">
                        {m.label}{" "}
                        <span className="text-visiyon-text-3 font-mono text-[11px]">{m.tag}</span>
                        {m.vision && (
                          <span className="ml-1.5 text-[10.5px] px-1.5 py-0.5 rounded-full border border-visiyon-border text-visiyon-text-3">
                            vision
                          </span>
                        )}
                      </div>
                      <div className="text-[11.5px] text-visiyon-text-3 truncate">
                        {m.paramsB}B · {m.quant} · ~{m.sizeGB} GB download · needs ~{m.minVramGB} GB VRAM
                      </div>
                    </div>
                    {m.installed ? (
                      <span className="text-[12px] text-visiyon-text-3 shrink-0 px-3 py-1.5">Installed</span>
                    ) : (
                      <button
                        onClick={() => handlePull(m.tag)}
                        disabled={pulling}
                        className="flex items-center gap-1.5 text-[12.5px] px-2.5 py-1.5 rounded-[6px] border border-visiyon-border hover:bg-visiyon-text/[0.06] disabled:opacity-40 shrink-0"
                        title={m.fitsNow === false ? "May not fit with current free VRAM" : "Pull this model"}
                      >
                        <Download size={12.5} />
                        Pull
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[11.5px] text-visiyon-text-3 mb-6">
                <CircleCheck size={11} className="inline text-green-400 mb-[1px]" /> fits now ·{" "}
                <CircleCheck size={11} className="inline text-yellow-400 mb-[1px]" /> fits the card, but not
                with what's currently free ·{" "}
                <CircleX size={11} className="inline text-red-400 mb-[1px]" /> too large for this GPU.
                Estimates only — actual usage varies with context length and what else is loaded.
              </p>
            </>
          )}

          <div className="h-px bg-visiyon-border my-8" />

          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold">Pull / delete models</h2>
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-4">
            Pull a model straight from Ollama's library (e.g. <code>jean:4b</code>,{" "}
            <code>llama3.1:8b</code>) onto every configured Ollama instance. This actually
            downloads or removes the model file — unlike renaming/hiding below.
          </p>

          <div className="flex items-center gap-2 mb-2">
            <input
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePull();
              }}
              placeholder="model:tag, e.g. jean:4b"
              disabled={pulling}
              className="flex-1 text-[13.5px] bg-transparent border border-visiyon-border rounded-[6px] px-2.5 py-1.5 outline-none focus:border-visiyon-text disabled:opacity-50"
            />
            <button
              onClick={() => handlePull()}
              disabled={pulling || !pullName.trim()}
              className="flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-[6px] bg-white text-black hover:bg-visiyon-text/90 disabled:opacity-40 disabled:hover:bg-white"
            >
              {pulling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {pulling ? "Pulling…" : "Pull"}
            </button>
          </div>
          {pulling && (
            <p className="text-[12px] text-visiyon-text-3 mb-3">
              Downloading — this can take a few minutes for larger models. The list below
              refreshes automatically once it's done.
            </p>
          )}
          {pullError && (
            <p className="text-[12.5px] text-red-400 mb-3">{pullError}</p>
          )}

          <div className="h-px bg-visiyon-border my-8" />

          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold">Models</h2>
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Give models a readable name in the picker, or hide them from users — including
            models served through an external AI Provider. This only changes the display; the
            model itself (in Ollama, or at the provider) stays unchanged.
          </p>

          {loadError && (
            <div className="mb-5 text-[12.5px] border border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-200 rounded-[6px] px-3.5 py-2.5">
              Could not reach the server (the database migration may still need to run:{" "}
              <code>npx prisma migrate dev</code> in <code>backend/</code>).
            </div>
          )}

          {!rows ? (
            <p className="text-sm text-visiyon-text-3">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-visiyon-text-3">
              No models found. Pull one with <code>ollama pull jean:4b</code>.
            </p>
          ) : (
            <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
              {rows.map((row) => {
                const isHidden = row.override?.hidden ?? false;
                const isEditing = editing === row.name;
                const isSaving = savingName === row.name;
                return (
                  <div key={row.name} className="flex items-center gap-3 px-4 py-3">
                    {row.kind === "pipe" && <Zap size={13} className="text-visiyon-accent shrink-0" />}
                    {row.kind === "provider" && <Plug size={13} className="text-visiyon-text-3 shrink-0" />}

                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(row);
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-full text-[13.5px] bg-transparent border border-visiyon-border rounded-[6px] px-2.5 py-1.5 outline-none focus:border-visiyon-text"
                        />
                      ) : (
                        <>
                          <div className={`text-[13.5px] truncate ${isHidden ? "text-visiyon-text-3" : ""}`}>
                            {row.override?.displayName || row.rawLabel}
                          </div>
                          <div className="text-[11px] text-visiyon-text-3 truncate font-mono">{row.name}</div>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {isEditing ? (
                        <button
                          onClick={() => saveEdit(row)}
                          disabled={isSaving}
                          className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-2 disabled:opacity-40"
                          title="Save"
                        >
                          <Check size={14} />
                        </button>
                      ) : (
                        <button
                          onClick={() => startEdit(row)}
                          disabled={isSaving}
                          className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                          title="Rename"
                        >
                          <Pencil size={14} />
                        </button>
                      )}

                      {row.override?.displayName && !isEditing && (
                        <button
                          onClick={() => resetName(row)}
                          disabled={isSaving}
                          className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                          title="Reset to original name"
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}

                      <button
                        onClick={() => toggleHidden(row)}
                        disabled={isSaving}
                        className={`p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] disabled:opacity-40 ${
                          isHidden ? "text-visiyon-text-3" : "text-visiyon-text-2"
                        }`}
                        title={isHidden ? "Make visible to users" : "Hide from users"}
                      >
                        {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>

                      <button
                        onClick={() => setParamsRow(row)}
                        disabled={isSaving}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                        title="Model Params (system prompt, generation parameters, default features)"
                      >
                        <Settings size={14} />
                      </button>

                      {row.kind === "ollama" && (
                        <button
                          onClick={() => handleDeleteOllamaModel(row)}
                          disabled={deletingName === row.name}
                          className="p-1.5 rounded-[6px] hover:bg-red-500/10 text-visiyon-text-3 hover:text-red-400 disabled:opacity-40"
                          title="Delete from Ollama (removes the model file)"
                        >
                          {deletingName === row.name ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {paramsRow && (
        <ModelParamsModal
          modelName={paramsRow.name}
          rawLabel={paramsRow.override?.displayName || paramsRow.rawLabel}
          setting={paramsRow.override}
          onClose={() => setParamsRow(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
