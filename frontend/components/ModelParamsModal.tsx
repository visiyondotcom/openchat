"use client";

import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { adminSetModelSetting, ModelSetting, ModelParams, ModelDefaultFeatures, listAllTools, Tool } from "@/lib/api";

// Ollama-style range slider with a live numeric readout, used for the GPU
// Layers / CPU Threads knobs in Advanced Params — same interaction as Open
// WebUI's per-model advanced sliders (drag to set, "Default" when unset).
function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  defaultLabel,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min: number;
  max: number;
  step?: number;
  defaultLabel: string;
}) {
  const isSet = value !== undefined;
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={isSet ? value : min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-visiyon-text h-1"
      />
      <span className="text-[11.5px] text-visiyon-text-3 w-16 text-right font-mono shrink-0">
        {isSet ? value : defaultLabel}
      </span>
      {isSet && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title="Reset to default"
          className="text-visiyon-text-3 hover:text-visiyon-text transition-colors text-[11px] shrink-0"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// Same toggle switch used in Admin > Settings — kept local here rather
// than a shared import since this is the only other place it's needed.
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${on ? "bg-visiyon-accent" : "bg-visiyon-text/15"}`}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform ${
          on ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
        }`}
      />
    </button>
  );
}

// Flat black modal, 6px corner radius — same convention as the other
// modals (e.g. BuyCreditsModal). Opened via the gear icon on an
// admin/models row.
export default function ModelParamsModal({
  modelName,
  rawLabel,
  setting,
  onClose,
  onSaved,
}: {
  modelName: string;
  rawLabel: string;
  setting?: ModelSetting;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"prompt" | "params" | "features" | "tools">("prompt");
  const [hidden, setHidden] = useState(setting?.hidden ?? false);
  const [systemPrompt, setSystemPrompt] = useState(setting?.systemPrompt ?? "");
  const [params, setParams] = useState<ModelParams>(setting?.params ?? {});
  const [features, setFeatures] = useState<ModelDefaultFeatures>(setting?.defaultFeatures ?? {});
  const [toolIds, setToolIds] = useState<string[]>(setting?.defaultToolIds ?? []);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [toolsError, setToolsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Loaded lazily (only once the Tools tab is opened) since it's an extra
  // request most admins won't need on every open of this modal.
  useEffect(() => {
    if (tab !== "tools" || tools !== null) return;
    listAllTools()
      .then(setTools)
      .catch(() => setToolsError(true));
  }, [tab, tools]);

  function toggleTool(id: string) {
    setToolIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  function setParam<K extends keyof ModelParams>(key: K, raw: string) {
    setParams((p) => {
      const next = { ...p };
      if (raw.trim() === "") {
        delete next[key];
        return next;
      }
      if (key === "stop") {
        next.stop = raw;
      } else {
        const n = Number(raw);
        if (!Number.isNaN(n)) (next as any)[key] = n;
      }
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await adminSetModelSetting(modelName, {
        hidden,
        systemPrompt: systemPrompt.trim() === "" ? null : systemPrompt,
        params: Object.keys(params).length === 0 ? null : params,
        defaultFeatures: Object.keys(features).length === 0 ? null : features,
        defaultToolIds: toolIds.length === 0 ? null : toolIds,
      });
      onSaved();
      onClose();
    } catch {
      setError("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  const paramFields: { key: keyof ModelParams; label: string; placeholder: string; type?: string }[] = [
    { key: "temperature", label: "Temperature", placeholder: "Default (0.7)" },
    { key: "top_p", label: "Top P", placeholder: "Default (0.9)" },
    { key: "num_ctx", label: "Context length (num_ctx)", placeholder: "Default (4096)" },
    { key: "max_tokens", label: "Max tokens", placeholder: "Default" },
    { key: "seed", label: "Seed", placeholder: "Default (random)" },
    { key: "stop", label: "Stop sequence", placeholder: "Default (none)", type: "text" },
  ];

  const featureFields: { key: keyof ModelDefaultFeatures; label: string }[] = [
    { key: "webSearch", label: "Web Search" },
    { key: "imageGeneration", label: "Image Generation" },
    { key: "codeInterpreter", label: "Code Interpreter" },
  ];

  // chatControlsEnabled is unset -> "on" by default (see ModelDefaultFeatures),
  // so the toggle needs to read true unless explicitly set to false.
  const chatControlsOn = features.chatControlsEnabled !== false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-visiyon-bg border border-visiyon-border rounded-[6px] p-5 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between shrink-0">
          <div>
            <h2 className="text-[15px] font-medium text-visiyon-text">Model Params</h2>
            <p className="text-[11.5px] text-visiyon-text-3 font-mono mt-0.5">{modelName}</p>
          </div>
          <button onClick={onClose} className="text-visiyon-text-3 hover:text-visiyon-text transition-colors" title="Close">
            <X size={16} />
          </button>
        </div>

        <label className="flex items-center justify-between mt-4 px-3 py-2.5 rounded-lg border border-visiyon-border shrink-0">
          <span className="text-[13px]">Hide from users (not visible in the model picker)</span>
          <Toggle on={hidden} onClick={() => setHidden(!hidden)} />
        </label>

        <div className="flex items-center gap-1 mt-4 border-b border-visiyon-border shrink-0">
          {(
            [
              ["prompt", "System Prompt"],
              ["params", "Advanced Params"],
              ["features", "Default Features"],
              ["tools", "Tools"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`text-[12.5px] px-3 py-2 -mb-px border-b-2 transition-colors ${
                tab === id
                  ? "border-visiyon-text text-visiyon-text"
                  : "border-transparent text-visiyon-text-3 hover:text-visiyon-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-y-auto flex-1 min-h-[220px]">
          {tab === "prompt" && (
            <div>
              <p className="text-[12px] text-visiyon-text-3 mb-2">
                Used as the system prompt for every new chat on {rawLabel}, unless the chat
                itself (via Prompt Library or manually) already has one.
              </p>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={12}
                placeholder="E.g. You are the AI model of Visiyon AI, a helpful assistant..."
                className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-lg px-3 py-2.5 outline-none focus:border-visiyon-text font-mono resize-y"
              />
            </div>
          )}

          {tab === "params" && (
            <div>
              <p className="text-[12px] text-visiyon-text-3 mb-3">
                Default generation parameters for this model. Leave blank for the Ollama default. A
                user or per-message setting still overrides this value.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {paramFields.map((f) => (
                  <div key={f.key}>
                    <label className="text-[11.5px] text-visiyon-text-3 block mb-1">{f.label}</label>
                    <input
                      type={f.type ?? "number"}
                      step="any"
                      value={(params[f.key] as string | number | undefined) ?? ""}
                      onChange={(e) => setParam(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-lg px-2.5 py-1.5 outline-none focus:border-visiyon-text"
                    />
                  </div>
                ))}
              </div>

              <div className="mt-5 pt-4 border-t border-visiyon-border">
                <p className="text-[11.5px] text-visiyon-text-3 mb-3">
                  Hardware offload (Ollama only — has no effect on external providers).
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="text-[11.5px] text-visiyon-text-3 block mb-1.5">
                      GPU / NPU Layers (num_gpu)
                    </label>
                    <Slider
                      value={params.num_gpu}
                      onChange={(v) => setParams((p) => ({ ...p, num_gpu: v }))}
                      min={0}
                      max={128}
                      defaultLabel="Auto"
                    />
                  </div>
                  <div>
                    <label className="text-[11.5px] text-visiyon-text-3 block mb-1.5">
                      CPU Threads (num_thread)
                    </label>
                    <Slider
                      value={params.num_thread}
                      onChange={(v) => setParams((p) => ({ ...p, num_thread: v }))}
                      min={1}
                      max={64}
                      defaultLabel="Auto"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "features" && (
            <div>
              <p className="text-[12px] text-visiyon-text-3 mb-3">
                Which toggles are on by default for a new chat on {rawLabel}.
              </p>
              <div className="space-y-1">
                {featureFields.map((f) => (
                  <div
                    key={f.key}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-visiyon-text/[0.04]"
                  >
                    <span className="text-[13px]">{f.label}</span>
                    <Toggle
                      on={!!features[f.key]}
                      onClick={() => setFeatures((prev) => ({ ...prev, [f.key]: !prev[f.key] }))}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-visiyon-border flex items-center justify-between px-3 py-2.5 rounded-lg">
                <div>
                  <span className="text-[13px]">Chat Controls</span>
                  <p className="text-[11.5px] text-visiyon-text-3 mt-0.5">
                    Let users open the Chat Controls panel and tweak temperature, context
                    length, max tokens, etc. per chat. Off = users always get this model's
                    configured defaults.
                  </p>
                </div>
                <Toggle
                  on={chatControlsOn}
                  onClick={() => setFeatures((prev) => ({ ...prev, chatControlsEnabled: !chatControlsOn }))}
                />
              </div>
            </div>
          )}

          {tab === "tools" && (
            <div>
              <p className="text-[12px] text-visiyon-text-3 mb-3">
                Tools automatically attached to every new chat on {rawLabel}, on top of any tool
                the user attaches themselves. Built-in tools that are already always-on don't need
                to be picked here.
              </p>
              {toolsError && (
                <p className="text-[12px] text-red-400">Couldn't load tools — please try again.</p>
              )}
              {!toolsError && tools === null && (
                <p className="text-[12px] text-visiyon-text-3">Loading tools…</p>
              )}
              {!toolsError && tools !== null && tools.length === 0 && (
                <p className="text-[12px] text-visiyon-text-3">No tools configured yet.</p>
              )}
              {!toolsError && tools !== null && tools.length > 0 && (
                <div className="space-y-1">
                  {tools.map((t) => {
                    // MCP-discovered tools are named "mcp:<server>:<tool>" —
                    // show the server as a prefix badge and just the tool's
                    // own name as the label, instead of the raw dotted string.
                    const mcpMatch = t.type === "MCP" ? t.name.match(/^mcp:([^:]+):(.+)$/) : null;
                    const displayName = mcpMatch ? mcpMatch[2] : t.name;
                    const mcpServer = mcpMatch ? mcpMatch[1] : null;
                    return (
                      <div
                        key={t.id}
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-visiyon-text/[0.04]"
                      >
                        <div className="min-w-0 pr-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] truncate">{displayName}</span>
                            <span className="text-[10px] uppercase tracking-wide text-visiyon-text-3 border border-visiyon-border rounded px-1 py-px shrink-0">
                              {mcpServer ? `MCP · ${mcpServer}` : t.type}
                            </span>
                            {!t.enabled && (
                              <span className="text-[10px] text-visiyon-text-3 shrink-0">(disabled)</span>
                            )}
                          </div>
                          <p className="text-[11.5px] text-visiyon-text-3 truncate">{t.description}</p>
                        </div>
                        <Toggle on={toolIds.includes(t.id)} onClick={() => toggleTool(t.id)} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {error && <div className="mt-3 text-[12px] text-red-400 shrink-0">{error}</div>}

        <div className="mt-4 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="text-[12.5px] px-3 py-1.5 rounded-[6px] text-visiyon-text-2 hover:text-visiyon-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-[12.5px] font-medium px-3.5 py-1.5 rounded-[6px] bg-white text-black hover:bg-visiyon-text/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
