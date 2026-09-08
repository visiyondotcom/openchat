import { useState } from "react";
import { Eye, Code2, Copy, Check, Maximize2, X, Plus, ChevronDown } from "lucide-react";

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
    if (/^\/\//.test(tok)) return <span key={idx} className="text-neutral-500">{tok}</span>;
    if (KEYWORDS.has(tok)) return <span key={idx} className="text-violet-400">{tok}</span>;
    if (/^[0-9]+$/.test(tok)) return <span key={idx} className="text-amber-400">{tok}</span>;
    if (/^[A-Z][A-Za-z0-9]*$/.test(tok)) return <span key={idx} className="text-sky-400">{tok}</span>;
    if (/^[(){}[\];,.<>:=+\-*/!?&|]$/.test(tok)) return <span key={idx} className="text-neutral-400">{tok}</span>;
    return <span key={idx}>{tok}</span>;
  });
}

const SAMPLE_CODE = `export function formatMessageTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return \`\${day}, \${time}\`;
}`;

function CodePreviewPanel({ filename = "SettingsContent", language = "TSX", code = "" }) {
  const [view, setView] = useState("code");
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
    } catch {}
  }

  function submitComment(lineIdx) {
    if (!draft.trim()) return;
    setComments((prev) => ({ ...prev, [lineIdx]: [...(prev[lineIdx] || []), draft.trim()] }));
    setDraft("");
    setCommentingLine(null);
  }

  return (
    <div className="w-full max-w-3xl mx-auto rounded-2xl border border-neutral-800 bg-neutral-900 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.55)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800 bg-neutral-950">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setView(view === "code" ? "preview" : "code")}
            title={view === "code" ? "Show preview" : "Show code"}
            className="cursor-pointer flex items-center justify-center h-7 w-7 rounded-full border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:bg-white/5 transition-colors shrink-0"
          >
            {view === "code" ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          <span className="truncate text-[13px] font-medium text-neutral-100">{filename}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-white/[0.08] text-neutral-400 shrink-0">
            {language}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleCopy}
            className="cursor-pointer flex items-center gap-1 text-[12.5px] px-2.5 py-1.5 rounded-lg border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:bg-white/5 transition-colors"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            <ChevronDown size={12} className="opacity-60" />
          </button>
          <button className="cursor-pointer flex items-center justify-center h-7 w-7 rounded-lg text-neutral-400 hover:text-neutral-100 hover:bg-white/5 transition-colors">
            <Maximize2 size={14} />
          </button>
          <button className="cursor-pointer flex items-center justify-center h-7 w-7 rounded-lg text-neutral-400 hover:text-neutral-100 hover:bg-white/5 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto bg-black">
        {view === "code" ? (
          <div className="font-mono text-[13px] leading-[1.65] py-2">
            {lines.map((line, idx) => (
              <div
                key={idx}
                onMouseEnter={() => setHoverLine(idx)}
                onMouseLeave={() => setHoverLine((h) => (h === idx ? null : h))}
                className="group relative flex px-2 hover:bg-white/[0.035]"
              >
                <span className="select-none w-10 shrink-0 text-right pr-3 text-neutral-600">
                  {idx + 1}
                </span>
                <button
                  onClick={() => setCommentingLine(idx)}
                  title="Add comment"
                  className={`cursor-pointer absolute left-8 top-1/2 -translate-y-1/2 flex items-center justify-center h-4 w-4 rounded-full bg-neutral-100 text-black transition-opacity ${
                    hoverLine === idx ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <Plus size={10} strokeWidth={3} />
                </button>
                <span className="whitespace-pre-wrap break-words text-neutral-200">
                  {highlight(line) || "\u00A0"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-[13px] text-neutral-500">
            Live preview would render here.
          </div>
        )}
      </div>

      {commentingLine !== null && (
        <div className="border-t border-neutral-800 bg-neutral-950 p-3">
          <div className="text-[11px] text-neutral-500 mb-1.5">
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
              className="flex-1 bg-black border border-neutral-800 rounded-lg px-3 py-1.5 text-[13px] text-neutral-100 outline-none focus:border-neutral-500"
            />
            <button
              onClick={() => submitComment(commentingLine)}
              className="cursor-pointer text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-neutral-100 text-black disabled:opacity-40"
              disabled={!draft.trim()}
            >
              Reply
            </button>
            <button
              onClick={() => setCommentingLine(null)}
              className="cursor-pointer text-[12.5px] px-2 py-1.5 rounded-lg text-neutral-400 hover:text-neutral-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {Object.keys(comments).length > 0 && (
        <div className="border-t border-neutral-800 divide-y divide-neutral-800">
          {Object.entries(comments).map(([lineIdx, notes]) =>
            notes.map((note, i) => (
              <div key={`${lineIdx}-${i}`} className="px-4 py-2 text-[12.5px]">
                <span className="text-neutral-500">Line {Number(lineIdx) + 1} · </span>
                <span className="text-neutral-200">{note}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function Demo() {
  return (
    <div className="min-h-[500px] w-full flex items-center justify-center p-6 bg-neutral-950">
      <CodePreviewPanel filename="SettingsContent" language="TSX" code={SAMPLE_CODE} />
    </div>
  );
}
