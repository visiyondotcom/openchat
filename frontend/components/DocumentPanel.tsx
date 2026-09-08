"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";

import { useEffect, useRef, useState } from "react";
import {
  listDocuments,
  uploadDocument,
  deleteDocument,
  attachDocument,
  detachDocument,
  DocumentSummary,
} from "@/lib/api";
import { Paperclip, X, FileText, Loader2, CheckCircle2, XCircle, Trash2 } from "lucide-react";

function statusIcon(status: DocumentSummary["status"]) {
  switch (status) {
    case "READY":
      return <CheckCircle2 size={13} className="text-emerald-400" />;
    case "FAILED":
      return <XCircle size={13} className="text-red-400" />;
    default:
      return <Loader2 size={13} className="animate-spin text-visiyon-text-3" />;
  }
}

export default function DocumentPanel({
  chatId,
  ensureChatId,
  attachedIds,
  onAttachedChange,
  asMenuItem,
  onOpened,
  onClosed,
  forceOpen,
}: {
  chatId?: string;
  // Creates the chat on first use and returns its id — lets a document be
  // attached even before any message has been sent, instead of requiring
  // "send a message first".
  ensureChatId: () => Promise<string>;
  attachedIds: string[];
  onAttachedChange: (ids: string[]) => void;
  // Rendered as a full-width labelled row inside the "+" dropdown instead
  // of the icon-only circular button used elsewhere.
  asMenuItem?: boolean;
  // Called right when this panel's own popover opens, so the parent "+"
  // dropdown can close itself and hand off to this one.
  onOpened?: () => void;
  // Called when this panel's own popover closes, so the parent "+" dropdown
  // can hand control back and show the other menu items again.
  onClosed?: () => void;
  // Lets a caller (the "View files in chat" menu item, which needs the
  // file list itself, not the collapsed "Documents" toggle) open this
  // panel's body directly instead of requiring a second click here.
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Same fix as ToolsPanel/PromptLibrary: the popup opens *upward* from
  // this trigger, so its natural height (up to 70vh) can exceed the space
  // actually available above it — pushing the header off the top of the
  // screen with no way to scroll back up to it. Clamp it to what's really
  // there.
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

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
  }, [open, docs.length]);

  async function refresh() {
    try {
      setDocs(await listDocuments());
    } catch {
      /* not logged in yet */
    }
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  // Poll while any document is still processing so status flips to READY live.
  useEffect(() => {
    if (!open) return;
    const hasPending = docs.some((d) => d.status === "PENDING" || d.status === "PROCESSING");
    if (!hasPending) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [docs, open]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const doc = await uploadDocument(file);
        setDocs((prev) => [doc, ...prev]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function toggleAttach(doc: DocumentSummary) {
    const isAttached = attachedIds.includes(doc.id);
    if (isAttached) {
      const id = chatId ?? (await ensureChatId());
      await detachDocument(id, doc.id);
      onAttachedChange(attachedIds.filter((id) => id !== doc.id));
    } else {
      const id = await ensureChatId();
      await attachDocument(id, doc.id);
      onAttachedChange([...attachedIds, doc.id]);
    }
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
          <Paperclip size={15} /> Documents{attachedIds.length > 0 ? ` (${attachedIds.length})` : ""}
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 p-2.5 rounded-xl border transition-colors ${
            attachedIds.length > 0 ? "border-visiyon-text text-visiyon-text" : "border-visiyon-border text-visiyon-text-2"
          }`}
          title="Attach documents"
        >
          <Paperclip size={16} />
          {attachedIds.length > 0 && <span className="text-[11px] font-medium">{attachedIds.length}</span>}
        </button>
      )}

      {open && (
        <div
          className={`menu-popup absolute w-[min(24rem,92vw)] max-h-[70vh] overflow-y-auto z-30 bg-visiyon-bg rounded-[20px] border border-white/10 shadow-2xl ${
            asMenuItem ? "bottom-0 left-0" : "bottom-full left-0 mb-2"
          }`}
          style={maxPanelHeight != null ? { maxHeight: maxPanelHeight } : undefined}
        >
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <span className="text-[15px] font-semibold">Documents</span>
            <button
              onClick={() => {
                setOpen(false);
                onClosed?.();
              }}
              className="flex items-center justify-center h-7 w-7 rounded-full text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/[0.08] transition-colors"
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          </div>

          <div className="px-4 pb-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv,.zip"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full flex items-center justify-center gap-2 text-[13px] font-medium py-3 rounded-2xl border border-dashed border-white/15 hover:border-white/30 hover:bg-white/[0.03] transition-colors disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "+ Upload PDF, DOCX, TXT, MD, CSV, ZIP"}
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto px-2 pb-2">
            {docs.length === 0 && (
              <p className="text-[12.5px] text-visiyon-text-3 px-3 py-4">No documents uploaded yet.</p>
            )}
            {docs.map((d) => {
              const attached = attachedIds.includes(d.id);
              const ext = d.filename.split(".").pop()?.toUpperCase() || "FILE";
              return (
                <div
                  key={d.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-2xl hover:bg-white/[0.05] group transition-colors"
                >
                  <div className="shrink-0 flex items-center justify-center h-9 w-9 rounded-xl bg-white/[0.06]">
                    <FileText size={16} className="text-visiyon-text-2" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">{d.filename}</div>
                    <div className="flex items-center gap-1 text-[11.5px] text-visiyon-text-3">
                      {statusIcon(d.status)}
                      {d.status === "FAILED" ? d.error || "Failed" : d.status === "READY" ? ext : d.status.toLowerCase()}
                    </div>
                  </div>
                  {d.status === "READY" && (
                    <button
                      onClick={() => toggleAttach(d)}
                      className={`text-[11.5px] font-medium px-3 py-1.5 rounded-full border shrink-0 transition-colors ${
                        attached
                          ? "bg-white text-black border-white"
                          : "border-white/15 text-visiyon-text-2 hover:border-white/30"
                      }`}
                    >
                      {attached ? "Attached" : "Attach"}
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (await askConfirm({ title: `Delete "${d.filename}"?`, confirmLabel: "Delete", danger: true })) {
                        await deleteDocument(d.id);
                        setDocs((prev) => prev.filter((x) => x.id !== d.id));
                        onAttachedChange(attachedIds.filter((id) => id !== d.id));
                      }
                    }}
                    className="flex items-center justify-center h-7 w-7 rounded-full text-visiyon-text-3 hover:text-red-400 hover:bg-red-400/10 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
