"use client";

import { askConfirm } from "@/components/PromptDialog";
import Select from "@/components/Select";
import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  adminListModelSettings,
  adminSetModelSetting,
  adminDeleteModelSetting,
  adminBulkSetModelHidden,
  AiProvider,
  AiProviderType,
  ModelSetting,
} from "@/lib/api";
import {
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Power,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Pencil,
  Check,
  RotateCcw,
} from "lucide-react";

const TYPE_LABELS: Record<AiProviderType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  openai_compatible: "OpenAI-compatible (custom)",
};

// Any OpenAI/Anthropic-compatible service can be plugged in this way —
// Groq, Mistral, OpenRouter, Azure OpenAI, together.ai, a local
// vLLM/LM Studio server, etc. — by picking "OpenAI-compatible" and
// pointing baseUrl at its endpoint.
export default function AdminProvidersPage() {
  const ready = useRequireAdmin();
  const [providers, setProviders] = useState<AiProvider[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-model hide/rename overrides (ModelSetting), keyed by name
  // ("provider:<providerId>:<model>") — same mechanism as Admin > Models,
  // shown here inline so a model can be hidden/renamed right where it's
  // configured instead of hunting for it in the full model list.
  const [settings, setSettings] = useState<Map<string, ModelSetting>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [savingModel, setSavingModel] = useState<string | null>(null);

  // New-provider form state (also reused for editing an existing provider —
  // editingProviderId set means Save calls updateProvider instead of createProvider)
  const [name, setName] = useState("");
  const [type, setType] = useState<AiProviderType>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);

  async function refresh() {
    try {
      const [{ providers }, { settings }] = await Promise.all([listProviders(), adminListModelSettings()]);
      setProviders(providers);
      setSettings(new Map(settings.map((s) => [s.name, s])));
    } catch {
      setError("Could not reach the server — the database migration may still need to run.");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const [editingApiKeyPreview, setEditingApiKeyPreview] = useState<string | null>(null);

  function resetForm() {
    setName("");
    setType("openai");
    setBaseUrl("");
    setApiKey("");
    setModelsText("");
    setCreating(false);
    setEditingProviderId(null);
    setEditingApiKeyPreview(null);
  }

  function startEditProvider(p: AiProvider) {
    setName(p.name);
    setType(p.type);
    setBaseUrl(p.baseUrl ?? "");
    setApiKey("");
    setModelsText(p.models.join(", "));
    setEditingProviderId(p.id);
    setEditingApiKeyPreview(p.apiKeyPreview);
    setCreating(true);
  }

  async function handleCreate() {
    if (!name.trim() || (!editingProviderId && !apiKey.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const models = modelsText
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      if (editingProviderId) {
        await updateProvider(editingProviderId, {
          name: name.trim(),
          type,
          baseUrl: baseUrl.trim() || null,
          // Omit apiKey entirely when left blank — keeps the stored key.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          models,
        });
      } else {
        await createProvider({
          name: name.trim(),
          type,
          baseUrl: baseUrl.trim() || null,
          apiKey: apiKey.trim(),
          models,
        });
      }
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(p: AiProvider) {
    await updateProvider(p.id, { enabled: !p.enabled });
    await refresh();
  }

  async function handleTest(p: AiProvider) {
    setTesting(p.id);
    setError(null);
    try {
      const result = await testProvider(p.id);
      if (result.note) setError(result.note);
      await refresh();
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(p: AiProvider) {
    if (
      !(await askConfirm({
        title: `Remove provider "${p.name}"? Chats using its models will no longer be able to complete.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    await deleteProvider(p.id);
    await refresh();
  }

  function toggleExpanded(providerId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }

  async function toggleModelHidden(settingName: string) {
    setSavingModel(settingName);
    try {
      const current = settings.get(settingName);
      await adminSetModelSetting(settingName, {
        displayName: current?.displayName ?? undefined,
        hidden: !(current?.hidden ?? false),
      });
      await refresh();
    } catch {
      setError("Could not update that model");
    } finally {
      setSavingModel(null);
    }
  }

  // Hide/unhide every model in a provider's bundle in one go (e.g. all 95
  // models of gpt-oss-120b) — one bulk request instead of 95 parallel ones.
  async function bulkSetHidden(p: AiProvider, hidden: boolean) {
    const bulkKey = `__bulk__${p.id}`;
    setSavingModel(bulkKey);
    try {
      const names = p.models.map((modelName) => `provider:${p.id}:${modelName}`);
      await adminBulkSetModelHidden(names, hidden);
      await refresh();
    } catch {
      setError("Could not update all models in this bundle");
    } finally {
      setSavingModel(null);
    }
  }

  function bundleIsFullyHidden(p: AiProvider) {
    if (p.models.length === 0) return false;
    return p.models.every((modelName) => settings.get(`provider:${p.id}:${modelName}`)?.hidden ?? false);
  }

  function startEditModel(settingName: string, rawLabel: string) {
    setEditingModel(settingName);
    setModelDraft(settings.get(settingName)?.displayName ?? rawLabel);
  }

  async function saveEditModel(settingName: string, rawLabel: string) {
    const trimmed = modelDraft.trim();
    setSavingModel(settingName);
    try {
      const current = settings.get(settingName);
      if (!trimmed || trimmed === rawLabel) {
        if (current) await adminDeleteModelSetting(settingName);
      } else {
        await adminSetModelSetting(settingName, { displayName: trimmed });
      }
      await refresh();
      setEditingModel(null);
    } catch {
      setError("Could not rename that model");
    } finally {
      setSavingModel(null);
    }
  }

  async function resetModelName(settingName: string) {
    const current = settings.get(settingName);
    if (!current) return;
    setSavingModel(settingName);
    try {
      if (current.hidden) {
        await adminSetModelSetting(settingName, { displayName: null, hidden: true });
      } else {
        await adminDeleteModelSetting(settingName);
      }
      await refresh();
    } catch {
      setError("Could not reset that model's name");
    } finally {
      setSavingModel(null);
    }
  }

  // Extracted so the exact same form can render either at the top (for
  // "Add provider") or inline inside a specific row (for editing that
  // row) — see the two call sites below. Editing used to always pop the
  // form up to the very top of the page regardless of which row's Edit
  // button was clicked, which was disorienting on a long provider list.
  function renderProviderForm() {
    return (
      <div className="border border-visiyon-border rounded-[6px] p-4 mb-6 space-y-2.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={'Name (e.g. "OpenAI production")'}
          className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
        />
        <Select
          value={type}
          onChange={(v) => setType(v as AiProviderType)}
          options={(Object.keys(TYPE_LABELS) as AiProviderType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
          className="w-full"
        />
        {type === "openai_compatible" && (
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL (e.g. https://api.groq.com/openai/v1)"
            className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
          />
        )}
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
          placeholder={editingApiKeyPreview ?? "API key"}
          className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
        />
        <input
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder="Model names, comma-separated (e.g. gpt-4o, gpt-4o-mini) — or leave blank and use Test to auto-fill"
          className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
        />
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim() || (!editingProviderId && !apiKey.trim())}
            className="flex-1 text-[13px] font-medium py-1.5 rounded-[6px] bg-white text-black disabled:opacity-50"
          >
            {saving ? "Saving…" : editingProviderId ? "Save changes" : "Save"}
          </button>
          <button
            onClick={resetForm}
            className="text-[13px] px-3 py-1.5 rounded-[6px] border border-visiyon-border text-visiyon-text-2"
          >
            Cancel
          </button>
        </div>
      </div>
    );
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
            <h2 className="text-lg font-semibold">AI Providers</h2>
            {!creating && (
              <button
                onClick={() => setCreating(true)}
                className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black hover:opacity-90 transition-opacity"
              >
                <Plus size={14} /> Add provider
              </button>
            )}
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Connect OpenAI, Anthropic/Claude, or any OpenAI-compatible endpoint (Groq, Mistral,
            OpenRouter, Azure OpenAI, a local vLLM/LM Studio server, ...). Enabled models show up
            in the model picker alongside your local Ollama models.
          </p>

          {error && (
            <div className="mb-5 text-[12.5px] border border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-200 rounded-[6px] px-3.5 py-2.5">
              {error}
            </div>
          )}

          {creating && !editingProviderId && renderProviderForm()}

          {!providers ? (
            <p className="text-sm text-visiyon-text-3">Loading…</p>
          ) : providers.length === 0 ? (
            <p className="text-sm text-visiyon-text-3">No providers configured yet.</p>
          ) : (
            <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border overflow-hidden">
              {providers.map((p) =>
                creating && editingProviderId === p.id ? (
                  <div key={p.id} className="px-4 py-3.5">
                    {renderProviderForm()}
                  </div>
                ) : (
                <div key={p.id} className="px-4 py-3.5 overflow-hidden">
                  <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap overflow-hidden">
                    <div className="flex-1 min-w-0 basis-full sm:basis-auto overflow-hidden">
                      <div className="flex items-center gap-2 text-[13.5px] flex-wrap">
                        <span className={p.enabled ? "" : "text-visiyon-text-3"}>{p.name}</span>
                        <span className="text-[11px] text-visiyon-text-3 border border-visiyon-border rounded-full px-2 py-0.5">
                          {TYPE_LABELS[p.type]}
                        </span>
                        {p.lastTestError ? (
                          <AlertCircle size={13} className="text-red-400 shrink-0" />
                        ) : p.lastTestedAt ? (
                          <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                        ) : null}
                      </div>
                      <div className="text-[11px] text-visiyon-text-3 font-mono mt-0.5">
                        {p.apiKeyPreview}
                        {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                      </div>
                      {p.models.length > 0 && (
                        <button
                          onClick={() => toggleExpanded(p.id)}
                          className="flex items-center gap-1 text-[11.5px] text-visiyon-text-3 hover:text-visiyon-text mt-1 min-w-0 w-full"
                        >
                          {expanded.has(p.id) ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                          <span className="shrink-0">
                            {p.models.length} model{p.models.length === 1 ? "" : "s"}
                          </span>
                          {!expanded.has(p.id) && (
                            <span className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-visiyon-text-3">
                              — {p.models.join(", ")}
                            </span>
                          )}
                        </button>
                      )}
                      {p.lastTestError && (
                        <div className="text-[11.5px] text-red-400 mt-1">{p.lastTestError}</div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleTest(p)}
                        disabled={testing === p.id}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                        title="Test connection"
                      >
                        <RefreshCw size={14} className={testing === p.id ? "animate-spin" : ""} />
                      </button>
                      <button
                        onClick={() => startEditProvider(p)}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text"
                        title="Edit provider"
                      >
                        <Pencil size={14} />
                      </button>
                      {p.models.length > 0 && (
                        <button
                          onClick={() => bulkSetHidden(p, !bundleIsFullyHidden(p))}
                          disabled={savingModel === `__bulk__${p.id}`}
                          className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                          title={
                            bundleIsFullyHidden(p)
                              ? "Show all models from this bundle in the picker"
                              : "Hide all models from this bundle from the picker"
                          }
                        >
                          {bundleIsFullyHidden(p) ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                      <button
                        onClick={() => handleToggle(p)}
                        className={`p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] ${
                          p.enabled ? "text-visiyon-text-2" : "text-visiyon-text-3"
                        }`}
                        title={p.enabled ? "Disable" : "Enable"}
                      >
                        <Power size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {expanded.has(p.id) && p.models.length > 0 && (
                    <div className="mt-3 border border-visiyon-border rounded-[6px] overflow-hidden">
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-visiyon-text/[0.03] border-b border-visiyon-border flex-wrap">
                        <span className="text-[11px] text-visiyon-text-3">
                          {p.models.length} model{p.models.length === 1 ? "" : "s"} in this bundle
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => bulkSetHidden(p, true)}
                            disabled={savingModel === `__bulk__${p.id}`}
                            className="flex items-center gap-1 text-[11px] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                            title="Hide every model in this bundle from the picker"
                          >
                            <EyeOff size={12} /> Hide all
                          </button>
                          <button
                            onClick={() => bulkSetHidden(p, false)}
                            disabled={savingModel === `__bulk__${p.id}`}
                            className="flex items-center gap-1 text-[11px] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                            title="Show every model in this bundle in the picker"
                          >
                            <Eye size={12} /> Show all
                          </button>
                        </div>
                      </div>
                      <table className="w-full border-collapse text-[12.5px]">
                        <thead>
                          <tr className="bg-visiyon-text/[0.03] text-visiyon-text-3">
                            <th className="text-left font-medium px-3 py-1.5">Model</th>
                            <th className="w-[92px] px-3 py-1.5" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-visiyon-border">
                          {p.models.map((modelName) => {
                            const settingName = `provider:${p.id}:${modelName}`;
                            const setting = settings.get(settingName);
                            const hidden = setting?.hidden ?? false;
                            const label = setting?.displayName || modelName;
                            const isEditing = editingModel === settingName;
                            const isSaving = savingModel === settingName;
                            return (
                              <tr key={modelName} className="group">
                                <td className="px-3 py-1.5 min-w-0">
                                  {isEditing ? (
                                    <input
                                      autoFocus
                                      value={modelDraft}
                                      onChange={(e) => setModelDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveEditModel(settingName, modelName);
                                        if (e.key === "Escape") setEditingModel(null);
                                      }}
                                      className="w-full max-w-[420px] text-[12.5px] bg-transparent text-visiyon-text border border-visiyon-border rounded-[6px] px-2 py-1 outline-none focus:border-visiyon-text"
                                    />
                                  ) : (
                                    <div className="min-w-0">
                                      <div
                                        className={`truncate font-mono ${
                                          hidden ? "text-visiyon-text-3 line-through" : "text-visiyon-text-2"
                                        }`}
                                        title={modelName}
                                      >
                                        {label}
                                      </div>
                                      {setting?.displayName && (
                                        <div className="truncate text-[10.5px] text-visiyon-text-3 font-mono">
                                          {modelName}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center justify-end gap-1 shrink-0">
                                    {isEditing ? (
                                      <button
                                        onClick={() => saveEditModel(settingName, modelName)}
                                        disabled={isSaving}
                                        className="p-1 rounded-[6px] hover:bg-visiyon-text/[0.06] text-emerald-400 shrink-0"
                                        title="Save"
                                      >
                                        <Check size={13} />
                                      </button>
                                    ) : (
                                      <>
                                        {setting?.displayName && (
                                          <button
                                            onClick={() => resetModelName(settingName)}
                                            disabled={isSaving}
                                            className="p-1 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                                            title="Reset to original name"
                                          >
                                            <RotateCcw size={12} />
                                          </button>
                                        )}
                                        <button
                                          onClick={() => startEditModel(settingName, modelName)}
                                          disabled={isSaving}
                                          className="p-1 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                                          title="Rename"
                                        >
                                          <Pencil size={12} />
                                        </button>
                                        <button
                                          onClick={() => toggleModelHidden(settingName)}
                                          disabled={isSaving}
                                          className={`p-1 rounded-[6px] hover:bg-visiyon-text/[0.06] shrink-0 ${
                                            hidden ? "text-visiyon-text-3" : "text-visiyon-text-2"
                                          }`}
                                          title={hidden ? "Unhide — show in model picker" : "Hide from model picker"}
                                        >
                                          {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
