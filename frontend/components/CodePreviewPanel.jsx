import { useState } from "react";
import { Eye, Code2, Copy, Check, Maximize2, X, Plus, ChevronDown } from "lucide-react";

/**
 * CodePreviewPanel
 * A rounded, shadowed "artifact style" code viewer: header bar with
 * filename + type, Copy/Expand/Close controls, syntax-colored code body,
 * and a per-line "+" add-comment affordance that appears on row hover.
 *
 * Drop-in for the visiyon frontend — uses the existing theme tokens
 * (visiyon-panel / visiyon-panel2 / visiyon-border / visiyon-text) so it
 * automatically matches dark / light / midnight.
 */

// --- tiny dependency-free TS/JS token highlighter -------------------------
const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "import", "export", "from", "default", "async", "await", "new", "class",
  "extends", "interface", "type", "enum", "public", "private", "readonly",
  "as", "in", "of", "try", "catch", "finally", "throw", "switch", "case",
  "break", "continue", "void", "null", "undefined", "true", "false", "this",
]);

function highlight(line) {
  const tokens = line.split(/(\s+|[(){}[\];,.<>:=+\-*/!?&|]|"[^"]*"|'[^']*'|`[^`]*`)/g);
  return tokens.map((tok, idx) => {
    if (!tok) return null;
    if (/^["'`]/.test(tok)) return <span key={idx} className="text-emerald-400">{tok}</span>;
    if (/^\/\//.test(tok)) return <span key={idx} className="text-visiyon-text-3">{tok}</span>;
    if (KEYWORDS.has(tok)) return <span key={idx} className="text-violet-400">{tok}</span>;
    if (/^[0-9]+$/.test(tok)) return <span key={idx} className="text-amber-400">{tok}</span>;
    if (/^[A-Z][A-Za-z0-9]*$/.test(tok)) return <span key={idx} className="text-sky-400">{tok}</span>;
    if (/^[(){}[\];,.<>:=+\-*/!?&|]$/.test(tok)) return <span key={idx} className="text-visiyon-text-2">{tok}</span>;
    return <span key={idx}>{tok}</span>;
  });
}

export default function CodePreviewPanel({
  filename = "SettingsContent",
  language = "TSX",
  code = "",
}) {
  const [view, setView] = useState("code"); // "code" | "preview"
  const [copied, setCopied] = useState(false);
  const [hoverLine, setHoverLine] = useState(null);
  const [comments, setComments] = useState({});
  const [draft, setDraft] = useState("");
  const [commentingLine, setCommentingLine] = useState(null);

  const lines = code.split("\n");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable — fail silently, button just won't flip
    }
  }

  function submitComment(lineIdx) {
    if (!draft.trim()) return;
    setComments((prev) => ({
      ...prev,
      [lineIdx]: [...(prev[lineIdx] || []), draft.trim()],
    }));
    setDraft("");
    setCommentingLine(null);
  }

  return (
    <div className="w-full max-w-3xl mx-auto rounded-2xl border border-visiyon-border bg-visiyon-panel shadow-[0_8px_30px_-8px_rgba(0,0,0,0.35)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-visiyon-border bg-visiyon-panel2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setView(view === "code" ? "preview" : "code")}
            title={view === "code" ? "Show preview" : "Show code"}
            className="cursor-pointer flex items-center justify-center h-7 w-7 rounded-full border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/5 transition-colors shrink-0"
          >
            {view === "code" ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          <span className="truncate text-[13px] font-medium text-visiyon-text">{filename}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-visiyon-text/[0.08] text-visiyon-text-3 shrink-0">
            {language}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleCopy}
            className="cursor-pointer flex items-center gap-1 text-[12.5px] px-2.5 py-1.5 rounded-lg border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/5 transition-colors"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            <ChevronDown size={12} className="opacity-60" />
          </button>
          <button className="cursor-pointer flex items-center justify-center h-7 w-7 rounded-lg text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/5 transition-colors">
            <Maximize2 size={14} />
          </button>
          <button className="cursor-pointer flex items-center justify-center h-7 w-7 rounded-lg text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/5 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="max-h-[420px] overflow-y-auto bg-visiyon-bg">
        {view === "code" ? (
          <div className="font-mono text-[13px] leading-[1.65]">
            {lines.map((line, idx) => (
              <div
                key={idx}
                onMouseEnter={() => setHoverLine(idx)}
                onMouseLeave={() => setHoverLine((h) => (h === idx ? null : h))}
                className="group relative flex px-2 hover:bg-visiyon-text/[0.035]"
              >
                <span className="select-none w-10 shrink-0 text-right pr-3 text-visiyon-text-3">
                  {idx + 1}
                </span>

                {/* add-comment affordance — only visible while this row is hovered */}
                <button
                  onClick={() => setCommentingLine(idx)}
                  title="Add comment"
                  className={`cursor-pointer absolute left-8 top-1/2 -translate-y-1/2 flex items-center justify-center h-4 w-4 rounded-full bg-visiyon-text text-visiyon-bg transition-opacity ${
                    hoverLine === idx ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <Plus size={10} strokeWidth={3} />
                </button>

                <span className="whitespace-pre-wrap break-words text-visiyon-text">
                  {highlight(line) || "\u00A0"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-[13px] text-visiyon-text-3">
            Live preview would render here.
          </div>
        )}
      </div>

      {/* Comment composer */}
      {commentingLine !== null && (
        <div className="border-t border-visiyon-border bg-visiyon-panel2 p-3">
          <div className="text-[11px] text-visiyon-text-3 mb-1.5">
            Comment on line {commentingLine + 1}
          </div>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitComment(commentingLine);
                if (e.key === "Escape") setCommentingLine(null);
              }}
              placeholder="Leave a comment…"
              className="flex-1 bg-visiyon-bg border border-visiyon-border rounded-lg px-3 py-1.5 text-[13px] text-visiyon-text outline-none focus:border-visiyon-text/30"
            />
            <button
              onClick={() => submitComment(commentingLine)}
              className="cursor-pointer text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-visiyon-text text-visiyon-bg disabled:opacity-40"
              disabled={!draft.trim()}
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

      {/* Existing comments, grouped by line */}
      {Object.keys(comments).length > 0 && (
        <div className="border-t border-visiyon-border divide-y divide-visiyon-border">
          {Object.entries(comments).map(([lineIdx, notes]) =>
            notes.map((note, i) => (
              <div key={`${lineIdx}-${i}`} className="px-4 py-2 text-[12.5px]">
                <span className="text-visiyon-text-3">Line {Number(lineIdx) + 1} · </span>
                <span className="text-visiyon-text">{note}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
