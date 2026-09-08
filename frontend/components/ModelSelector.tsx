"use client";

import { useEffect, useRef, useState } from "react";
import { listModels } from "@/lib/api";
import { ChevronDown, Check, Zap, Cloud, HardDrive, Shuffle, Webhook } from "lucide-react";

// Small icon per model source, so the list is scannable at a glance
// instead of everything looking the same: a local Ollama model runs on
// your own GPU (HardDrive), a "provider:" entry is an external API
// (Cloud), a "meta:" entry blends several candidates with failover
// (Shuffle), and a "pipe:" entry is a custom Pipe (Webhook). Falls back
// to no icon for anything unrecognized rather than guessing.
function modelIcon(m: { name: string; family?: string }) {
  const size = 12;
  const cls = "shrink-0 text-visiyon-text-3";
  if (m.name.startsWith("meta:")) return <Shuffle size={size} className={cls} />;
  if (m.name.startsWith("pipe:")) return <Webhook size={size} className={cls} />;
  if (m.name.startsWith("provider:")) return <Cloud size={size} className={cls} />;
  return <HardDrive size={size} className={cls} />;
}

// Some deployments prefix displayName with a provider label, e.g.
// "OpenChat AI: meta/muse-glimmer-30b". Splitting that off into a small
// muted tag (instead of repeating the full prefix on every row) keeps the
// list scannable instead of noisy.
function splitLabel(label: string): { tag: string | null; name: string } {
  const i = label.indexOf(": ");
  if (i === -1 || i > 24) return { tag: null, name: label };
  return { tag: label.slice(0, i), name: label.slice(i + 2) };
}

export default function ModelSelector({
  value,
  onChange,
  compact = false,
  dropUp = false,
}: {
  value: string;
  onChange: (model: string) => void;
  compact?: boolean;
  dropUp?: boolean;
}) {
  const [models, setModels] = useState<
    { name: string; parameterSize?: string; family?: string; displayName?: string; description?: string | null }[]
  >([]);
  const [open, setOpen] = useState(false);
  // hydrated = true zodra de modellen geladen zijn → voorkomt "Select model" flash
  const [hydrated, setHydrated] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Vaste "60vh" hield geen rekening met hoe dicht de knop bij de rand van
  // het scherm staat — bij dropUp schoot de lijst dan boven de viewport uit
  // (verstopt achter de browser-UI). We meten hoeveel ruimte er ECHT is
  // (boven de knop bij dropUp, eronder anders) en clampen daarop, met een
  // kleine marge zodat de lijst nooit tegen de randbeeld plakt.
  const [maxListHeight, setMaxListHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !wrapRef.current) return;
    const EDGE_MARGIN = 12;
    const TRIGGER_GAP = 40; // knophoogte + marge tussen knop en lijst

    function measure() {
      if (!wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const available = dropUp
        ? rect.top - EDGE_MARGIN - TRIGGER_GAP
        : window.innerHeight - rect.bottom - EDGE_MARGIN - TRIGGER_GAP;
      setMaxListHeight(Math.max(160, Math.min(available, window.innerHeight * 0.6)));
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, dropUp]);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        // Prefer a meta-model ("Jean") as the auto-picked default: it races
        // several real candidates with failover, so it's far less likely to
        // be the one broken/incompatible entry than an arbitrary raw Ollama
        // tag would be if we just always took m[0].
        if (!value && m.length) {
          const metaModel = m.find((x) => x.name.startsWith("meta:"));
          onChange((metaModel ?? m[0]).name);
        }
      })
      .catch(() => setModels([]))
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selected = models.find((m) => m.name === value);

  // Label dat in de button staat. Zodra we een `value` hebben (ook al zijn
  // de modellen nog niet geladen) tonen we die meteen — anders knippert de
  // naam kort weg bij elke refresh terwijl listModels() nog bezig is.
  // Alleen als er echt nog geen `value` is, houden we een non-breaking
  // space aan om de button-hoogte stabiel te houden.
  const rawLabel = selected?.displayName || value || (hydrated ? "Select model" : "\u00A0");
  const buttonLabel = splitLabel(rawLabel).name;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={rawLabel}
        className={`
          flex items-center gap-1.5 h-9 font-medium rounded-full transition-colors shrink-0
          text-visiyon-text-2 hover:text-visiyon-text
          ${compact ? "text-[12px] px-3" : "text-sm px-3.5"}
          ${open ? "bg-visiyon-text/10" : "hover:bg-visiyon-text/10"}
          max-w-[92px] sm:max-w-[130px] min-w-0
        `}
      >
        {selected && modelIcon(selected)}
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown
          size={compact ? 11 : 13}
          className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={`
            menu-popup
            absolute right-0 z-20
            w-max min-w-[var(--ms-min,11rem)] max-w-[min(92vw,22rem)]
            bg-visiyon-panel
            rounded-xl shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] ring-1 ring-visiyon-text/[0.06]
            overflow-hidden
            ${dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5"}
          `}
          // min-breedte volgt automatisch de breedte van de trigger-knop
          style={{ "--ms-min": wrapRef.current ? `${wrapRef.current.offsetWidth}px` : "11rem" } as React.CSSProperties}
        >
          {models.length === 0 && hydrated && (
            <div className="px-3.5 py-3 text-[13px] text-visiyon-text-3">
              No models found — run <code>ollama pull jean:4b</code> on the server.
            </div>
          )}

          <div
            className="overflow-y-auto py-1.5"
            style={{ maxHeight: maxListHeight ? `${maxListHeight}px` : "60vh" }}
          >
            {models.map((m) => {
              const isSelected = m.name === value;
              const { tag, name } = splitLabel(m.displayName || m.name);
              return (
                <button
                  key={m.name}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(m.name);
                    setOpen(false);
                  }}
                  className={`
                    w-full text-left px-3 py-1 mx-1 my-px rounded-md
                    flex items-center justify-between gap-2.5 min-w-0
                    transition-colors
                    ${isSelected ? "bg-visiyon-text/[0.07]" : "hover:bg-visiyon-text/[0.045]"}
                  `}
                  style={{ width: "calc(100% - 0.5rem)" }}
                >
                  <span className="min-w-0 flex items-center gap-1.5 text-[12.5px] font-medium">
                    {modelIcon(m)}
                    {tag && (
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-visiyon-text-3">
                        {tag}
                      </span>
                    )}
                    <span className="truncate">{name}</span>
                  </span>
                  {isSelected && <Check size={11} className="text-visiyon-accent shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
