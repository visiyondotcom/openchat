"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Drop-in replacement for window.prompt()/window.confirm(). The native
 * browser popups look out of place (unstyled, breaks the dark theme) and
 * can't be dismissed with a click outside. This renders a small centered
 * modal instead and resolves a promise the same way prompt/confirm did,
 * so call sites barely have to change.
 */

interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  confirmLabel?: string;
  placeholder?: string;
}

interface ConfirmOptions {
  title: string;
  confirmLabel?: string;
  danger?: boolean;
}

type PendingState =
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | null;

let setPendingExternal: ((state: PendingState) => void) | null = null;

export function askPrompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    setPendingExternal?.({ kind: "prompt", options, resolve });
  });
}

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setPendingExternal?.({ kind: "confirm", options, resolve });
  });
}

/** Mount this once near the root (e.g. in Sidebar or layout). */
export function PromptDialogHost() {
  const [pending, setPending] = useState<PendingState>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPendingExternal = setPending;
    return () => {
      setPendingExternal = null;
    };
  }, []);

  useEffect(() => {
    if (pending?.kind === "prompt") {
      setValue(pending.options.defaultValue ?? "");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [pending]);

  if (!pending) return null;

  function close(result: any) {
    if (pending?.kind === "prompt") pending.resolve(result);
    if (pending?.kind === "confirm") pending.resolve(result);
    setPending(null);
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4"
      onClick={() => close(pending.kind === "prompt" ? null : false)}
    >
      <div
        className="w-full max-w-sm bg-visiyon-panel border border-visiyon-border rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-medium mb-3">{pending.options.title}</h3>

        {pending.kind === "prompt" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              close(value.trim() || null);
            }}
          >
            {pending.options.label && (
              <label className="text-[12px] text-visiyon-text-3 block mb-1.5">{pending.options.label}</label>
            )}
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={pending.options.placeholder}
              className="w-full text-[13.5px] bg-visiyon-text/[0.05] rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-white/30 text-visiyon-text placeholder-visiyon-text-3/30 mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(null)}
                className="px-3.5 py-1.5 rounded-lg text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-white text-black hover:bg-visiyon-text/80 transition-colors"
              >
                {pending.options.confirmLabel ?? "OK"}
              </button>
            </div>
          </form>
        )}

        {pending.kind === "confirm" && (
          <div>
            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => close(false)}
                className="px-3.5 py-1.5 rounded-lg text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => close(true)}
                className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                  pending.options.danger
                    ? "bg-red-500/90 text-visiyon-text hover:bg-red-500"
                    : "bg-white text-black hover:bg-visiyon-text/80"
                }`}
              >
                {pending.options.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
