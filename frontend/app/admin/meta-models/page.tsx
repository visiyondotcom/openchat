"use client";

import { askConfirm } from "@/components/PromptDialog";
import Select from "@/components/Select";
import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import {
  listMetaModels,
  createMetaModel,
  updateMetaModel,
  deleteMetaModel,
  listProviders,
  listModels,
  MetaModel,
  MetaModelCandidateInput,
  MetaModelCandidateKind,
  AiProvider,
} from "@/lib/api";
import { Plus, Trash2, Power, Blend, GripVertical } from "lucide-react";

// A candidate row while it's being edited — same shape as
// MetaModelCandidateInput, plus a client-only `key` so React can track
// rows across reorders/deletes without needing a saved id yet.
interface CandidateDraft {
  key: string;
  kind: MetaModelCandidateKind;
  enabled: boolean;
  ollamaModel: string;
  providerId: string;
  providerModel: string;
}

function emptyCandidate(): CandidateDraft {
  return {
    key: Math.random().toString(36).slice(2),
    kind: "ollama",
    enabled: true,
    ollamaModel: "",
    providerId: "",
    providerModel: "",
  };
}

function draftsToInput(drafts: CandidateDraft[]): MetaModelCandidateInput[] {
  return drafts.map((d, i) => ({
    order: i,
    enabled: d.enabled,
    kind: d.kind,
    ollamaModel: d.kind === "ollama" ? d.ollamaModel : undefined,
    providerId: d.kind === "provider" ? d.providerId : undefined,
    providerModel: d.kind === "provider" ? d.providerModel : undefined,
  }));
}

function metaToDrafts(meta: MetaModel): CandidateDraft[] {
  return meta.candidates.map((c) => ({
    key: c.id,
    kind: c.kind,
    enabled: c.enabled,
    ollamaModel: c.ollamaModel ?? "",
    providerId: c.providerId ?? "",
    providerModel: c.providerModel ?? "",
  }));
}

// This is the "Jean"/Blender-style config screen: pick several real models
// (your own GPU(s) via Ollama, and/or external providers like an NVIDIA
// endpoint, OpenAI, Anthropic, ...), and every chat message on this
// meta-model races all of them for the first token. Whichever answers
// first wins and the others are cancelled; if one is unreachable or errors
// the next candidate just takes over — invisible to the person chatting,
// who only ever sees one model, "Jean", answer.
export default function AdminMetaModelsPage() {
  const ready = useRequireAdmin();
  const [metaModels, setMetaModels] = useState<MetaModel[] | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  // Editor form state
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [hedgeDelayMs, setHedgeDelayMs] = useState(800);
  const [candidates, setCandidates] = useState<CandidateDraft[]>([emptyCandidate()]);

  async function refresh() {
    try {
      const [{ metaModels }, { providers }, models] = await Promise.all([
        listMetaModels(),
        listProviders(),
        listModels(),
      ]);
      setMetaModels(metaModels);
      setProviders(providers);
      // Plain Ollama tags only — filter out the "provider:", "meta:" and
      // "pipe:" entries GET /models also returns, since those aren't
      // things you'd pick as a raw-GPU candidate here.
      setOllamaModels(
        models
          .filter((m) => !m.name.startsWith("provider:") && !m.name.startsWith("meta:") && !m.name.startsWith("pipe:"))
          .map((m) => m.name)
      );
    } catch {
      setError("Could not reach the server — the database migration may still need to run.");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function startCreate() {
    setEditingId("new");
    setSlug("");
    setDisplayName("");
    setDescription("");
    setHedgeDelayMs(800);
    setCandidates([emptyCandidate()]);
  }

  function startEdit(meta: MetaModel) {
    setEditingId(meta.id);
    setSlug(meta.slug);
    setDisplayName(meta.displayName);
    setDescription(meta.description ?? "");
    setHedgeDelayMs(meta.hedgeDelayMs);
    setCandidates(metaToDrafts(meta));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function updateCandidate(key: string, patch: Partial<CandidateDraft>) {
    setCandidates((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeCandidate(key: string) {
    setCandidates((rows) => rows.filter((r) => r.key !== key));
  }

  function moveCandidate(key: string, dir: -1 | 1) {
    setCandidates((rows) => {
      const i = rows.findIndex((r) => r.key === key);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= rows.length) return rows;
      const next = [...rows];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function validate(): string | null {
    if (!slug.trim()) return "Slug is required";
    if (!/^[a-z0-9-]+$/.test(slug.trim())) return "Slug may only contain lowercase letters, numbers and hyphens";
    if (!displayName.trim()) return "Display name is required";
    if (candidates.length === 0) return "Add at least one candidate";
    for (const c of candidates) {
      if (c.kind === "ollama" && !c.ollamaModel.trim()) return "Every Ollama candidate needs a model";
      if (c.kind === "provider" && (!c.providerId || !c.providerModel.trim())) {
        return "Every provider candidate needs a provider and a model";
      }
    }
    return null;
  }

  async function handleSave() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        slug: slug.trim(),
        displayName: displayName.trim(),
        description: description.trim() || null,
        hedgeDelayMs,
        candidates: draftsToInput(candidates),
      };
      if (editingId === "new") {
        await createMetaModel(payload);
      } else if (editingId) {
        await updateMetaModel(editingId, payload);
      }
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save meta-model");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(meta: MetaModel) {
    await updateMetaModel(meta.id, { enabled: !meta.enabled });
    await refresh();
  }

  async function handleDelete(meta: MetaModel) {
    if (
      !(await askConfirm({
        title: `Remove meta-model "${meta.displayName}"? Chats using it will no longer be able to complete.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    await deleteMetaModel(meta.id);
    await refresh();
  }

  function candidateLabel(c: MetaModel["candidates"][number]): string {
    if (c.kind === "ollama") return `Own GPU · ${c.ollamaModel}`;
    return `${c.providerName ?? "Provider"} · ${c.providerModel}`;
  }

  if (!ready) return null;

  const providerOptions = providers
    .filter((p) => p.enabled)
    .map((p) => ({ value: p.id, label: p.name }));

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-6 sm:py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-xl sm:text-2xl font-semibold">Admin dashboard</h1>
        </div>

        <div className="max-w-3xl pb-24">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-1">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Blend size={17} /> Meta-Models
            </h2>
            {editingId === null && (
              <button
                onClick={startCreate}
                className="flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black hover:opacity-90 transition-opacity w-full sm:w-auto"
              >
                <Plus size={14} /> Add meta-model
              </button>
            )}
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Bundle several real models — your own GPU(s) via Ollama, and/or external providers
            such as an NVIDIA endpoint, OpenAI, or Anthropic — behind one name. Every message
            races all enabled candidates for the first token: whichever answers fastest wins and
            the rest are cancelled, and a candidate that&apos;s slow, unreachable, or errors is
            skipped in favor of the next one. Completely invisible to whoever&apos;s chatting.
          </p>

          {error && (
            <div className="mb-5 text-[12.5px] border border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-200 rounded-[6px] px-3.5 py-2.5">
              {error}
            </div>
          )}

          {editingId !== null && (
            <div className="border border-visiyon-border rounded-[6px] p-3 sm:p-4 mb-6 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder='Slug (e.g. "jean")'
                  disabled={editingId !== "new"}
                  className="w-full min-w-0 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono disabled:opacity-50"
                />
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder='Display name (e.g. "Jean")'
                  className="w-full min-w-0 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                />
              </div>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description shown in the model picker (optional)"
                className="w-full min-w-0 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <label className="text-[12.5px] text-visiyon-text-2 shrink-0">
                  Hedge delay between candidates
                </label>
                <input
                  type="number"
                  min={0}
                  max={30000}
                  step={100}
                  value={hedgeDelayMs}
                  onChange={(e) => setHedgeDelayMs(Math.max(0, Number(e.target.value) || 0))}
                  className="w-24 sm:w-28 text-[13px] bg-transparent text-visiyon-text border border-visiyon-border rounded-[6px] px-3 py-1.5 outline-none focus:border-visiyon-text font-mono"
                />
                <span className="text-[11.5px] text-visiyon-text-3">ms</span>
              </div>
              <p className="text-[11.5px] text-visiyon-text-3 -mt-1.5">
                The first candidate starts immediately. If it hasn&apos;t produced a first token
                within this many ms, the next candidate also starts (racing alongside it) — and
                so on down the list. Lower = switches to a backup sooner; 0 = start every
                candidate at once.
              </p>

              <div className="pt-2 space-y-2">
                <div className="text-[12.5px] font-medium text-visiyon-text-2">Candidates</div>
                {candidates.map((c, i) => (
                  <div key={c.key} className="border border-visiyon-border rounded-[6px] p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <GripVertical size={13} className="text-visiyon-text-3 shrink-0" />
                      <span className="text-[11px] text-visiyon-text-3 w-4 shrink-0">{i + 1}</span>
                      <Select
                        value={c.kind}
                        onChange={(v) => updateCandidate(c.key, { kind: v as MetaModelCandidateKind })}
                        options={[
                          { value: "ollama", label: "Own GPU (Ollama)" },
                          { value: "provider", label: "External provider" },
                        ]}
                        className="flex-1 min-w-[140px]"
                      />
                      <div className="flex items-center gap-1 shrink-0 ml-auto">
                        <button
                          onClick={() => updateCandidate(c.key, { enabled: !c.enabled })}
                          className={`p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] shrink-0 ${
                            c.enabled ? "text-visiyon-text-2" : "text-visiyon-text-3"
                          }`}
                          title={c.enabled ? "Disable this candidate" : "Enable this candidate"}
                        >
                          <Power size={13} />
                        </button>
                        <button
                          onClick={() => moveCandidate(c.key, -1)}
                          disabled={i === 0}
                          className="text-[11px] px-1.5 py-1 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 disabled:opacity-30 shrink-0"
                          title="Move up (joins the race sooner)"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => moveCandidate(c.key, 1)}
                          disabled={i === candidates.length - 1}
                          className="text-[11px] px-1.5 py-1 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 disabled:opacity-30 shrink-0"
                          title="Move down (joins the race later)"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => removeCandidate(c.key)}
                          className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-red-400 shrink-0"
                          title="Remove"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {c.kind === "ollama" ? (
                      ollamaModels.length > 0 ? (
                        <Select
                          value={c.ollamaModel}
                          onChange={(v) => updateCandidate(c.key, { ollamaModel: v })}
                          options={ollamaModels.map((m) => ({ value: m, label: m }))}
                          placeholder="Pick a pulled Ollama model…"
                          className="w-full"
                        />
                      ) : (
                        <input
                          value={c.ollamaModel}
                          onChange={(e) => updateCandidate(c.key, { ollamaModel: e.target.value })}
                          placeholder='Ollama model tag (e.g. "jean:4b")'
                          className="w-full min-w-0 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                        />
                      )
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Select
                          value={c.providerId}
                          onChange={(v) => updateCandidate(c.key, { providerId: v, providerModel: "" })}
                          options={providerOptions}
                          placeholder="Pick a provider…"
                        />
                        {(() => {
                          const provider = providers.find((p) => p.id === c.providerId);
                          return provider && provider.models.length > 0 ? (
                            <Select
                              value={c.providerModel}
                              onChange={(v) => updateCandidate(c.key, { providerModel: v })}
                              options={provider.models.map((m) => ({ value: m, label: m }))}
                              placeholder="Pick a model…"
                            />
                          ) : (
                            <input
                              value={c.providerModel}
                              onChange={(e) => updateCandidate(c.key, { providerModel: e.target.value })}
                              placeholder="Model name at that provider"
                              className="w-full min-w-0 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                            />
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))}

                <button
                  onClick={() => setCandidates((rows) => [...rows, emptyCandidate()])}
                  className="w-full flex items-center justify-center gap-1.5 text-[12.5px] py-2 rounded-[6px] border border-dashed border-visiyon-border text-visiyon-text-3 hover:text-visiyon-text hover:border-visiyon-text-3 transition-colors"
                >
                  <Plus size={13} /> Add candidate
                </button>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 text-[13px] font-medium py-1.5 rounded-[6px] bg-white text-black disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={cancelEdit}
                  className="text-[13px] px-3 py-1.5 rounded-[6px] border border-visiyon-border text-visiyon-text-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!metaModels ? (
            <p className="text-sm text-visiyon-text-3">Loading…</p>
          ) : metaModels.length === 0 ? (
            editingId === null && <p className="text-sm text-visiyon-text-3">No meta-models configured yet.</p>
          ) : (
            (() => {
              // While an existing meta-model is open in the editor above, its
              // read-only summary row below used to still render alongside
              // it — same entry twice on screen at once. Hide just that one
              // row for the duration of the edit; every other row (and the
              // "no meta-models yet" message when the list would otherwise
              // be empty) is unaffected.
              const visibleModels = metaModels.filter((m) => m.id !== editingId);
              return visibleModels.length === 0 ? null : (
                <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
                  {visibleModels.map((m) => (
                <div key={m.id} className="px-3 sm:px-4 py-3.5">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
                        <span className={m.enabled ? "" : "text-visiyon-text-3"}>{m.displayName}</span>
                        <span className="text-[11px] text-visiyon-text-3 border border-visiyon-border rounded-full px-2 py-0.5 font-mono">
                          meta:{m.slug}
                        </span>
                        <span className="text-[11px] text-visiyon-text-3">
                          {m.hedgeDelayMs}ms hedge
                        </span>
                      </div>
                      {m.description && (
                        <div className="text-[11.5px] text-visiyon-text-3 mt-0.5">{m.description}</div>
                      )}
                      <div className="text-[11.5px] text-visiyon-text-3 mt-1 break-words">
                        {m.candidates
                          .slice()
                          .sort((a, b) => a.order - b.order)
                          .map((c, i) => `${i + 1}. ${candidateLabel(c)}${c.enabled ? "" : " (disabled)"}`)
                          .join("  →  ")}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 self-start sm:self-auto">
                      <button
                        onClick={() => startEdit(m)}
                        className="text-[12.5px] px-2.5 py-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-2"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggle(m)}
                        className={`p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] ${
                          m.enabled ? "text-visiyon-text-2" : "text-visiyon-text-3"
                        }`}
                        title={m.enabled ? "Disable" : "Enable"}
                      >
                        <Power size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(m)}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
                </div>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
}
