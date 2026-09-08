"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Drop-in replacement for a native <select> — same value/onChange contract,
// but a themed floating listbox instead of the browser's own unstyled
// popup (which ignores the app's dark/light/midnight theme entirely and
// renders as a flat grey OS menu). Used everywhere a <select> used to be:
// Settings, admin panels, Studio, Automations, etc.
export default function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className = "",
  buttonClassName = "",
  panelClassName = "",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  buttonClassName?: string;
  panelClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  const current = options.find((o) => o.value === value);

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`cursor-pointer w-full flex items-center justify-between gap-2 bg-visiyon-panel2 border border-visiyon-border rounded-lg pl-3 pr-2.5 py-2 text-[13px] text-visiyon-text outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:border-visiyon-text/25 ${
          open ? "border-visiyon-text/40" : ""
        } ${buttonClassName}`}
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-visiyon-text-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className={`absolute left-0 right-0 mt-1.5 max-h-64 overflow-y-auto bg-visiyon-panel border border-visiyon-border rounded-xl z-50 py-1 visiyon-elevated-lg ${panelClassName}`}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={o.disabled}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`cursor-pointer w-full flex items-center justify-between gap-2 px-3 py-2 text-[13px] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                o.value === value
                  ? "bg-visiyon-text/10 text-visiyon-text"
                  : "text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text"
              }`}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <Check size={14} className="shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
