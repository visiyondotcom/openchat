"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";

import { useEffect, useRef, useState } from "react";
import {
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  setChatSystemPrompt,
  apiFetch,
  Prompt,
} from "@/lib/api";
import { BookOpen, X, Plus, Trash2, Globe2, Check } from "lucide-react";

export default function PromptLibrary({
  chatId,
  activeSystemPrompt,
  onApply,
  asMenuItem,
  onOpened,
  onClosed,
}: {
  chatId?: string;
  activeSystemPrompt?: string | null;
  onApply: (content: string) => void;
  asMenuItem?: boolean;
  onOpened?: () => void;
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Same fix as ToolsPanel: the popup opens *upward* from this trigger,
  // so its natural height (up to 70vh) can exceed the space actually
  // available above it — pushing the title field and header off the
  // top of the screen with no way to scroll back up to them. Clamp it
  // to what's really there.
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);

  async function refresh() {
    try {
      setPrompts(await listPrompts());
      const me = await apiFetch("/auth/me");
      setIsAdmin(me.user?.role === "ADMIN");
    } catch {
      /* not logged in yet */
    }
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const available = rect.top - 8;
      setMaxPanelHeight(Math.max(160, Math.min(available, window.innerHeight * 0.7)));
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [open, creating, prompts.length]);

  async function handleSave() {
    if (!title.trim() || !content.trim()) {
      alert(!title.trim() ? "Title is required." : "Content is required.");
      return;
    }
    setSaving(true);
    try {
      const prompt = await createPrompt({ title, content, sharedWithAll: shared });
      setPrompts((prev) => [prompt, ...prev]);
      setCreating(false);
      setTitle("");
      setContent("");
      setShared(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not save prompt");
    } finally {
      setSaving(false);
    }
  }

  async function handleApply(prompt: Prompt) {
    onApply(prompt.content);
    if (chatId) {
      await setChatSystemPrompt(chatId, prompt.content);
    }
    setOpen(false);
    onClosed?.();
  }

  async function handleDelete(prompt: Prompt) {
    if (!(await askConfirm({ title: `Delete preset "${prompt.title}"?`, confirmLabel: "Delete", danger: true }))) return;
    await deletePrompt(prompt.id);
    setPrompts((prev) => prev.filter((p) => p.id !== prompt.id));
  }

  return (
    <div className="relative" ref={wrapperRef}>
      {asMenuItem ? (
        <button
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) onOpened?.();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
        >
          <BookOpen size={15} /> Prompt library
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 p-2.5 rounded-xl border transition-colors ${
            activeSystemPrompt ? "border-visiyon-text text-visiyon-text" : "border-visiyon-border text-visiyon-text-2"
          }`}
          title="Prompt library"
        >
          <BookOpen size={16} />
        </button>
      )}

      {open && (
        <div
          className={`menu-popup absolute w-[min(24rem,92vw)] max-h-[70vh] overflow-y-auto z-30 bg-visiyon-bg rounded-2xl shadow-2xl ${
            asMenuItem ? "bottom-0 left-0" : "bottom-full left-0 mb-2"
          }`}
          style={maxPanelHeight != null ? { maxHeight: maxPanelHeight } : undefined}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13.5px] font-medium">Prompt library</span>
            <button
              onClick={() => {
                setOpen(false);
                onClosed?.();
              }}
              className="text-visiyon-text-3 hover:text-visiyon-text"
            >
              <X size={14} />
            </button>
          </div>

          {activeSystemPrompt && (
            <div className="px-4 py-2.5 border-b border-visiyon-border flex items-start justify-between gap-2">
              <p className="text-[11.5px] text-visiyon-text-3 line-clamp-2">
                Active: {activeSystemPrompt}
              </p>
              <button
                onClick={async () => {
                  onApply("");
                  if (chatId) await setChatSystemPrompt(chatId, null);
                }}
                className="text-[11px] text-visiyon-text-3 hover:text-visiyon-text shrink-0"
              >
                Clear
              </button>
            </div>
          )}

          {creating ? (
            <div className="p-3 border-b border-visiyon-border space-y-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
              />
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="System prompt content…"
                rows={4}
                className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text resize-none"
              />
              {isAdmin && (
                <label className="flex items-center gap-2 text-[12px] text-visiyon-text-2">
                  <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
                  Share with everyone
                </label>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 text-[13px] font-medium py-1.5 rounded-lg bg-white text-black disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => setCreating(false)}
                  className="text-[13px] px-3 py-1.5 rounded-lg border border-visiyon-border text-visiyon-text-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="p-3 border-b border-visiyon-border">
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium py-2 rounded-xl border border-dashed border-visiyon-border hover:border-visiyon-text transition-colors"
              >
                <Plus size={14} /> New preset
              </button>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto">
            {prompts.length === 0 && (
              <p className="text-[12.5px] text-visiyon-text-3 px-4 py-4">No presets saved yet.</p>
            )}
            {prompts.map((p) => (
              <div key={p.id} className="flex items-start gap-2.5 px-4 py-2.5 hover:bg-visiyon-text/[0.04] group">
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleApply(p)}>
                  <div className="flex items-center gap-1.5 text-[13px] truncate">
                    {p.title}
                    {p.sharedWithAll && <Globe2 size={11} className="text-visiyon-text-3 shrink-0" />}
                  </div>
                  <div className="text-[11.5px] text-visiyon-text-3 truncate">{p.content}</div>
                </div>
                {activeSystemPrompt === p.content && <Check size={13} className="text-emerald-400 shrink-0 mt-0.5" />}
                <button
                  onClick={() => handleDelete(p)}
                  className="hidden group-hover:block text-visiyon-text-3 hover:text-red-400 shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
