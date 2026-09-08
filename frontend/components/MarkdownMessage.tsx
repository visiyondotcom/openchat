"use client";

import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import "katex/dist/katex.min.css";
import { Download, Eye, Pencil, Code2, Loader2, FileText, Play, Terminal, Plus, ChevronDown } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { useChatStore } from "@/lib/store";
import { useRouter } from "next/navigation";
import { getStudioProject, saveStudioFiles, runPythonSnippet } from "@/lib/api";
import { GENERATED_FILE_DRAG_MIME } from "@/lib/api";

// Languages the "Run" button executes in the sandbox (see
// backend/src/routes/tools.ts POST /tools/run-python). Deliberately just
// python for now — that's the only language the sandbox executor image
// (sandbox-runner/executor/, python:3.12-slim) can actually run.
const RUNNABLE_LANGUAGES = new Set(["python", "py"]);

// Languages the right-side live preview panel knows how to render.
const PREVIEWABLE_LANGUAGES: Record<string, string> = {
  html: "index.html",
  css: "style.css",
  js: "script.js",
  javascript: "script.js",
};

function downloadCode(value: string, fileName: string) {
  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadImage(dataUrl: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `visiyon-image-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Wraps a generated image with a hover overlay offering Download (always)
// and Edit (when the prompt that produced it is known — re-fills the
// composer so the user can tweak and regenerate).
function GeneratedImage({
  src,
  alt,
  imagePrompt,
  onEditImage,
  onOpenImage,
}: {
  src: string;
  alt?: string;
  imagePrompt?: string;
  onEditImage?: (prompt: string) => void;
  onOpenImage?: (src: string, alt: string | undefined, prompt: string | undefined) => void;
}) {
  return (
    <span className="relative inline-block group my-1 max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || "Generated image"}
        role={onOpenImage ? "button" : undefined}
        tabIndex={onOpenImage ? 0 : undefined}
        onClick={onOpenImage ? () => onOpenImage(src, alt, imagePrompt) : undefined}
        onKeyDown={
          onOpenImage
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenImage(src, alt, imagePrompt);
                }
              }
            : undefined
        }
        className={`rounded-lg max-w-full block ${onOpenImage ? "cursor-zoom-in" : ""}`}
      />
      <span data-pdf-exclude className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            downloadImage(src);
          }}
          title="Download"
          className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-visiyon-text backdrop-blur-sm"
        >
          <Download size={14} />
        </button>
        {onEditImage && imagePrompt && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditImage(imagePrompt);
            }}
            title="Edit prompt & regenerate"
            className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-visiyon-text backdrop-blur-sm"
          >
            <Pencil size={14} />
          </button>
        )}
      </span>
    </span>
  );
}

// Extracts the {token} the create_file tool encodes in the download link
// (see BUILTIN_HANDLERS.create_file in backend/src/lib/tools.ts:
// `[safeName](/api/files/token)`) regardless of whether it's served via
// /api/files or bare /files.
function parseGeneratedFileHref(href: string): { token: string } | null {
  const match = href.match(/\/files\/([a-f0-9-]{36})(?:\?|$)/i);
  return match ? { token: match[1] } : null;
}

// Renders a generated-file download link as a small draggable chip instead
// of a plain text link — clicking it still downloads as before, but it can
// also be dragged onto the connected-server file browser panel (see
// ServerFilesPanel) to save it directly there instead.
function GeneratedFileChip({ href, token, label }: { href: string; token: string; label: string }) {
  const [dragging, setDragging] = useState(false);
  return (
    <a
      href={href}
      download
      draggable
      onDragStart={(e) => {
        setDragging(true);
        e.dataTransfer.setData(GENERATED_FILE_DRAG_MIME, JSON.stringify({ token, filename: label }));
        e.dataTransfer.setData("text/plain", label);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={() => setDragging(false)}
      className={`inline-flex items-center gap-1.5 my-0.5 px-2.5 py-1.5 rounded-lg border border-visiyon-border bg-visiyon-text/[0.04] hover:bg-visiyon-text/[0.08] text-[13px] no-underline cursor-grab active:cursor-grabbing transition-opacity ${
        dragging ? "opacity-40" : ""
      }`}
      title="Click to download, or drag onto the server files panel to save it there"
    >
      <FileText size={14} className="text-visiyon-text-3 shrink-0" />
      {label}
    </a>
  );
}

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    // Mermaid syntax is only guaranteed complete once the block has
    // stopped streaming — rendering on every partial token means most
    // attempts throw on invalid/incomplete syntax, and on each failed
    // attempt mermaid still injects an error-diagram SVG into
    // document.body (it doesn't throw before doing that), so those pile
    // up across the page over a long stream. Wait for streaming to
    // finish before ever calling render().
    if (isStreaming) return;
    let cancelled = false;
    // Mermaid appends its error SVG to document.body under an id starting
    // with "d" + the diagram id when rendering fails. Track ids we hand
    // out for this instance and sweep any stray node it left behind after
    // a failed render call, in case a scenario still slips through.
    let lastId: string | null = null;
    const sweepErrorNode = () => {
      if (!lastId) return;
      const stray = document.getElementById("d" + lastId);
      if (stray && stray.parentElement === document.body) stray.remove();
    };
    import("mermaid").then(async (mermaid) => {
      mermaid.default.initialize({ startOnLoad: false, theme: "dark" });
      try {
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        lastId = id;
        const { svg } = await mermaid.default.render(id, code);
        if (!cancelled) setSvg(svg);
        sweepErrorNode();
      } catch {
        sweepErrorNode();
        if (!cancelled) setSvg("");
      }
    });
    return () => {
      cancelled = true;
      sweepErrorNode();
    };
  }, [code, isStreaming]);

  if (isStreaming || !svg) return <pre className="text-xs text-visiyon-text-2">{code}</pre>;
  return <div ref={ref} className="my-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// Tracks the app's light/dark/midnight theme (see ThemeToggle.tsx — a
// class on <html> plus a "visiyon_theme" localStorage key) so the syntax
// highlighter can switch its color scheme to match instead of staying
// permanently dark, which read as a broken, out-of-place black box on the
// light theme. Only "light" gets the light Prism theme; midnight is still
// a dark background, so it keeps the dark one like the default dark theme.
function useIsLightTheme() {
  const [isLight, setIsLight] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const check = () => setIsLight(root.classList.contains("light"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isLight;
}

function CodeBlock({
  language,
  value,
  isStreaming,
  messageId,
}: {
  language: string;
  value: string;
  isStreaming?: boolean;
  messageId: string;
}) {
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ stdout: string; stderr: string; error: string | null } | null>(null);
  // Per-line "+" add-comment affordance (ported from the CodePreviewPanel.jsx
  // prototype, now wired into the real code block used in chat). hoverLine
  // tracks which line is currently moused-over so the "+" only shows on
  // that row; comments are keyed by line index, comment text is local/
  // client-side only (not persisted to the backend).
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  // The "+" button lives at a fixed pixel position on top of the code
  // block, NOT nested inside the hovered line's own element — so moving
  // the mouse from the line onto the button crosses an element boundary
  // and used to fire the line's onMouseLeave immediately, clearing
  // hoverLine (and hiding the button) before the click could land. This
  // small grace-period timeout — cancelled if the button (or another
  // line) is entered in time — bridges that gap so the button doesn't
  // disappear out from under the cursor while moving toward it.
  const hoverLineClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverLineClear = () => {
    if (hoverLineClearRef.current) {
      clearTimeout(hoverLineClearRef.current);
      hoverLineClearRef.current = null;
    }
  };
  const scheduleHoverLineClear = (line: number) => {
    cancelHoverLineClear();
    hoverLineClearRef.current = setTimeout(() => {
      setHoverLine((h) => (h === line ? null : h));
    }, 200);
  };
  useEffect(() => cancelHoverLineClear, []);
  const [comments, setComments] = useState<Record<number, string[]>>({});
  const [commentDraft, setCommentDraft] = useState("");
  const [commentingLine, setCommentingLine] = useState<number | null>(null);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const isLightTheme = useIsLightTheme();
  const openPreview = useChatStore((s) => s.openPreview);
  const router = useRouter();
  const previewFileName = PREVIEWABLE_LANGUAGES[language];
  const isRunnable = RUNNABLE_LANGUAGES.has(language.toLowerCase());

  // Executes this exact block's code in the isolated sandbox (same
  // container isolation as the run_python tool the AI itself can call —
  // no network, read-only fs, ~8s limit) and shows stdout/stderr inline
  // below the block, terminal-style. One run at a time per block; a new
  // click while one is in flight is a no-op rather than queuing another.
  async function handleRun() {
    if (running) return;
    setRunning(true);
    setRunResult(null);
    try {
      const result = await runPythonSnippet(value);
      setRunResult({ stdout: result.stdout, stderr: result.stderr, error: result.error });
    } catch (err) {
      setRunResult({ stdout: "", stderr: "", error: err instanceof Error ? err.message : "Failed to run script" });
    } finally {
      setRunning(false);
    }
  }

  function submitComment(lineIdx: number) {
    if (!commentDraft.trim()) return;
    setComments((prev) => ({
      ...prev,
      [lineIdx]: [...(prev[lineIdx] || []), commentDraft.trim()],
    }));
    setCommentDraft("");
    setCommentingLine(null);
  }

  // Sends this block straight into the user's Studio project (as the file
  // its language maps to — html -> index.html, css -> style.css, js ->
  // script.js — same mapping the right-side preview panel already uses),
  // then jumps to the Studio editor so the result is immediately visible
  // there instead of the user having to copy/paste it in by hand.
  async function handleImportToStudio() {
    if (!previewFileName || importing) return;
    setImporting(true);
    try {
      const { project } = await getStudioProject();
      const files = { ...project.files, [previewFileName]: value };
      await saveStudioFiles(project.id, files);
      setImported(true);
      setTimeout(() => setImported(false), 1500);
      router.push(`/studio?project=${project.id}`);
    } finally {
      setImporting(false);
    }
  }

  // Auto-open the right-side live preview as soon as a renderable block
  // (html/css/js) appears, then keep pushing updated content in on a
  // throttle (not per-token — that would re-render the iframe's srcDoc
  // on every single token, which is exactly the kind of per-token cost
  // the streaming perf fix above avoids for the chat itself) so the
  // preview keeps visibly catching up while the AI is still generating,
  // instead of opening once and then sitting frozen until the whole
  // block finishes.
  const openedRef = useRef(false);
  const lastPushedLenRef = useRef(0);
  useEffect(() => {
    if (!previewFileName) return;
    if (!openedRef.current) {
      openedRef.current = true;
      lastPushedLenRef.current = value.length;
      openPreview(messageId, language, value);
      return;
    }
    if (!isStreaming) {
      // Final push once generation finishes, so the last partial chunk
      // (since the last throttled update) always makes it in.
      lastPushedLenRef.current = value.length;
      openPreview(messageId, language, value);
      return;
    }
    // While streaming: only push again once enough new content has come
    // in since the last push, so updates stay throttled instead of firing
    // on every token.
    if (value.length - lastPushedLenRef.current < 40) return;
    const t = setTimeout(() => {
      lastPushedLenRef.current = value.length;
      openPreview(messageId, language, value);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isStreaming]);

  if (language === "mermaid") return <MermaidBlock code={value} isStreaming={isStreaming} />;

  // While a message is still streaming, the code block grows by one token
  // at a time. Re-running Prism's full tokenizer on every token makes each
  // update cost O(block length), so a long block streaming in becomes
  // O(n²) overall and the UI visibly stalls. Render plain, unhighlighted
  // text during the live phase — cheap regardless of length — and only
  // pay for syntax highlighting once, after the message finishes.
  if (isStreaming) {
    return (
      <div className="relative group">
        <pre className="text-[13.5px] leading-relaxed overflow-x-auto">
          <code>{value}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="relative group">
      <div data-pdf-exclude className="absolute top-2 right-2 z-20 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isRunnable && (
          <button
            onClick={handleRun}
            disabled={running}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors disabled:opacity-60"
            title="Run this script"
          >
            {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            Run
          </button>
        )}
        {previewFileName && (
          <button
            onClick={() => openPreview(messageId, language, value)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors"
            title="Show preview"
          >
            <Eye size={11} /> Preview
          </button>
        )}
        {previewFileName && (
          <button
            onClick={handleImportToStudio}
            disabled={importing}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors disabled:opacity-60"
            title={`Send to Studio as ${previewFileName}`}
          >
            {importing ? <Loader2 size={11} className="animate-spin" /> : <Code2 size={11} />}
            {imported ? "Sent" : "Studio"}
          </button>
        )}
        <button
          onClick={() => downloadCode(value, previewFileName || `snippet.${language || "txt"}`)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors"
          title={`Download as ${previewFileName || `snippet.${language || "txt"}`}`}
        >
          <Download size={11} />
        </button>
        <div className="relative">
          <button
            onClick={() => {
              copyToClipboard(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors"
          >
            {copied ? "Copied" : "Copy"}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setCopyMenuOpen((v) => !v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCopyMenuOpen((v) => !v);
                }
              }}
              className="-mr-1 pl-0.5"
            >
              <ChevronDown size={12} className="opacity-60" />
            </span>
          </button>
          {copyMenuOpen && (
            <div
              data-pdf-exclude
              className="absolute right-0 top-[calc(100%+4px)] w-40 bg-visiyon-panel border border-visiyon-border rounded-lg shadow-lg py-1 z-20"
              onMouseLeave={() => setCopyMenuOpen(false)}
            >
              <button
                onClick={() => {
                  copyToClipboard(value);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                  setCopyMenuOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.06]"
              >
                Copy code
              </button>
              <button
                onClick={() => {
                  copyToClipboard(`\`\`\`${language || ""}\n${value}\n\`\`\``);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                  setCopyMenuOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.06]"
              >
                Copy as Markdown
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="relative">
        <SyntaxHighlighter
          language={language || "text"}
          style={isLightTheme ? oneLight : oneDark}
          customStyle={{ background: "transparent", fontSize: 13.5, lineHeight: 1.65, padding: 0, margin: 0 }}
          codeTagProps={{ style: { background: "transparent" } }}
          showLineNumbers
          lineNumberStyle={{
            minWidth: "2.5em",
            paddingRight: "1em",
            textAlign: "right",
            userSelect: "none",
            opacity: 0.35,
          }}
          wrapLines
          lineProps={(lineNumber) => ({
            onMouseEnter: () => {
              cancelHoverLineClear();
              setHoverLine(lineNumber - 1);
            },
            onMouseLeave: () => scheduleHoverLineClear(lineNumber - 1),
            style: { position: "relative", display: "block", paddingLeft: "1.25em" },
          })}
        >
          {value}
        </SyntaxHighlighter>
        {hoverLine !== null && (
          <button
            data-pdf-exclude
            onClick={() => setCommentingLine(hoverLine)}
            onMouseEnter={cancelHoverLineClear}
            onMouseLeave={() => scheduleHoverLineClear(hoverLine)}
            title="Add comment"
            style={{ top: `${hoverLine * 1.65 * 13.5 + 13.5 * 1.65 * 0.5}px` }}
            className="cursor-pointer absolute left-0 -translate-y-1/2 flex items-center justify-center h-4 w-4 rounded-full bg-visiyon-text text-visiyon-bg"
          >
            <Plus size={10} strokeWidth={3} />
          </button>
        )}
      </div>
      {commentingLine !== null && (
        <div data-pdf-exclude className="mt-2 rounded-lg border border-visiyon-border bg-visiyon-panel2 p-3">
          <div className="text-[11px] text-visiyon-text-3 mb-1.5">Comment on line {commentingLine + 1}</div>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitComment(commentingLine);
                if (e.key === "Escape") setCommentingLine(null);
              }}
              placeholder="Leave a comment…"
              className="flex-1 bg-visiyon-bg border border-visiyon-border rounded-lg px-3 py-1.5 text-[13px] text-visiyon-text outline-none focus:border-visiyon-text/30"
            />
            <button
              onClick={() => submitComment(commentingLine)}
              disabled={!commentDraft.trim()}
              className="cursor-pointer text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-visiyon-text text-visiyon-bg disabled:opacity-40"
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
      {Object.keys(comments).length > 0 && (
        <div data-pdf-exclude className="mt-2 rounded-lg border border-visiyon-border divide-y divide-visiyon-border">
          {Object.entries(comments).map(([lineIdx, notes]) =>
            notes.map((note, i) => (
              <div key={`${lineIdx}-${i}`} className="px-3 py-2 text-[12.5px]">
                <span className="text-visiyon-text-3">Line {Number(lineIdx) + 1} · </span>
                <span className="text-visiyon-text">{note}</span>
              </div>
            ))
          )}
        </div>
      )}
      {isRunnable && (running || runResult) && (
        <div className="mt-2 rounded-lg border border-visiyon-border bg-black/40 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-visiyon-text-2 border-b border-visiyon-border">
            <Terminal size={11} />
            Output
          </div>
          <div className="px-3 py-2 text-[13px] font-mono whitespace-pre-wrap max-h-[300px] overflow-y-auto">
            {running && !runResult && <span className="text-visiyon-text-2">Running…</span>}
            {runResult?.stdout && <div>{runResult.stdout}</div>}
            {runResult?.stderr && <div className="text-red-400">{runResult.stderr}</div>}
            {runResult?.error && !runResult.stdout && !runResult.stderr && (
              <div className="text-red-400">{runResult.error}</div>
            )}
            {runResult && !runResult.stdout && !runResult.stderr && !runResult.error && (
              <span className="text-visiyon-text-2">(no output)</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Reveals `content` gradually while streaming instead of snapping straight
// to whatever the last network chunk delivered — the backend can deliver
// tokens in uneven bursts, which without this looks like text "jumping" in
// rather than the smooth, steady character-by-character typing Claude
// shows. Historical (non-streaming) messages render instantly, unaffected.
function useSmoothStream(content: string, isStreaming: boolean | undefined, messageId: string) {
  const [displayed, setDisplayed] = useState(content);
  const targetRef = useRef(content);
  targetRef.current = content;

  // Switching to a different message (new message, or a regenerate that
  // reused the same slot with a shorter/different string) — snap instantly
  // rather than animating from stale leftover state.
  useEffect(() => {
    setDisplayed(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  useEffect(() => {
    if (!isStreaming) {
      setDisplayed(content);
      return;
    }
    let rafId: number;
    let last = performance.now();
    function tick(now: number) {
      const dt = now - last;
      last = now;
      setDisplayed((prev) => {
        const target = targetRef.current;
        // Safety net: if the target ever isn't a continuation of what's
        // shown (e.g. an edit swapped in different text mid-stream), snap
        // instead of trying to animate backwards.
        if (!target.startsWith(prev)) return target;
        if (prev.length >= target.length) return prev;
        const behind = target.length - prev.length;
        // Baseline pace ~45 chars/sec, but catches up faster the further
        // behind it falls so a big buffered burst doesn't visibly lag.
        const reveal = Math.max(1, Math.round(dt * 0.045), Math.ceil(behind / 5));
        return target.slice(0, prev.length + reveal);
      });
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, messageId]);

  return isStreaming ? displayed : content;
}

export default function MarkdownMessage({
  content,
  isStreaming,
  messageId,
  imagePrompt,
  onEditImage,
  onOpenImage,
}: {
  content: string;
  isStreaming?: boolean;
  messageId: string;
  // The user prompt that produced a generated image in this message, if
  // any — enables the "Edit" button on the image overlay.
  imagePrompt?: string;
  onEditImage?: (prompt: string) => void;
  // Opens the fullscreen viewer (see ImageLightbox) for a generated image.
  onOpenImage?: (src: string, alt: string | undefined, prompt: string | undefined) => void;
}) {
  const displayedContent = useSmoothStream(content, isStreaming, messageId);
  return (
    <div className="prose-visiyon">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        // react-markdown's default URL sanitizer only allows a fixed list of
        // safe schemes (http, https, mailto, ...) and silently strips
        // anything else — including data: URIs. Generated images are
        // embedded as `![Generated image](data:image/png;base64,...)`
        // (see backend/src/routes/images.ts), so without this override the
        // <img> tag ends up with no src at all and just shows a broken
        // image icon. Keep the default behavior for every other URL type,
        // only special-case data:image/*.
        urlTransform={(url) => (url.startsWith("data:image/") ? url : defaultUrlTransform(url))}
        components={{
          img({ src, alt }) {
            if (!src || typeof src !== "string") return null;
            return (
              <GeneratedImage src={src} alt={alt} imagePrompt={imagePrompt} onEditImage={onEditImage} onOpenImage={onOpenImage} />
            );
          },
          a({ href, children }) {
            const parsed = href && typeof href === "string" ? parseGeneratedFileHref(href) : null;
            if (parsed) {
              const firstChild = React.Children.toArray(children)[0];
              const label = typeof firstChild === "string" ? firstChild : parsed.token;
              return <GeneratedFileChip href={href!} token={parsed.token} label={label} />;
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = Boolean(match);
            if (!isBlock) {
              return (
                <code
                  className="bg-[rgb(214,68,53)]/[0.12] text-[rgb(214,68,53)] px-1.5 py-0.5 rounded text-[13px] font-semibold font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock
                language={match![1]}
                value={String(children).replace(/\n$/, "")}
                isStreaming={isStreaming}
                messageId={messageId}
              />
            );
          },
        }}
      >
        {displayedContent}
      </ReactMarkdown>
    </div>
  );
}
