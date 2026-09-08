"use client";

import { useEffect, useRef, useState } from "react";
import { X, ChevronDown, ChevronUp, RotateCcw, Loader2, Check } from "lucide-react";
import { getChat, setChatParameters, type ChatControlsFields } from "@/lib/api";

// Per-chat, per-user overrides for the system prompt and every generation
// parameter Ollama exposes. Saved to the Chat row itself (see backend
// prisma/schema.prisma + routes/chats.ts) — scoped to this one conversation
// for this one user only. Every field starts out unset ("Default"), meaning
// "inherit the model's configured default".

type SliderField = {
  key: keyof ChatControlsFields;
  label: string;
  min: number;
  max: number;
  step: number;
  fallback: number; // the value the slider sits at while "Default" (display only)
};

// Bounded params get a real slider — mirrors Open WebUI's own Advanced
// Params UI, which uses range inputs for exactly this set.
const SLIDER_FIELDS: SliderField[] = [
  { key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.05, fallback: 0.7 },
  { key: "topP", label: "Top P", min: 0, max: 1, step: 0.05, fallback: 0.9 },
  { key: "minP", label: "Min P", min: 0, max: 1, step: 0.01, fallback: 0 },
  { key: "topK", label: "Top K", min: 0, max: 100, step: 1, fallback: 40 },
  { key: "frequencyPenalty", label: "Frequency Penalty", min: -2, max: 2, step: 0.1, fallback: 0 },
  { key: "mirostat", label: "Mirostat", min: 0, max: 2, step: 1, fallback: 0 },
  { key: "mirostatEta", label: "Mirostat Eta", min: 0, max: 1, step: 0.01, fallback: 0.1 },
  { key: "mirostatTau", label: "Mirostat Tau", min: 0, max: 10, step: 0.1, fallback: 5 },
  { key: "tfsZ", label: "Tfs Z", min: 0, max: 2, step: 0.1, fallback: 1 },
];

// Previously unbounded/free-form params — now sliders too, with a sensible
// range/step per field. An editable number box sits next to the slider for
// exact / out-of-range values (e.g. Context Length > 32768).
const NUMBER_SLIDER_FIELDS: SliderField[] = [
  { key: "seed", label: "Seed", min: 0, max: 1000, step: 1, fallback: 0 },
  { key: "repeatLastN", label: "Repeat Last N", min: -1, max: 256, step: 1, fallback: 64 },
  { key: "numCtx", label: "Context Length", min: 256, max: 32768, step: 256, fallback: 16384 },
  { key: "numBatch", label: "Batch Size (num_batch)", min: 1, max: 2048, step: 1, fallback: 512 },
  { key: "numKeep", label: "Tokens To Keep On Context Refresh (num_keep)", min: 0, max: 256, step: 1, fallback: 24 },
  { key: "numPredict", label: "Max Tokens (num_predict)", min: -1, max: 8192, step: 1, fallback: 8192 },
];

function SegmentedToggle({
  value,
  onChange,
}: {
  value: boolean | null | undefined;
  onChange: (v: boolean | null) => void;
}) {
  const options: { label: string; v: boolean | null }[] = [
    { label: "Default", v: null },
    { label: "On", v: true },
    { label: "Off", v: false },
  ];
  return (
    <div className="inline-flex rounded-md border border-visiyon-border overflow-hidden text-[11.5px] shrink-0">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 transition-colors ${
            value === o.v ? "bg-white text-black" : "bg-transparent text-visiyon-text-2 hover:bg-visiyon-text/10"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  field,
  value,
  onChange,
}: {
  field: SliderField;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  const isSet = value !== null && value !== undefined;
  const display = isSet ? value : field.fallback;
  const numRef = useRef<HTMLInputElement>(null);
  return (
    <div className="py-2.5 border-t border-visiyon-border">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[13px]">{field.label}</span>
        <div className="flex items-center gap-1.5">
          {/* Editable box for exact/out-of-range values (e.g. Context
              Length beyond the slider's usual max). Kept in sync with the
              slider via the same onChange. */}
          <input
            ref={numRef}
            type="number"
            onWheel={() => numRef.current?.blur()}
            value={display}
            onChange={(e) => onChange(e.target.value.trim() === "" ? null : Number(e.target.value))}
            className={`w-14 text-right bg-visiyon-panel2 border border-visiyon-border rounded-md px-1.5 py-0.5 text-[12px] tabular-nums focus:outline-none focus:ring-1 focus:ring-visiyon-text/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
              isSet ? "text-visiyon-text" : "text-visiyon-text-2"
            }`}
          />
          {isSet && (
            <button
              onClick={() => onChange(null)}
              className="text-visiyon-text-2 hover:text-visiyon-text"
              title="Reset to default"
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-visiyon-text bg-visiyon-text/15"
      />
    </div>
  );
}

export default function ChatControlsPanel({
  chatId,
  onClose,
  onSystemPromptChange,
}: {
  // Optional: on the homepage (no active chat yet) the panel still shows,
  // just with nothing to load/save until a chat exists.
  chatId?: string;
  onClose: () => void;
  // Keeps ChatWindow's own systemPrompt state (used by the Prompt Library
  // "active prompt" indicator) in sync when it's edited from here too.
  onSystemPromptChange?: (value: string | null) => void;
}) {
  const [fields, setFields] = useState<ChatControlsFields>({});
  const [loaded, setLoaded] = useState(false);
  const [promptOpen, setPromptOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    if (!chatId) {
      // No active chat yet (homepage) — nothing to load, show defaults.
      setFields({});
      setLoaded(true);
      return;
    }
    getChat(chatId).then((chat) => {
      if (cancelled) return;
      setFields({
        systemPrompt: chat.systemPrompt ?? null,
        streamResponse: chat.streamResponse ?? null,
        seed: chat.seed ?? null,
        stopSequence: chat.stopSequence ?? null,
        temperature: chat.temperature ?? null,
        mirostat: chat.mirostat ?? null,
        mirostatEta: chat.mirostatEta ?? null,
        mirostatTau: chat.mirostatTau ?? null,
        topK: chat.topK ?? null,
        topP: chat.topP ?? null,
        minP: chat.minP ?? null,
        frequencyPenalty: chat.frequencyPenalty ?? null,
        repeatLastN: chat.repeatLastN ?? null,
        tfsZ: chat.tfsZ ?? null,
        numCtx: chat.numCtx ?? null,
        numBatch: chat.numBatch ?? null,
        numKeep: chat.numKeep ?? null,
        numPredict: chat.numPredict ?? null,
        useMmap: chat.useMmap ?? null,
        useMlock: chat.useMlock ?? null,
      });
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Debounced autosave — same "just works, no Save button" feel as Open
  // WebUI's own Chat Controls drawer.
  useEffect(() => {
    if (!loaded) return;
    if (!chatId) {
      // Nothing to persist yet — still let the Prompt Library indicator
      // in ChatWindow track the edited value.
      onSystemPromptChange?.(fields.systemPrompt ?? null);
      return;
    }
    const t = setTimeout(() => {
      setSaving(true);
      setChatParameters(chatId, fields)
        .then(() => {
          // Brief "Saved" confirmation per user, per chat — auto-fades so it
          // doesn't linger and clutter the panel while someone keeps tweaking.
          setJustSaved(true);
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
          savedTimerRef.current = setTimeout(() => setJustSaved(false), 2000);
        })
        .finally(() => setSaving(false));
      onSystemPromptChange?.(fields.systemPrompt ?? null);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, loaded]);

  function set<K extends keyof ChatControlsFields>(key: K, value: ChatControlsFields[K]) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  const body = (
    <>
      <div className="h-14 sm:h-16 flex items-center justify-between px-4 shrink-0 border-b border-visiyon-border sm:border-b-0">
        <h2 className="text-[15px] font-semibold">Chat Controls</h2>
        <button onClick={onClose} className="text-visiyon-text-2 hover:text-visiyon-text p-1" title="Close">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8 min-h-0">
        {!loaded && <div className="py-6 text-[13px] text-visiyon-text-2">Loading…</div>}
        {loaded && (
          <>
            {/* System Prompt */}
            <button
              onClick={() => setPromptOpen((v) => !v)}
              className="w-full flex items-center justify-between py-2.5 text-[13px] font-medium text-visiyon-text-2"
            >
              System Prompt
              {promptOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {promptOpen && (
              <textarea
                value={fields.systemPrompt ?? ""}
                onChange={(e) => set("systemPrompt", e.target.value === "" ? null : e.target.value)}
                placeholder="Enter system prompt"
                rows={4}
                className="w-full text-[13px] bg-visiyon-panel2 border border-visiyon-border rounded-lg px-3 py-2 resize-y placeholder:text-visiyon-text-2 focus:outline-none focus:ring-1 focus:ring-visiyon-text/30 mb-1"
              />
            )}

            {/* Stream toggle */}
            <div className="flex items-center justify-between py-2.5 text-[13px] border-t border-visiyon-border gap-2">
              <span>Stream Chat Response</span>
              <SegmentedToggle value={fields.streamResponse} onChange={(v) => set("streamResponse", v)} />
            </div>

            {/* Stop Sequence */}
            <div className="py-2.5 text-[13px] border-t border-visiyon-border">
              <div className="mb-1.5">Stop Sequence</div>
              <textarea
                value={fields.stopSequence ?? ""}
                onChange={(e) => set("stopSequence", e.target.value === "" ? null : e.target.value)}
                placeholder="Default — one per line"
                rows={2}
                className="w-full text-[13px] bg-visiyon-panel2 border border-visiyon-border rounded-lg px-3 py-2 resize-y placeholder:text-visiyon-text-2 focus:outline-none focus:ring-1 focus:ring-visiyon-text/30"
              />
            </div>

            {/* Advanced Params */}
            <button
              onClick={() => setAdvancedOpen((v) => !v)}
              className="w-full flex items-center justify-between py-2.5 text-[13px] font-medium text-visiyon-text-2 border-t border-visiyon-border mt-1"
            >
              Advanced Params
              {advancedOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {advancedOpen && (
              <div>
                {SLIDER_FIELDS.map((f) => (
                  <Slider key={f.key} field={f} value={fields[f.key] as number | null | undefined} onChange={(v) => set(f.key, v)} />
                ))}
                {NUMBER_SLIDER_FIELDS.map((f) => (
                  <Slider key={f.key} field={f} value={fields[f.key] as number | null | undefined} onChange={(v) => set(f.key, v)} />
                ))}
                {(["useMmap", "useMlock"] as const).map((key) => (
                  <div key={key} className="flex items-center justify-between py-2.5 text-[13px] border-t border-visiyon-border gap-2">
                    <span>{key === "useMmap" ? "use_mmap (Ollama)" : "use_mlock (Ollama)"}</span>
                    <SegmentedToggle value={fields[key]} onChange={(v) => set(key, v)} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="h-6 shrink-0 px-4 text-[11px] text-visiyon-text-2 flex items-center gap-1.5">
        {saving && (
          <>
            <Loader2 size={11} className="animate-spin" /> Saving…
          </>
        )}
        {!saving && justSaved && (
          <>
            <Check size={11} className="text-green-400" /> Saved
          </>
        )}
        {!saving && !justSaved && "\u00A0"}
      </div>
    </>
  );

  return (
    <>
      {/* Mobile: full-screen bottom-sheet overlay so the panel never
          squeezes the chat column into an unusable width. */}
      <div className="sm:hidden fixed inset-0 z-50 flex flex-col bg-visiyon-panel">{body}</div>
      <div className="sm:hidden fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Desktop/tablet: fixed-width sidebar alongside the chat column. */}
      <div className="hidden sm:flex w-[320px] lg:w-[340px] shrink-0 h-full border-l border-visiyon-border bg-visiyon-panel flex-col">
        {body}
      </div>

      {/* Toast confirmation — mirrors the "Saved" chip pattern used
          elsewhere in the app (e.g. memory writes), so a save here reads
          the same way instead of only the small inline label above. */}
      {justSaved && (
        <div className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 text-[12.5px] bg-visiyon-panel border border-visiyon-border rounded-lg px-3 py-2 shadow-lg">
          <Check size={13} className="text-green-400" /> Chat Controls saved
        </div>
      )}
    </>
  );
}
