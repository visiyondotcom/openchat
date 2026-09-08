"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Download, RefreshCw, Pencil, Eye, ExternalLink, Plus } from "lucide-react";
import { useChatStore, type PreviewBlocks } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";

// Tiny dependency-free tokenizer for the edit-mode code overlay — colors
// keywords/strings/numbers/comments so the raw-source view reads like a
// real code editor instead of a flat textarea.
const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "import", "export", "from", "default", "async", "await", "new", "class",
  "extends", "interface", "type", "enum", "public", "private", "readonly",
  "as", "in", "of", "try", "catch", "finally", "throw", "switch", "case",
  "break", "continue", "void", "null", "undefined", "true", "false", "this",
]);

function highlightLine(line: string, key: string) {
  const tokens = line.split(/(\s+|[(){}[\];,.<>:=+\-*/!?&|]|"[^"]*"|'[^']*'|`[^`]*`)/g);
  return tokens.map((tok, idx) => {
    if (!tok) return null;
    const tKey = `${key}-${idx}`;
    if (/^["'`]/.test(tok)) return <span key={tKey} className="text-emerald-400">{tok}</span>;
    if (/^\/\//.test(tok)) return <span key={tKey} className="text-visiyon-text-3">{tok}</span>;
    if (CODE_KEYWORDS.has(tok)) return <span key={tKey} className="text-violet-400">{tok}</span>;
    if (/^[0-9]+$/.test(tok)) return <span key={tKey} className="text-amber-400">{tok}</span>;
    if (/^<\/?[A-Za-z][\w.]*/.test(tok)) return <span key={tKey} className="text-sky-400">{tok}</span>;
    return <span key={tKey}>{tok}</span>;
  });
}

// Combines whichever html/css/js blocks the current message has produced
// so far into a single renderable document — an html block with a
// separate css and/or js block for the same site is merged into one page
// (css injected into <head>, js injected before </body>) instead of each
// new block replacing the previous one wholesale, which used to make the
// preview flash to "just the css" or go blank as soon as a second block
// appeared after the html block.
function buildCombinedDoc(blocks: PreviewBlocks): string {
  if (blocks.html) {
    let doc = blocks.html;
    if (blocks.css) {
      const styleTag = `<style>${blocks.css}</style>`;
      doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, `${styleTag}</head>`) : styleTag + doc;
    }
    if (blocks.js) {
      const scriptTag = `<script>${blocks.js}</script>`;
      doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${scriptTag}</body>`) : doc + scriptTag;
    }
    return doc;
  }
  // No html block yet (still streaming, or the AI only produced css/js) —
  // fall back to a minimal shell so there's still something to look at.
  if (blocks.css) {
    return `<!doctype html><html><head><style>${blocks.css}</style></head><body><p style="font-family:sans-serif;color:#888;padding:12px">CSS preview — add HTML to see it applied to real elements.</p></body></html>`;
  }
  if (blocks.js) {
    return `<!doctype html><html><head></head><body><script>${blocks.js}</script></body></html>`;
  }
  return "";
}

const SLOT_LABELS: Record<"html" | "css" | "js", string> = {
  html: "index.html",
  css: "style.css",
  js: "script.js",
};

export default function PreviewPanel() {
  const { previewOpen, previewBlocks, previewFileName, previewMessageId, closePreview, updatePreviewBlock } =
    useChatStore(
      useShallow((s) => ({
        previewOpen: s.previewOpen,
        previewBlocks: s.previewBlocks,
        previewFileName: s.previewFileName,
        previewMessageId: s.previewMessageId,
        closePreview: s.closePreview,
        updatePreviewBlock: s.updatePreviewBlock,
      }))
    );

  // "preview" = the live rendered iframe (default); "edit" = raw source,
  // one tab per slot the current message actually produced (html/css/js).
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [commentingLine, setCommentingLine] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [lineComments, setLineComments] = useState<Record<number, string[]>>({});
  const availableSlots = useMemo(
    () => (["html", "css", "js"] as const).filter((slot) => previewBlocks[slot] != null),
    [previewBlocks]
  );
  const [activeSlot, setActiveSlot] = useState<"html" | "css" | "js">("html");
  const [draft, setDraft] = useState("");
  const [currentLine, setCurrentLine] = useState(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineCount = useMemo(() => draft.split("\n").length, [draft]);

  // Keeps the line-number gutter AND the highlighted code overlay scrolled
  // in sync with the textarea — there's no native way to attach a gutter
  // (or a colored overlay) to a <textarea>, so this just mirrors its
  // scrollTop/scrollLeft on every scroll event.
  function syncGutterScroll() {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
    if (highlightRef.current && textareaRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }

  // Recomputes which line the caret sits on from selectionStart — counting
  // newlines up to the caret is cheap even for large files and needs no
  // extra libraries, unlike a real editor's line/column tracking.
  function syncCurrentLine() {
    const el = textareaRef.current;
    if (!el) return;
    const upToCaret = el.value.slice(0, el.selectionStart ?? 0);
    setCurrentLine(upToCaret.split("\n").length);
  }

  // Switching message or leaving edit mode resets which slot is being
  // edited to whichever the panel is currently titled after.
  useEffect(() => {
    if (availableSlots.length === 0) return;
    if (!availableSlots.includes(activeSlot)) setActiveSlot(availableSlots[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSlots]);

  useEffect(() => {
    setDraft(previewBlocks[activeSlot] ?? "");
  }, [activeSlot, previewMessageId]);

  // Re-syncs the draft with the live block's content when entering edit
  // mode, so a person editing right after new streamed content lands sees
  // the latest code rather than a stale snapshot from an earlier open.
  function enterEditMode() {
    setDraft(previewBlocks[activeSlot] ?? "");
    setCurrentLine(1);
    setMode("edit");
  }

  function applyEditsAndPreview() {
    updatePreviewBlock(activeSlot, draft);
    setMode("preview");
  }

  const doc = useMemo(() => buildCombinedDoc(previewBlocks), [previewBlocks]);
  // Changing the iframe key forces a full remount = a clean re-render,
  // which is what "refresh" should do for a sandboxed live preview.
  const iframeKey = useMemo(() => previewMessageId + ":" + doc.length, [previewMessageId, doc]);

  // Popped-out preview: a real separate browser window (not just a bigger
  // iframe), so it can be dragged to another monitor like any normal
  // window — something impossible to do with an element still living
  // inside this page. Kept in sync by rewriting its document whenever the
  // combined doc changes (new streamed content, or an applied edit), so
  // the popped-out window stays live instead of freezing at first-open.
  const popoutRef = useRef<Window | null>(null);

  function popOut() {
    const w = popoutRef.current && !popoutRef.current.closed ? popoutRef.current : window.open("", "_blank", "width=900,height=700");
    if (!w) return; // popup blocked
    w.document.open();
    w.document.write(doc || "<!doctype html><title>Preview</title><body style='font-family:sans-serif;color:#888;padding:24px'>Nothing to preview yet.</body>");
    w.document.close();
    w.document.title = previewFileName || "Preview";
    popoutRef.current = w;
  }

  // Keep an already-open popout window's content live as the doc changes.
  useEffect(() => {
    const w = popoutRef.current;
    if (!w || w.closed) return;
    w.document.open();
    w.document.write(doc || "<!doctype html><title>Preview</title><body style='font-family:sans-serif;color:#888;padding:24px'>Nothing to preview yet.</body>");
    w.document.close();
  }, [doc]);

  // Close the popout when this panel itself closes, so a stray preview
  // window doesn't linger after the person is done with this chat.
  useEffect(() => {
    return () => {
      if (popoutRef.current && !popoutRef.current.closed) popoutRef.current.close();
    };
  }, []);

  function download() {
    const blob = new Blob([doc], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = previewFileName || "index.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function submitLineComment(lineNum: number) {
    if (!commentDraft.trim()) return;
    setLineComments((prev) => ({
      ...prev,
      [lineNum]: [...(prev[lineNum] || []), commentDraft.trim()],
    }));
    setCommentDraft("");
    setCommentingLine(null);
  }

  if (!previewOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-visiyon-bg lg:static lg:z-auto lg:flex lg:flex-col lg:w-[45%] lg:max-w-[720px] lg:min-w-[360px] h-full lg:h-[calc(100%-16px)] lg:my-2 lg:mr-2 border border-visiyon-border lg:rounded-2xl overflow-hidden shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)]">
      <div className="h-11 flex items-center justify-between px-3 lg:px-4 shrink-0 relative z-10 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.3)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-visiyon-text font-medium truncate max-w-[38vw] lg:max-w-none">
            {mode === "edit" ? SLOT_LABELS[activeSlot] : previewFileName}
          </span>
          <span className="text-[11px] text-visiyon-text-3 shrink-0 uppercase">
            {mode === "edit"
              ? activeSlot
              : previewFileName.endsWith(".css")
              ? "css"
              : previewFileName.endsWith(".js")
              ? "js"
              : "html"}
          </span>
        </div>
        <div className="flex items-center gap-0.5 lg:gap-1 shrink-0">
          {mode === "preview" ? (
            <>
              <button
                key={"refresh-" + iframeKey}
                onClick={() => {
                  /* remount handled by iframe key changing on new code; this
                     button re-forces it even when the code hasn't changed */
                }}
                className="cursor-pointer flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
                title="Refresh preview"
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={popOut}
                className="cursor-pointer flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
                title="Open in a separate window (drag it to another screen)"
              >
                <ExternalLink size={14} />
              </button>
              <button
                onClick={enterEditMode}
                className="cursor-pointer flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
                title="Edit code"
              >
                <Pencil size={14} />
              </button>
            </>
          ) : (
            <button
              onClick={applyEditsAndPreview}
              className="cursor-pointer flex items-center gap-1.5 h-8 px-2.5 lg:px-3 rounded-lg text-[12.5px] font-medium bg-white text-black hover:bg-visiyon-text/85 transition-colors"
              title="Apply edits and show preview"
            >
              <Eye size={13} /> <span className="hidden sm:inline">Preview</span>
            </button>
          )}
          <button
            onClick={download}
            className="cursor-pointer flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
            title={`Download ${previewFileName}`}
          >
            <Download size={14} />
          </button>
          <button
            onClick={closePreview}
            className="cursor-pointer flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
            title="Close preview"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {mode === "edit" && availableSlots.length > 1 && (
        <div className="flex items-center gap-1 px-3 lg:px-4 pb-2 shrink-0 overflow-x-auto">
          {availableSlots.map((slot) => (
            <button
              key={slot}
              onClick={() => setActiveSlot(slot)}
              className={`cursor-pointer text-[11.5px] px-2.5 py-1 rounded-md transition-colors shrink-0 ${
                activeSlot === slot
                  ? "bg-visiyon-text/15 text-visiyon-text"
                  : "text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/5"
              }`}
            >
              {SLOT_LABELS[slot]}
            </button>
          ))}
        </div>
      )}

      {mode === "preview" ? (
        <div className="flex-1 bg-white min-h-0">
          <iframe
            key={iframeKey}
            srcDoc={doc}
            title="Live preview"
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="w-full h-full border-0"
          />
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 flex min-h-0 bg-visiyon-panel2 overflow-hidden">
            <div
              ref={gutterRef}
              aria-hidden="true"
              className="shrink-0 overflow-hidden text-right text-visiyon-text-3 text-[13px] leading-relaxed font-mono select-none py-3 pl-3 lg:pl-4 pr-2"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div
                  key={i}
                  onMouseEnter={() => setHoverLine(i + 1)}
                  onMouseLeave={() => setHoverLine((h) => (h === i + 1 ? null : h))}
                  className={`relative pointer-events-auto flex items-center justify-end gap-1.5 ${
                    i + 1 === currentLine ? "text-emerald-400 font-semibold" : ""
                  }`}
                >
                  <button
                    onClick={() => {
                      setCommentingLine(i + 1);
                      setCommentDraft("");
                    }}
                    title="Add comment"
                    className={`cursor-pointer flex items-center justify-center h-4 w-4 rounded-full bg-visiyon-text text-visiyon-bg transition-opacity ${
                      hoverLine === i + 1 ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    <Plus size={9} strokeWidth={3} />
                  </button>
                  <span>{i + 1}</span>
                </div>
              ))}
            </div>

            {/* Highlighted code sits behind the textarea; the textarea's own
                text is transparent so only its caret/selection are visible —
                this gives a colored, still-fully-editable code view without
                pulling in a full editor dependency. */}
            <div className="relative flex-1 min-h-0">
              <pre
                ref={highlightRef}
                aria-hidden="true"
                className="absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-relaxed font-mono px-3 lg:px-4 py-3 pointer-events-none m-0 text-visiyon-text"
              >
                {draft.split("\n").map((line, i) => (
                  <div key={i}>{highlightLine(line, String(i)) || "\u00A0"}</div>
                ))}
              </pre>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  syncCurrentLine();
                }}
                onScroll={syncGutterScroll}
                onKeyUp={syncCurrentLine}
                onClick={syncCurrentLine}
                onSelect={syncCurrentLine}
                spellCheck={false}
                className="absolute inset-0 w-full h-full bg-transparent text-transparent caret-visiyon-text text-[13px] leading-relaxed font-mono outline-none resize-none px-3 lg:px-4 py-3"
              />
            </div>
          </div>

          {commentingLine !== null && (
            <div className="shrink-0 border-t border-visiyon-border bg-visiyon-panel2 p-3">
              <div className="text-[11px] text-visiyon-text-3 mb-1.5">Comment on line {commentingLine}</div>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitLineComment(commentingLine);
                    if (e.key === "Escape") setCommentingLine(null);
                  }}
                  placeholder="Leave a comment…"
                  className="flex-1 bg-visiyon-bg border border-visiyon-border rounded-lg px-3 py-1.5 text-[13px] text-visiyon-text outline-none focus:border-visiyon-text/30"
                />
                <button
                  onClick={() => submitLineComment(commentingLine)}
                  disabled={!commentDraft.trim()}
                  className="cursor-pointer text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-white text-black disabled:opacity-40"
                >
                  Reply
                </button>
                <button
                  onClick={() => setCommentingLine(null)}
                  className="cursor-pointer text-[12.5px] px-2 py-1.5 rounded-lg text-visiyon-text-2 hover:text-visiyon-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {Object.keys(lineComments).length > 0 && (
            <div className="shrink-0 max-h-32 overflow-y-auto border-t border-visiyon-border divide-y divide-visiyon-border">
              {Object.entries(lineComments).map(([lineNum, notes]) =>
                notes.map((note, i) => (
                  <div key={`${lineNum}-${i}`} className="px-3 lg:px-4 py-2 text-[12.5px]">
                    <span className="text-visiyon-text-3">Line {lineNum} · </span>
                    <span className="text-visiyon-text">{note}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
