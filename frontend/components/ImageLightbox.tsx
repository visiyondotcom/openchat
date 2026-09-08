"use client";

import { useEffect, useRef, useState } from "react";
import { X, Download, RefreshCw, Wand2 } from "lucide-react";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  prompt?: string;
  isRegenerating: boolean;
  onClose: () => void;
  // Optional — omitted (or undefined) for images that can't be regenerated,
  // like a screenshot the user attached. When absent, the bottom prompt
  // bar (which only makes sense for AI-generated images) isn't shown.
  onRegenerate?: (prompt: string) => void;
}

// Fullscreen viewer for a generated image — click a generated image in chat
// to open it here. Modeled on OpenAI's image viewer: image centered and
// scaled to fit the viewport, a small toolbar (download / close) top-right,
// and a prompt bar pinned to the bottom that re-submits straight to
// generateChatImage (see ChatWindow's handleRegenerateImage) instead of
// bouncing the user back to the composer.
export default function ImageLightbox({
  src,
  alt,
  prompt,
  isRegenerating,
  onClose,
  onRegenerate,
}: ImageLightboxProps) {
  const [editPrompt, setEditPrompt] = useState(prompt ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync the prompt bar whenever a new image is shown (e.g. after a
  // regenerate swaps `src`/`prompt` in the parent) — but leave it alone
  // while the user is actively editing on top of the same image.
  useEffect(() => {
    setEditPrompt(prompt ?? "");
  }, [src, prompt]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  function handleDownload() {
    const a = document.createElement("a");
    a.href = src;
    a.download = `visiyon-image-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function handleSubmit() {
    const trimmed = editPrompt.trim();
    if (!trimmed || isRegenerating || !onRegenerate) return;
    onRegenerate(trimmed);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Generated image viewer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 shrink-0">
        <button
          type="button"
          onClick={handleDownload}
          title="Download"
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Download size={16} /> <span className="hidden sm:inline">Download</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="flex items-center justify-center h-9 w-9 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      {/* Image, scaled to fit whatever's left after the toolbar and prompt bar */}
      <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-2">
        <div className="relative max-w-full max-h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt || "Generated image"}
            className={`max-w-full max-h-[calc(100vh-176px)] rounded-lg object-contain shadow-[0_8px_40px_rgba(0,0,0,0.6)] transition-opacity ${
              isRegenerating ? "opacity-40" : "opacity-100"
            }`}
          />
          {isRegenerating && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white/90 text-[13px]">
                <RefreshCw size={14} className="animate-spin" /> Regenerating…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Prompt bar — pinned to the bottom, same idea as ChatGPT's image editor.
          Only rendered when regeneration is actually possible (AI-generated
          images) — an attached screenshot has nothing to regenerate. */}
      {onRegenerate && (
      <div className="shrink-0 px-4 pb-4 pt-2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="max-w-2xl mx-auto">
          <div className="flex items-end gap-2 rounded-[14px] bg-[#161616]/95 border border-white/10 shadow-[0_4px_20px_rgba(0,0,0,0.5)] px-3 py-2">
            <textarea
              ref={inputRef}
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Describe a change and regenerate…"
              rows={1}
              disabled={isRegenerating}
              className="flex-1 bg-transparent text-white text-[14px] leading-snug outline-none resize-none py-1.5 placeholder:text-white/40 disabled:opacity-50 max-h-32"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!editPrompt.trim() || isRegenerating}
              title="Regenerate"
              className="flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-[10px] bg-white text-black text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/90 transition-colors"
            >
              {isRegenerating ? <RefreshCw size={14} className="animate-spin" /> : <Wand2 size={14} />}
              <span className="hidden sm:inline">Regenerate</span>
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
