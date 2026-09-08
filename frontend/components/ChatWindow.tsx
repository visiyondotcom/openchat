"use client";

import { useEffect, useMemo, useRef, useState, memo } from "react";
import { useRouter } from "next/navigation";
import { getChat, streamMessage, createChat, listChatDocuments, listChatTools, ToolEvent, transcribeAudio, speakText, getVoiceConfig, imageGenConfig, generateChatImage, shareChat, unshareChat, listAvailableActions, runAction, setChatParameters, editMessage, rateMessage, getTodayUsage, TodayUsage, uploadDocument, attachDocument, detachDocument, documentDownloadUrl, getPublicConfigCached, listModels, pinChat, archiveChat, deleteChat, renameChat, setChatAgentMode, improvePrompt, getDefaultModel } from "@/lib/api";
import { askConfirm } from "@/components/PromptDialog";
import { notifyReplyReady } from "@/lib/notificationPref";
import { useRequireAuth } from "@/lib/useAuth";
import { safeRandomUUID } from "@/lib/uuid";
import { copyToClipboard } from "@/lib/clipboard";
import { formatRelativeAgo, formatFullTimestamp } from "@/lib/format";
import BuyCreditsModal from "@/components/BuyCreditsModal";
import { useChatStore, ChatMessage } from "@/lib/store";
import { getPromptHistory, addPromptToHistory, removePromptFromHistory } from "@/lib/promptHistory";
import MarkdownMessage from "./MarkdownMessage";
import ImageLightbox from "./ImageLightbox";
import ThinkingBlock from "./ThinkingBlock";
import ModelSelector from "./ModelSelector";
import NotifyBanner from "./NotifyBanner";
import DocumentPanel from "./DocumentPanel";
import PromptLibrary from "./PromptLibrary";
import ToolsPanel from "./ToolsPanel";
import LocationBanner, { readStoredLocation } from "./LocationBanner";
import PreviewPanel from "./PreviewPanel";
import ServerFilesPanel from "./ServerFilesPanel";
import ChatControlsPanel from "./ChatControlsPanel";
import GeneratingImageCard from "./GeneratingImageCard";
import { Square, RotateCcw, ArrowDownToLine, Globe, Wrench, Mic, Volume2, Loader2, Image as ImageIcon, ImagePlus, Share2, Check, Link2, Zap, X, Menu, Pencil, ThumbsUp, ThumbsDown, Copy, Plus, AlertTriangle, FileDown, FileText, HardDrive, Camera, ScreenShare, Maximize2, MoreHorizontal, Pin, PinOff, Archive, ArchiveRestore, Trash2, FolderOpen, Bot, ChevronDown, PictureInPicture2, Wand2 } from "lucide-react";
import { AIFaceAvatar, parseAvatarDirectives, type AvatarExpression, type AvatarTrigger } from "./AIFaceAvatar";
import SparkleAvatarIcon from "./SparkleAvatarIcon";
import { exportMessageToPdf } from "@/lib/exportPdf";

// Lets people just type "draw a..." / "generate an image of..." without
// first having to toggle the "Generate image" option by hand — the
// toggle still exists for anyone who wants to force it either way.
const IMAGE_INTENT_RE =
  /^(draw|sketch|paint|render)\b|\b(generate|create|make)\b.{0,30}\b(image|picture|photo|illustration|drawing|artwork|logo|icon|wallpaper)\b|\bimage of\b|\bpicture of\b/i;

// Waveform icon used on the send button — 5 bars, black on the white
// button background. When `active` is true (message sent / generating),
// each bar plays a staggered wave animation for a polished "live" feel.
function SendWaveIcon({ size = 16, active = false }: { size?: number; active?: boolean }) {
  const bars = [
    { x: 1.5, h: 6 },
    { x: 6.1, h: 10 },
    { x: 10.7, h: 14 },
    { x: 15.3, h: 10 },
    { x: 19.9, h: 6 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g className={active ? "send-wave-bars--active" : ""}>
        {bars.map((bar, i) => (
          <rect
            key={i}
            className="send-wave-bar"
            x={bar.x}
            y={12 - bar.h / 2}
            width="2.6"
            height={bar.h}
            rx="1.3"
            fill="currentColor"
          />
        ))}
      </g>
    </svg>
  );
}

function looksLikeImageRequest(text: string): boolean {
  return IMAGE_INTENT_RE.test(text.trim());
}

// Cycled, typewriter-style placeholder shown on the empty landing screen
// (input placeholder falls back to a plain "Ask anything" once the chat
// has messages or the user starts typing).
const PLACEHOLDER_PHRASES = [
  "Ask anything",
  "Draw a cat astronaut floating in space",
  "Summarize a document",
  "Write some code",
  "Plan a weekend trip",
  "Explain a tricky concept simply",
];

// Quick-start suggestions: shown alongside the user's own prompt
// history, similar to search-engine style suggestions.
const QUICK_SUGGESTIONS = [
  "Explain this like I'm 12",
  "Summarize this in 5 bullets",
  "Write an email about",
  "What are the pros and cons of",
  "Help me debug:",
  "Translate this to English",
  "Give me ideas for",
  "Write code to",
];

type Suggestion = { text: string; type: "history" | "quick" };

// ---- MessageBubble --------------------------------------------------
// Extracted from ChatWindow's messages.map() and wrapped in React.memo.
//
// Why: appendToLastAssistant() fires on every streamed token and always
// creates a *new* `messages` array reference. Without memoization here,
// that new reference makes React re-render every bubble in the list on
// every single token — including old, already-finished messages, whose
// <MarkdownMessage> would then needlessly re-run its full markdown parse
// each time too. For a long conversation with a long reply streaming in,
// that's an O(messages x content length) cost paid per token, which is
// exactly the stall visible while a big code block streams in.
//
// The custom comparator below skips a re-render whenever nothing that
// bubble actually displays has changed. `m` only gets a new object
// reference for the message currently being appended to (see
// appendToLastAssistant in lib/store.ts), so unrelated bubbles keep the
// same `m` reference across renders and bail out immediately. The
// interactive props (copiedId, speakingId, editingId, ...) are compared
// by value, not by which specific row they belong to, so a click on one
// row's copy/rate/edit button only re-renders that row and the row (if
// any) that just lost the highlighted state.
interface MessageBubbleProps {
  m: ChatMessage;
  i: number;
  isLast: boolean;
  // True for the most recent USER message specifically (unlike `isLast`,
  // which is true only when nothing at all comes after it) — used to show
  // Retry on the last thing the user sent even once it already has a
  // reply below it.
  isLastUserMessage: boolean;
  isStreaming: boolean;
  activeTool: ToolEvent | null;
  editingId: string | null;
  editText: string;
  setEditText: (v: string) => void;
  setEditingId: (id: string | null) => void;
  submitEdit: (id: string) => void;
  cancelEdit: () => void;
  copiedId: string | null;
  copyMessage: (text: string, id: string) => void;
  exportingId: string | null;
  onExportPdf: (id: string) => void;
  speakingId: string | null;
  playText: (text: string, id: string) => void;
  toggleRating: (id: string, value: 1 | -1) => void;
  availableActions: { id: string; slug: string; name: string; icon: string }[];
  runningActionId: string | null;
  actionResult: { messageId: string; text: string } | null;
  handleRunAction: (actionId: string, messageId: string, content: string) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  // The prompt that produced this bubble's generated image (undefined for
  // ordinary text replies) and the handler to re-fill the composer with it.
  imagePrompt?: string;
  onEditImage: (prompt: string) => void;
  onOpenImage: (src: string, alt: string | undefined, prompt: string | undefined) => void;
  ttsEnabled: boolean;
  // Display name for the caption under USER bubbles — replaces the
  // generic "You" label. Falls back to "You" if not yet loaded.
  userName: string;
  // Uploaded profile photo (Settings > Profile) shown next to the name +
  // timestamp caption under USER bubbles. Undefined/null just omits it.
  userAvatarUrl?: string | null;
  // Raw model name -> admin display name, so the caption under ASSISTANT
  // bubbles shows the friendly name instead of the raw "jean:latest" tag.
  modelDisplayNames: Record<string, string>;
}

// ---- GenerationProgress -----------------------------------------------
// Thin bottom-edge progress line + a small ring/percentage badge on the
// right, shown on whichever bubble is currently "live" (the user bubble
// while the assistant is still thinking, then the assistant bubble once
// its answer starts streaming in). There's no real token budget to
// measure against, so this eases toward ~92% while active and only
// reaches 100% the instant generation actually finishes (at which point
// the bubble stops rendering it) — same idea as a browser loading bar.
function GenerationProgress() {
  const [pct, setPct] = useState(4);
  useEffect(() => {
    const id = setInterval(() => {
      setPct((p) => Math.min(92, p + (92 - p) * 0.06 + 0.4));
    }, 180);
    return () => clearInterval(id);
  }, []);
  const clamped = Math.min(92, Math.round(pct));
  const r = 9;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - clamped / 100);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -bottom-2.5 left-1 right-1 flex items-center gap-1.5"
    >
      <div className="relative flex-1 h-[2px] rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-500/30 to-emerald-400/90 transition-[width] duration-200 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="relative shrink-0 h-[22px] w-[22px]">
        <svg viewBox="0 0 22 22" className="h-[22px] w-[22px] -rotate-90">
          <circle cx="11" cy="11" r={r} fill="rgba(15,20,18,0.55)" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
          <circle
            cx="11"
            cy="11"
            r={r}
            fill="none"
            stroke="rgb(52,211,153)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset] duration-200 ease-out"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[7px] font-medium text-emerald-300">
          {clamped}
        </span>
      </div>
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({
  m,
  i,
  isLast,
  isLastUserMessage,
  isStreaming,
  activeTool,
  editingId,
  editText,
  setEditText,
  setEditingId,
  submitEdit,
  cancelEdit,
  copiedId,
  copyMessage,
  exportingId,
  onExportPdf,
  speakingId,
  playText,
  toggleRating,
  availableActions,
  runningActionId,
  actionResult,
  handleRunAction,
  onRegenerate,
  onContinue,
  imagePrompt,
  onEditImage,
  onOpenImage,
  ttsEnabled,
  userName,
  userAvatarUrl,
  modelDisplayNames,
}: MessageBubbleProps) {
  // Auto-grow the edit textarea the same way the main composer does
  // (scrollHeight-based) instead of only counting "\n" characters — a
  // counting-only approach doesn't account for long lines that wrap
  // without an explicit newline, so the box would stay too short and the
  // text would sit clipped/scrolling inside it rather than the box
  // growing to fit, like Claude's edit box does.
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (editingId !== m.id) return;
    const el = editTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 240; // px, matches the composer's own auto-grow cap
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [editText, editingId, m.id]);

  // Auto-grow the edit box's WIDTH too, the way Claude's edit box does:
  // starts just wide enough for a short line, then widens as you type,
  // up to the same max the message bubble itself uses, instead of always
  // snapping to the full bubble width even for a two-word edit. Measured
  // via a hidden same-font mirror element rather than canvas metrics —
  // simpler and stays exactly in sync with the textarea's own font/size
  // changes (zoom, custom font setting, etc).
  const editContainerRef = useRef<HTMLDivElement | null>(null);
  const editMirrorRef = useRef<HTMLDivElement | null>(null);
  const [editWidth, setEditWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (editingId !== m.id) return;
    const mirror = editMirrorRef.current;
    const container = editContainerRef.current;
    if (!mirror || !container) return;
    const measure = () => {
      mirror.textContent = editText || " ";
      const horizontalPadding = 34; // px-4 (16px) * 2 + border (1px) * 2
      const minWidth = 140;
      const maxWidth = container.offsetWidth; // container is capped at max-w-[85%]
      const wanted = mirror.scrollWidth + horizontalPadding;
      setEditWidth(Math.max(minWidth, Math.min(wanted, maxWidth)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [editText, editingId, m.id]);

  return (
    <div className={`mb-6 flex flex-col visiyon-message-appear ${m.role === "USER" ? "items-end" : "items-start"} group`}>
      {m.role === "USER" && editingId === m.id ? (
        <div ref={editContainerRef} className="w-full max-w-[85%] space-y-2 flex flex-col items-end">
          {/* Hidden mirror used only to measure the natural width of the
              current text — same font/size as the textarea, never shown. */}
          <div
            ref={editMirrorRef}
            aria-hidden
            className="text-[14.5px] leading-snug whitespace-pre"
            style={{ position: "absolute", visibility: "hidden", top: -9999, left: -9999, pointerEvents: "none" }}
          />
          <textarea
            ref={editTextareaRef}
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitEdit(m.id);
              } else if (e.key === "Escape") {
                cancelEdit();
              }
            }}
            rows={1}
            style={{ width: editWidth ? `${editWidth}px` : undefined }}
            className="max-h-[240px] bg-visiyon-text/[0.05] text-visiyon-text text-[14.5px] leading-snug outline-none resize-none border border-white/15 rounded-[12px] px-4 py-2.5"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={cancelEdit}
              className="text-[12.5px] px-3 py-1.5 rounded-lg text-white/60 hover:text-visiyon-text transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => submitEdit(m.id)}
              disabled={!editText.trim() || isStreaming}
              className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-white text-black disabled:opacity-40"
            >
              Save & submit
            </button>
          </div>
        </div>
      ) : (
        <>
          {m.role === "USER" && m.documents && m.documents.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-2 justify-end">
              {m.documents.map((doc) => {
                const ext = doc.filename.split(".").pop()?.toUpperCase() || "FILE";
                return (
                  <a
                    key={doc.id}
                    href={documentDownloadUrl(doc.id)}
                    download={doc.filename}
                    title={`${doc.filename} downloaden`}
                    className="flex items-center gap-2 h-14 pl-2.5 pr-3 rounded-xl border border-white/10 bg-white/[0.04] text-visiyon-text-2 no-underline hover:bg-white/[0.07] transition-colors cursor-pointer"
                  >
                    <div className="shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-white/[0.06]">
                      <FileText size={16} className="text-visiyon-text-2" />
                    </div>
                    <div className="min-w-0 max-w-[140px]">
                      <div className="text-[12.5px] font-medium text-visiyon-text truncate">{doc.filename}</div>
                      <div className="text-[11px] text-visiyon-text-3">{ext}</div>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
          {m.role === "USER" && m.images && m.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5 justify-end">
              {m.images.map((img, idx) => {
                const src = `data:image/png;base64,${img}`;
                return (
                  <img
                    key={idx}
                    src={src}
                    alt="Attached"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenImage?.(src, "Attached", undefined)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenImage?.(src, "Attached", undefined);
                      }
                    }}
                    className="h-24 w-24 object-cover rounded-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.4)] cursor-zoom-in"
                  />
                );
              })}
            </div>
          )}
          {(m.role !== "USER" || (m.content && m.content.trim())) && (
          <div
            id={m.role === "ASSISTANT" ? `msg-content-${m.id}` : undefined}
            className={`relative max-w-[80%] ${m.role === "USER" ? "rounded-[20px]" : "rounded-[12px]"} px-4 py-2.5 text-[14.5px] leading-relaxed text-visiyon-text ${
              m.role === "USER" ? "bg-visiyon-panel2" : ""
            }`}
          >
          {m.role === "USER" && (
            <>
              <div className="absolute -bottom-px -right-[7px] w-5 h-6 bg-visiyon-panel2 rounded-bl-2xl pointer-events-none" />
              <div className="absolute -bottom-px -right-2.5 w-2.5 h-6 bg-visiyon-bg rounded-bl-xl pointer-events-none" />
            </>
          )}
          {isLast && isStreaming && <GenerationProgress />}
          {m.role === "ASSISTANT" && isLast && activeTool && (
            <div className="mb-2 flex items-center gap-1.5 text-[12px] text-visiyon-text-3">
              <Wrench size={12} /> Used <span className="text-visiyon-text-2">{activeTool.name}</span>
            </div>
          )}
          {m.role === "ASSISTANT" ? (
            m.content ? (
              <MarkdownMessage
                content={m.content}
                isStreaming={isStreaming && isLast}
                messageId={m.id}
                imagePrompt={imagePrompt}
                onEditImage={onEditImage}
                onOpenImage={onOpenImage}
              />
            ) : null
          ) : (
            m.content
          )}
          {m.role === "ASSISTANT" && m.content && ttsEnabled && (!isStreaming || !isLast) && (
            <button
              onClick={() => playText(m.content, m.id)}
              className="mt-2 flex items-center gap-1.5 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors opacity-0 group-hover:opacity-100"
              title="Read aloud (Piper, local)"
            >
              <Volume2 size={13} />
              {speakingId === m.id ? "Stop" : "Read aloud"}
            </button>
          )}
          {m.role === "ASSISTANT" && m.content && (!isStreaming || !isLast) && (
            <span className="inline-flex items-center gap-3 mt-2 mr-3 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => copyMessage(m.content, m.id)}
                className="flex items-center gap-1 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors"
                title="Copy"
              >
                {copiedId === m.id ? <Check size={13} /> : <Copy size={13} />}
              </button>
              <button
                onClick={() => toggleRating(m.id, 1)}
                className="flex items-center gap-1 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors"
                title="Good response"
              >
                <ThumbsUp size={13} fill={m.rating === 1 ? "currentColor" : "none"} />
              </button>
              <button
                onClick={() => toggleRating(m.id, -1)}
                className="flex items-center gap-1 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors"
                title="Bad response"
              >
                <ThumbsDown size={13} fill={m.rating === -1 ? "currentColor" : "none"} />
              </button>
              <button
                onClick={() => onExportPdf(m.id)}
                disabled={exportingId === m.id}
                className="flex items-center gap-1 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors disabled:opacity-50"
                title="Export to PDF"
              >
                {exportingId === m.id ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
              </button>
            </span>
          )}
          {m.role === "ASSISTANT" &&
            m.content &&
            (!isStreaming || !isLast) &&
            (m.promptTokens != null || m.completionTokens != null) && (
              <span className="inline-flex items-center mt-2 mr-3 text-[11px] text-visiyon-text opacity-0 group-hover:opacity-100 transition-opacity">
                {(m.promptTokens ?? 0) + (m.completionTokens ?? 0)} tokens
                {m.promptTokens != null && m.completionTokens != null
                  ? ` (${m.promptTokens} prompt · ${m.completionTokens} completion)`
                  : ""}
              </span>
            )}
          {m.role === "ASSISTANT" && isLast && !isStreaming && m.content && (
            <button
              onClick={onRegenerate}
              className="mt-2 mr-3 flex items-center gap-1.5 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors opacity-0 group-hover:opacity-100"
            >
              <RotateCcw size={13} /> Regenerate
            </button>
          )}
          {m.role === "ASSISTANT" && isLast && !isStreaming && m.content && (
            <button
              onClick={onContinue}
              className="mt-2 flex items-center gap-1.5 text-[12px] text-visiyon-text hover:text-visiyon-text/70 transition-colors opacity-0 group-hover:opacity-100"
              title="Ask the model to keep writing from where it left off"
            >
              <ArrowDownToLine size={13} className="rotate-[-90deg]" /> Continue
            </button>
          )}
          {m.role === "ASSISTANT" && m.content && availableActions.length > 0 && (!isStreaming || !isLast) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              {availableActions.map((a) => (
                <button
                  key={a.id}
                  onClick={() => handleRunAction(a.id, m.id, m.content)}
                  disabled={runningActionId === a.id}
                  className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-visiyon-text/[0.06] text-visiyon-text-3 hover:bg-visiyon-text/[0.12] hover:text-visiyon-text transition-colors disabled:opacity-50"
                  title={a.name}
                >
                  {runningActionId === a.id ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                  {a.name}
                </button>
              ))}
            </div>
          )}
          {actionResult?.messageId === m.id && (
            <div className="mt-2 text-[12.5px] rounded-lg bg-visiyon-text/[0.06] px-3 py-2 text-visiyon-text-2">
              {actionResult.text}
            </div>
          )}
        </div>
          )}
        {m.role === "ASSISTANT" ? (
          isLast && (
            <span className="mt-1 flex items-center gap-2 text-[11px] text-visiyon-text text-left">
              <SparkleAvatarIcon size={22} active={isStreaming && isLast} />
              {((m.steps && m.steps.length > 0) || m.reasoning || (isStreaming && isLast)) && (
                <ThinkingBlock steps={m.steps} reasoning={m.reasoning} isLive={isStreaming && isLast} />
              )}
            </span>
          )
        ) : (
          <span
            className={`mt-1 flex items-center gap-1.5 text-[11px] text-visiyon-text flex-row-reverse text-right opacity-0 group-hover:opacity-100 transition-opacity`}
          >
            {userAvatarUrl ? (
              <img src={userAvatarUrl} alt="" className="w-4 h-4 rounded-full object-cover shrink-0" />
            ) : (
              <span className="w-4 h-4 rounded-full bg-visiyon-text/15 flex items-center justify-center text-[9px] font-medium shrink-0">
                {userName.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="relative group/timestamp">
              {userName}
              {m.createdAt && ` • ${formatRelativeAgo(m.createdAt)}`}
              {m.createdAt && (
                <span className="pointer-events-none absolute bottom-full right-0 mb-1.5 whitespace-nowrap rounded-lg bg-[#2a2a2a] border border-white/10 px-2.5 py-1.5 text-[11px] text-white opacity-0 group-hover/timestamp:opacity-100 transition-opacity shadow-lg z-10">
                  {formatFullTimestamp(m.createdAt)}
                </span>
              )}
            </span>
          </span>
        )}
        </>
      )}
      {m.role === "USER" && editingId !== m.id && !isStreaming && (
        <span className="mt-1.5 flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => copyMessage(m.content, m.id)}
            className="flex items-center gap-1 text-[11.5px] text-white/50 hover:text-visiyon-text transition-colors"
            title="Copy"
          >
            {copiedId === m.id ? <Check size={11} /> : <Copy size={11} />}
            {copiedId === m.id ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => {
              setEditingId(m.id);
              setEditText(m.content);
            }}
            className="flex items-center gap-1 text-[11.5px] text-white/50 hover:text-visiyon-text transition-colors"
            title="Edit message"
          >
            <Pencil size={11} /> Edit
          </button>
          {isLastUserMessage && (
            <button
              onClick={onRegenerate}
              className="flex items-center gap-1 text-[11.5px] text-white/50 hover:text-visiyon-text transition-colors"
              title="Retry — resend this message and generate a new reply"
            >
              <RotateCcw size={11} /> Retry
            </button>
          )}
        </span>
      )}
    </div>
  );
},
(prev, next) => {
  // Bail out (skip re-render) unless something this row actually shows
  // has changed. Function props are intentionally not compared — they're
  // recreated every ChatWindow render regardless, and comparing them
  // would defeat the whole point of this memoization.
  return (
    prev.m === next.m &&
    prev.isLast === next.isLast &&
    prev.isLastUserMessage === next.isLastUserMessage &&
    prev.isStreaming === next.isStreaming &&
    prev.activeTool === next.activeTool &&
    prev.editingId === next.editingId &&
    (prev.editingId !== next.m.id || prev.editText === next.editText) &&
    prev.copiedId === next.copiedId &&
    prev.exportingId === next.exportingId &&
    prev.speakingId === next.speakingId &&
    prev.availableActions === next.availableActions &&
    prev.runningActionId === next.runningActionId &&
    prev.actionResult === next.actionResult &&
    prev.ttsEnabled === next.ttsEnabled &&
    // Without these, a bubble that first rendered before listModels()
    // resolved (modelDisplayNames still {}) would show the raw model tag
    // ("jean:latest") forever — the map filling in afterwards produces a
    // new object reference, but the bail-out above didn't check it, so
    // the caption never updated. Same for userName before the profile
    // name has loaded.
    prev.modelDisplayNames === next.modelDisplayNames &&
    prev.userName === next.userName &&
    prev.userAvatarUrl === next.userAvatarUrl
  );
}
);

// Tiny localStorage cache: last-known model (raw name + friendly
// display name) per chat, so re-opening/refreshing a chat can show the
// model name in the composer instantly instead of it flashing blank
// while getChat()'s network round trip is still in flight.
const CHAT_MODEL_CACHE_PREFIX = "visiyon_chat_model_";
function readCachedChatModel(chatId: string): { model: string; displayName?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CHAT_MODEL_CACHE_PREFIX + chatId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.model === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}
function writeCachedChatModel(chatId: string, model: string, displayName?: string) {
  if (typeof window === "undefined" || !model) return;
  try {
    localStorage.setItem(CHAT_MODEL_CACHE_PREFIX + chatId, JSON.stringify({ model, displayName }));
  } catch {
    // Storage full/unavailable (private browsing etc.) — the label just
    // falls back to waiting for getChat() as before, no harm done.
  }
}

export default function ChatWindow({ chatId }: { chatId?: string }) {
  const router = useRouter();
  // Cached by useRequireAuth at module level once the page-level guard has
  // already verified the session, so this doesn't trigger a second
  // network round trip — it just gives us the display name for captions.
  const { user: currentUser } = useRequireAuth();
  const {
    messages,
    setMessages,
    pushMessage,
    appendToLastAssistant,
    appendReasoningToLastAssistant,
    pushStepToLastAssistant,
    isStreaming,
    setStreaming,
    selectedModel,
    setSelectedModel,
    setCurrentChatId,
    setMobileSidebarOpen,
    justCreatedChatId,
    setJustCreatedChatId,
    desktopSidebarCollapsed,
    setDesktopSidebarCollapsed,
    setMessageRating,
    setLastAssistantUsage,
    updateMessageId,
    bumpChatListVersion,
    isGeneratingImage,
    generatingImagePrompt,
    setGeneratingImage,
    imageMode,
    setImageMode,
    toggleServerPanel,
    serverPanelOpen,
    closePreview,
    showPreview,
    dismissPreview,
    previewOpen,
    previewBlocks,
    previewFileName,
    closeServerPanel,
    chatTitles,
    setChatTitle: setSharedChatTitle,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [limitResetAt, setLimitResetAt] = useState<string | null>(null);
  const [usage, setUsage] = useState<TodayUsage | null>(null);
  const [limitWarningDismissed, setLimitWarningDismissed] = useState(false);
  const [attachedDocIds, setAttachedDocIds] = useState<string[]>([]);
  // Doc ids that already appear on a sent USER message this session — once
  // a doc has been "sent" it moves out of the composer's chip row (it now
  // shows in the message bubble instead, like images already do) while
  // staying attached chat-wide in attachedDocIds/attachedDocsMeta for RAG.
  const sentDocIds = useMemo(() => {
    const s = new Set<string>();
    messages.forEach((m) => m.documents?.forEach((d) => s.add(d.id)));
    return s;
  }, [messages]);
  // Filename + type per attached doc, so the composer can show individual
  // Claude-style file cards instead of a collapsed "N documents" pill.
  // `status` mirrors DocumentSummary — documents process (extract, chunk,
  // embed) asynchronously server-side, so a freshly-attached doc starts
  // out PENDING/PROCESSING rather than immediately usable.
  const [attachedDocsMeta, setAttachedDocsMeta] = useState<
    { id: string; filename: string; status: "PENDING" | "PROCESSING" | "READY" | "FAILED" }[]
  >([]);
  const unsentDocsMeta = attachedDocsMeta.filter((d) => !sentDocIds.has(d.id));
  const [attachedToolIds, setAttachedToolIds] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  // Off by default — user opts in per chat from the attach menu. The
  // backend still no-ops safely if web search isn't enabled admin-side.
  const [webSearch, setWebSearch] = useState(false);
  // Agent mode: own build, off by default per chat, persisted on the
  // Chat row (see setChatAgentMode / backend runAgentLoop). Unlike
  // webSearch (a per-message flag) this is a per-chat setting, so it's
  // loaded from and saved back to the chat itself, not reset each turn.
  const [agentMode, setAgentModeState] = useState(false);
  // Prompt improver: rewrites whatever short idea is currently typed in
  // the composer into a fuller prompt, in place, before the user sends
  // it. Nothing is sent or saved — it only replaces the draft text.
  const [isImprovingPrompt, setIsImprovingPrompt] = useState(false);
  const handleImprovePrompt = async () => {
    const draft = input.trim();
    if (!draft || isImprovingPrompt) return;
    setShowAttachMenu(false);
    setIsImprovingPrompt(true);
    try {
      const model = selectedModel || (await getDefaultModel());
      if (!model) throw new Error("No chat model is available.");
      const { improved } = await improvePrompt(draft, model);
      if (improved) setInput(improved);
    } catch {
      // best-effort — leave the user's own draft untouched on failure
    } finally {
      setIsImprovingPrompt(false);
    }
  };
  const setAgentMode = (next: boolean) => {
    setAgentModeState(next);
    if (chatId) setChatAgentMode(chatId, next).catch(() => {});
  };
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [expandedSubPanel, setExpandedSubPanel] = useState<"documents" | "tools" | "prompts" | null>(null);
  // Set only by openFilesInChat() below, to tell DocumentPanel to render
  // its file list open right away instead of the collapsed "Documents"
  // toggle a normal "+" menu click would show.
  const [forceOpenDocsPanel, setForceOpenDocsPanel] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  const attachMenuPopupRef = useRef<HTMLDivElement | null>(null);
  // The popup opens upward from the "+" button (bottom-full). On short
  // viewports (small phones, zoomed-in browsers, address bar eating
  // vertical space) a fixed max-height can still run off the top of the
  // screen — so instead we measure the actual space above the button
  // every time the menu opens (and on resize) and cap the popup to that,
  // with a small margin. Recomputed via a plain number in state rather
  // than a CSS var so it also works before any JS-driven reflow settles.
  const [attachMenuMaxHeight, setAttachMenuMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!showAttachMenu) return;
    const recompute = () => {
      const btn = attachMenuRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      // Space between the top of the viewport and the top of the "+"
      // button, minus a margin so the popup never touches the edge.
      const available = rect.top - 12;
      setAttachMenuMaxHeight(Math.max(120, Math.min(available, 420)));
    };
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [showAttachMenu]);
  // Vision uploads: images attached to the *next* outgoing message, sent
  // to the model as base64 (llama3.2-vision, qwen2.5vl, llava, ...).
  // Distinct from imageMode above, which is for image *generation*.
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // Page-wide drag & drop, Claude-style: dropping anywhere over the chat
  // (not just the composer) shows a full-screen white overlay. Uses a
  // counter instead of a plain boolean because dragenter/dragleave fire
  // for every child element the pointer crosses — without the counter,
  // moving over a nested element's boundary would flicker the overlay off.
  const dragCounterRef = useRef(0);
  const [isDraggingFilePage, setIsDraggingFilePage] = useState(false);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Composer starts at a shorter, more compact height and only grows to
  // its normal full height once the user actually focuses it (clicking
  // in) — not just when they've typed something, so the expand happens
  // immediately on click rather than waiting for the first keystroke.
  // Once there's text in the box it stays expanded even after blurring,
  // since collapsing a non-empty box would clip the user's own text.
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerPopoutOpen, setComposerPopoutOpen] = useState(false);
  const composerChannelRef = useRef<BroadcastChannel | null>(null);
  const composerPopoutWinRef = useRef<Window | null>(null);
  const [imageGenAvailable, setImageGenAvailable] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [isShared, setIsShared] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [chatTitle, setChatTitleLocal] = useState<string | null>(null);
  // Writes go to local state (for instant, optimistic UI here) and to the
  // shared store (so the sidebar's row for this chat updates immediately
  // too, instead of waiting for its own next refresh/poll).
  const setChatTitle = (t: string | null) => {
    setChatTitleLocal(t);
    if (chatId && t != null) setSharedChatTitle(chatId, t);
  };
  // Pick up title changes that originated elsewhere (a rename from the
  // sidebar, or the backend auto-titling a brand-new chat) as soon as the
  // store reflects them, so this header never sits stale.
  useEffect(() => {
    if (!chatId) return;
    const shared = chatTitles[chatId];
    if (shared != null && shared !== chatTitle) setChatTitleLocal(shared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, chatTitles[chatId || ""]]);

  // The preview and server-files panels are tied to whatever chat/message
  // opened them — leaving that chat (switching chats or going back to the
  // homepage, where chatId becomes undefined) should close them instead of
  // letting them linger over an unrelated or empty chat.
  useEffect(() => {
    closePreview();
    closeServerPanel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleMenuRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolEvent | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // Admin-controlled — Admin > Settings > Voice. Default to enabled so
  // the buttons don't flicker away/in while the one-time fetch below is
  // in flight; if it fails (e.g. voice not configured on this deployment
  // at all), the buttons simply won't work when clicked, same as before
  // this setting existed.
  const [sttEnabled, setSttEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  useEffect(() => {
    getVoiceConfig()
      .then((cfg) => {
        setSttEnabled(cfg.sttEnabled);
        setTtsEnabled(cfg.ttsEnabled);
      })
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > General > "Sidebar &
  // navigation" > Upgrade button. Default to true so the button doesn't
  // flicker away/in while the one-time fetch below is in flight.
  const [upgradeButtonEnabled, setUpgradeButtonEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setUpgradeButtonEnabled(c.features.upgradeButton))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Document uploads".
  // Default to true so the attach button doesn't flicker away/in while
  // the one-time fetch below is in flight.
  const [documentUploadEnabled, setDocumentUploadEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setDocumentUploadEnabled(c.features.documentUpload))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Image attachments".
  const [imageUploadEnabled, setImageUploadEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setImageUploadEnabled(c.features.imageUpload))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Tools menu".
  const [toolsMenuEnabled, setToolsMenuEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setToolsMenuEnabled(c.features.toolsMenu))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Controls button".
  // Hides the Chat Controls button for regular users; admins always see
  // it (checked below via the logged-in user's role), and the panel keeps
  // working the same underneath either way.
  const [chatControlsButtonEnabled, setChatControlsButtonEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setChatControlsButtonEnabled(c.features.chatControlsButton))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Camera capture".
  const [cameraCaptureEnabled, setCameraCaptureEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setCameraCaptureEnabled(c.features.cameraCapture))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Screen share".
  const [screenShareEnabled, setScreenShareEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setScreenShareEnabled(c.features.screenShare))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "Greeting logo".
  const [greetingLogoEnabled, setGreetingLogoEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setGreetingLogoEnabled(c.features.greetingLogo))
      .catch(() => {});
  }, []);
  // Admin-controlled — Admin > Settings > Uploads > "AI face avatar".
  const [aiFaceAvatarEnabled, setAiFaceAvatarEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setAiFaceAvatarEnabled(c.features.aiFaceAvatar))
      .catch(() => {});
  }, []);
  const [availableActions, setAvailableActions] = useState<{ id: string; slug: string; name: string; icon: string }[]>([]);
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ messageId: string; text: string } | null>(null);
  // Raw model name (e.g. "jean:latest") -> admin-configured display name.
  // Messages persist the raw name they were sent with, so bubbles need this
  // map to show the friendly name the admin set instead of the raw tag.
  const [modelDisplayNames, setModelDisplayNames] = useState<Record<string, string>>({});
  // Raw model name -> whether the admin allows the Chat Controls panel for
  // it (see ModelParamsModal's "Chat Controls" toggle). Unset/missing = true,
  // so models the list hasn't loaded yet for still show the button.
  const [chatControlsEnabledByModel, setChatControlsEnabledByModel] = useState<Record<string, boolean>>({});
  // Mirrors modelDisplayNames for use inside the chatId effect above,
  // which fires independently of listModels() resolving and would
  // otherwise close over a stale (still-empty) map.
  const modelDisplayNamesRef = useRef<Record<string, string>>({});
  modelDisplayNamesRef.current = modelDisplayNames;
  useEffect(() => {
    listModels()
      .then((list) => {
        const map: Record<string, string> = {};
        const controlsMap: Record<string, boolean> = {};
        for (const m of list) {
          if (m.displayName) map[m.name] = m.displayName;
          controlsMap[m.name] = m.chatControlsEnabled !== false;
        }
        setModelDisplayNames(map);
        setChatControlsEnabledByModel(controlsMap);
        // Backfill the cache entry for the currently open chat now that
        // we know its friendly display name (right after a fresh cache
        // write above, this map may not have been ready yet).
        if (chatId && selectedModel && map[selectedModel]) {
          writeCachedChatModel(chatId, selectedModel, map[selectedModel]);
        }
      })
      .catch(() => {});
  }, []);
  // Inline "kladbaar" editing of a previously-sent user message: editingId
  // is the message being edited, editText its draft content. Submitting
  // patches the message on the backend (which discards everything sent
  // after it), truncates local state to match, then regenerates the reply.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // ---- Continuous voice mode: click the mic once to start a hands-free
  // conversation — it keeps listening, auto-stops on silence, sends what
  // you said by itself, then starts listening again for the next thing
  // you say. Click the mic again to leave voice mode. ----
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(false); // mirrors voiceMode for use inside async/RAF callbacks
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceAudioCtxRef = useRef<AudioContext | null>(null);
  const voiceSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceMaxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHasSpokenRef = useRef(false);
  const voiceRafRef = useRef<number | null>(null);
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null); // shared with barge-in monitor below

  // ---- Streaming TTS: instead of waiting for the full reply to finish
  // generating and then synthesizing+playing it as one big clip (which is
  // why audio used to arrive so late), sentences are queued for speech as
  // soon as they're complete in the token stream, and played back-to-back
  // as they're synthesized — the AI starts "talking" a beat after it
  // starts "thinking" instead of after it's done. The queue can also be
  // interrupted mid-sentence (barge-in) the moment the person starts
  // talking again, like an actual conversation. ----
  const ttsQueueRef = useRef<string[]>([]);
  const ttsRunningRef = useRef(false);
  const ttsGenerationRef = useRef(0); // bumped on interrupt; stale synth/playback checks this and bails
  const ttsDrainWaitersRef = useRef<Array<() => void>>([]);
  const bargeInRafRef = useRef<number | null>(null);

  // ---- Camera + screen capture: both feed into `pendingImages` (the same
  // vision-attachment pipeline used by "Attach image"), so a snapshot from
  // either source is sent to the model exactly like an uploaded image —
  // no separate backend support needed. Camera opens a live preview modal
  // (user reviews framing before capturing); screen capture grabs a single
  // frame from the browser's native screen/window/tab picker immediately.
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isCapturingScreen, setIsCapturingScreen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  // Sending the first message from the homepage creates a chat and
  // navigates to /chat/[id] (see createChat + router.push below) — that's
  // a route change, so this component remounts fresh and would normally
  // lose local state like this. Persist it across that one navigation so
  // the avatar view stays open instead of silently dropping back to the
  // plain chat page.
  const [showControls, setShowControls] = useState(false);
  // If the model changes to one where an admin has turned Chat Controls
  // off (or the picker hasn't loaded it yet and turns out to be off), an
  // already-open panel shouldn't linger with no way to reopen it later.
  useEffect(() => {
    if (showControls && chatControlsEnabledByModel[selectedModel || ""] === false) {
      setShowControls(false);
    }
  }, [selectedModel, chatControlsEnabledByModel, showControls]);
  const [showAvatar, setShowAvatarState] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem("visiyon-show-avatar") === "1";
  });
  const setShowAvatar = (value: boolean) => {
    setShowAvatarState(value);
    if (typeof window !== "undefined") {
      if (value) sessionStorage.setItem("visiyon-show-avatar", "1");
      else sessionStorage.removeItem("visiyon-show-avatar");
    }
  };
  const avatarOverlayRef = useRef<HTMLDivElement | null>(null);
  // The avatar's actual available box — not the raw window — since the
  // conversation rail on the left eats into the width on md+ screens.
  // Sizing off window.innerWidth alone left the photo's aspect-ratio box
  // wider than the space it actually had, which browsers then clamped
  // asymmetrically via max-width/max-height, cropping the face off one
  // edge instead of scaling it down cleanly.
  const avatarStageRef = useRef<HTMLDivElement | null>(null);
  const [avatarStageSize, setAvatarStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = avatarStageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setAvatarStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [avatarGaze, setAvatarGaze] = useState({ x: 0, y: 0 });
  const [avatarExpression, setAvatarExpression] = useState<AvatarExpression>("neutral");
  const [avatarTrigger, setAvatarTrigger] = useState<AvatarTrigger | undefined>(undefined);
  // Tracks which gesture directives (nod/shake/wink) have already fired
  // for the message currently streaming in, so a one-shot gesture doesn't
  // re-fire on every token just because the growing text still contains
  // the same keyword. Cleared at the start of each new send().
  const firedGesturesRef = useRef<Set<string>>(new Set());

  // Scans text for avatar stage directions (see AIFaceAvatar.tsx) and
  // updates gaze/expression/gesture state accordingly. Called both for
  // the user's own outgoing message and for the assistant's reply as it
  // streams in, so the avatar reacts to whichever side says it.
  function applyAvatarDirectives(text: string, gestureKeyPrefix: string) {
    const directives = parseAvatarDirectives(text);
    if (directives.gaze) setAvatarGaze(directives.gaze);
    if (directives.expression) setAvatarExpression(directives.expression);
    if (directives.gesture) {
      const key = `${gestureKeyPrefix}:${directives.gesture}`;
      if (!firedGesturesRef.current.has(key)) {
        firedGesturesRef.current.add(key);
        setAvatarTrigger({ type: directives.gesture, nonce: Date.now() });
      }
    }
  }
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Suggestion dropdown while typing (search-engine style): combines
  // previously sent prompts (localStorage) with a few quick-start
  // suggestions, filtered by what's already been typed.
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(-1);
  const inputBarWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPromptHistory(getPromptHistory());
  }, []);

  // Auto-grow the composer as the user types or pastes long text — like
  // Claude's input: it expands with content up to a max height, then
  // becomes internally scrollable instead of growing further.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 240; // px, keeps in sync with max-h-[240px] below
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (inputBarWrapRef.current && !inputBarWrapRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // The attach/tools menu and the "more options" menu used to close via a
  // "fixed inset-0" click-catcher div. That silently stopped working
  // because both menus live inside elements with backdrop-filter/transform
  // (the input bar's backdrop-blur-xl, and similar ancestors) — any of
  // those properties on an ancestor makes it the containing block for
  // "fixed" descendants, so the click-catcher only covered that ancestor's
  // own box instead of the full viewport, and clicks elsewhere on the page
  // never reached it. A plain document listener has no such issue.
  useEffect(() => {
    if (!showAttachMenu) return;
    function onMouseDown(e: MouseEvent) {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
        setExpandedSubPanel(null);
        setForceOpenDocsPanel(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showAttachMenu]);

  // Keyboard shortcuts for the "+" attach menu's actions, mirroring the
  // hints shown next to each item (e.g. "Ctrl U" for Attach image) — the
  // same pattern Claude uses. Modifier-based, so it's safe to listen even
  // while the composer textarea has focus (a plain letter would type into
  // it; a Ctrl/Cmd-combo doesn't). Ctrl on Windows/Linux, Cmd on Mac.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "u" && !e.shiftKey && imageUploadEnabled && pendingImages.length < 4) {
        e.preventDefault();
        imageInputRef.current?.click();
        setShowAttachMenu(false);
      } else if (key === "u" && e.shiftKey && cameraCaptureEnabled && !isCameraOpen && pendingImages.length < 4) {
        e.preventDefault();
        openCamera();
        setShowAttachMenu(false);
      } else if (key === "e" && e.shiftKey && screenShareEnabled && !isCapturingScreen && pendingImages.length < 4) {
        e.preventDefault();
        captureScreen();
        setShowAttachMenu(false);
      } else if (key === "j" && e.shiftKey) {
        e.preventDefault();
        setWebSearch((v) => !v);
        setShowAttachMenu(false);
      } else if (key === "l" && e.shiftKey) {
        e.preventDefault();
        setAgentMode(!agentMode);
        setShowAttachMenu(false);
      } else if (key === "g" && e.shiftKey && imageGenAvailable) {
        e.preventDefault();
        setImageMode((v) => !v);
        setShowAttachMenu(false);
      } else if (key === "." && e.shiftKey) {
        e.preventDefault();
        composerPopoutOpen ? closeComposerPopout() : openComposerPopout();
        setShowAttachMenu(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    imageUploadEnabled,
    cameraCaptureEnabled,
    screenShareEnabled,
    isCameraOpen,
    isCapturingScreen,
    pendingImages.length,
    imageGenAvailable,
    composerPopoutOpen,
    agentMode,
  ]);

  useEffect(() => {
    if (!showMoreMenu) return;
    function onMouseDown(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showMoreMenu]);

  useEffect(() => {
    if (!titleMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (titleMenuRef.current && !titleMenuRef.current.contains(e.target as Node)) {
        setTitleMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [titleMenuOpen]);

  const suggestions: Suggestion[] = (() => {
    const query = input.trim().toLowerCase();
    if (!query) return [];
    const historyMatches = promptHistory
      .filter((p) => p.toLowerCase() !== query && p.toLowerCase().includes(query))
      .slice(0, 5)
      .map((text) => ({ text, type: "history" as const }));
    const quickMatches = QUICK_SUGGESTIONS.filter((s) => s.toLowerCase().includes(query))
      .slice(0, 4)
      .map((text) => ({ text, type: "quick" as const }));
    return [...historyMatches, ...quickMatches].slice(0, 7);
  })();

  function applySuggestion(text: string) {
    setInput(text);
    setShowSuggestions(false);
    setActiveSuggestionIdx(-1);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Tracks whether the message list is scrolled away from the very top,
  // so the header's shadow only shows once there's actually content
  // scrolled underneath it — sitting at the top of a fresh/short chat
  // otherwise showed the same shadow with nothing behind it to justify it.
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrolledDown, setScrolledDown] = useState(false);
  // Shows a floating "scroll to bottom" button (like Claude's) once the
  // user has scrolled up away from the latest message, so they can jump
  // back down without manually scrolling through the whole conversation.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Separate ref for the avatar overlay's conversation rail — it renders
  // alongside the main chat body (not instead of it), so sharing one ref
  // between both bottom-anchors meant whichever mounted last silently
  // stole the ref and broke autoscroll for the other.
  const avatarBottomRef = useRef<HTMLDivElement>(null);

  // Typewriter effect for the composer placeholder on the empty landing
  // screen only — cycles through PLACEHOLDER_PHRASES, typing and
  // deleting each one. Stops (and the plain "Ask anything" placeholder
  // takes over) as soon as there are messages, so it never distracts
  // mid-conversation.
  const [typedPlaceholder, setTypedPlaceholder] = useState("");
  useEffect(() => {
    if (messages.length > 0) return;
    let phraseIdx = 0;
    let charIdx = 0;
    let deleting = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    function tick() {
      const phrase = PLACEHOLDER_PHRASES[phraseIdx];
      if (!deleting) {
        charIdx++;
        setTypedPlaceholder(phrase.slice(0, charIdx));
        if (charIdx === phrase.length) {
          deleting = true;
          timeoutId = setTimeout(tick, 1400);
          return;
        }
        timeoutId = setTimeout(tick, 45);
      } else {
        charIdx--;
        setTypedPlaceholder(phrase.slice(0, charIdx));
        if (charIdx === 0) {
          deleting = false;
          phraseIdx = (phraseIdx + 1) % PLACEHOLDER_PHRASES.length;
          timeoutId = setTimeout(tick, 300);
          return;
        }
        timeoutId = setTimeout(tick, 25);
      }
    }
    timeoutId = setTimeout(tick, 400);
    return () => clearTimeout(timeoutId);
  }, [messages.length]);

  useEffect(() => {
    setCurrentChatId(chatId ?? null);
    setScrolledDown(false);
    listAvailableActions()
      .then((r) => setAvailableActions(r.actions))
      .catch(() => setAvailableActions([]));
    if (chatId) {
      const skipFetch = justCreatedChatId === chatId;
      if (skipFetch) setJustCreatedChatId(null);
      // Prime the model name from a local cache immediately (a plain
      // localStorage read, same tick) so the ModelSelector doesn't sit
      // blank/flash while getChat()'s network round trip is still in
      // flight on every refresh — see readCachedChatModel below.
      const cached = readCachedChatModel(chatId);
      if (cached) {
        setSelectedModel(cached.model);
        if (cached.displayName) {
          setModelDisplayNames((prev) => (prev[cached.model] ? prev : { ...prev, [cached.model]: cached.displayName! }));
        }
      }
      if (!skipFetch) {
        getChat(chatId).then((chat) => {
          setMessages(chat.messages);
          setSelectedModel(chat.model);
          setSystemPrompt(chat.systemPrompt ?? null);
          setShareId(chat.shareId ?? null);
          setIsShared(Boolean(chat.isPublic));
          setIsPinned(Boolean(chat.pinned));
          setIsArchived(Boolean(chat.archived));
          setAgentMode(Boolean(chat.agentMode));
          setChatTitle(chat.title ?? null);
          writeCachedChatModel(chatId, chat.model, modelDisplayNamesRef.current[chat.model]);
        });
      }
      listChatDocuments(chatId)
        .then((docs) => {
          setAttachedDocIds(docs.map((d) => d.id));
          setAttachedDocsMeta(docs.map((d) => ({ id: d.id, filename: d.filename, status: d.status })));
        })
        .catch(() => {
          setAttachedDocIds([]);
          setAttachedDocsMeta([]);
        });
      listChatTools(chatId)
        .then((tools) => setAttachedToolIds(tools.map((t) => t.id)))
        .catch(() => setAttachedToolIds([]));
    } else {
      setMessages([]);
      setAttachedDocIds([]);
      setAttachedDocsMeta([]);
      setAttachedToolIds([]);
      setSystemPrompt(null);
      setShareId(null);
      setIsShared(false);
      setIsPinned(false);
      setShowMoreMenu(false);
      setChatTitle(null);
      setTitleMenuOpen(false);
    }
  }, [chatId]);

  useEffect(() => {
    imageGenConfig()
      .then((cfg) => setImageGenAvailable(cfg.enabled))
      .catch(() => setImageGenAvailable(false));
  }, []);

  function refreshUsage() {
    getTodayUsage()
      .then((u) => {
        setUsage((prev) => {
          const prevPct =
            prev?.dailyTokenQuota != null && prev.dailyTokenQuota > 0
              ? (prev.tokenCount ?? 0) / prev.dailyTokenQuota
              : 0;
          const nextPct =
            u.dailyTokenQuota != null && u.dailyTokenQuota > 0
              ? (u.tokenCount ?? 0) / u.dailyTokenQuota
              : 0;
          // Re-arm the warning once usage drops back under 90% (new window,
          // quota bump, etc.) so a later crossing shows it again.
          if (prevPct >= 0.9 && nextPct < 0.9) setLimitWarningDismissed(false);
          return u;
        });
      })
      .catch(() => {});
  }

  const usagePct =
    usage?.dailyTokenQuota != null && usage.dailyTokenQuota > 0
      ? (usage.tokenCount ?? 0) / usage.dailyTokenQuota
      : 0;
  const showLimitWarning = usagePct >= 0.9 && !limitWarningDismissed;

  useEffect(() => {
    refreshUsage();
  }, []);

  // During streaming, `messages` changes on every token — calling a fresh
  // smooth-scroll on each one restarts the animation before it finishes,
  // so the view visibly stutters and never actually settles at the
  // bottom. Coalesce updates into at most one scroll per animation frame,
  // and skip the (expensive, unnecessary) smooth animation while
  // streaming — snap instantly instead, same as most chat UIs do.
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    // Don't yank the view back down if the user has scrolled up to read
    // earlier messages — respect that and let the existing "scroll to
    // bottom" button (see showScrollToBottom below) bring them back down
    // instead. Without this, every streamed token forced an instant jump
    // to the bottom, making it impossible to scroll up at all while a
    // reply was generating.
    if (showScrollToBottom) return;
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
      avatarBottomRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
    });
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [messages, isStreaming, showScrollToBottom]);

  // When streaming ends, the just-finished code block swaps from plain
  // text to syntax-highlighted (see CodeBlock's isStreaming branch) —
  // that re-render changes the block's height *after* the scroll above
  // already ran, so the view can land just short of the true bottom.
  // Catch that follow-up layout shift once things settle.
  const prevIsStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming) {
      const t = setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 60);
      prevIsStreamingRef.current = isStreaming;
      return () => clearTimeout(t);
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // "Edit" on a generated image: drop the original prompt back into the
  // composer (with image mode on) so the user can tweak it and regenerate,
  // rather than retyping the whole prompt from scratch.
  function handleEditImage(prompt: string) {
    setImageMode(true);
    setInput(prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  // Fullscreen viewer (see ImageLightbox) for a generated image, opened by
  // clicking the image in chat.
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string; prompt?: string } | null>(null);
  const [lightboxRegenerating, setLightboxRegenerating] = useState(false);

  function handleOpenImage(src: string, alt: string | undefined, prompt: string | undefined) {
    setLightbox({ src, alt, prompt });
  }

  // Pulls the base64 payload back out of `![Generated image](data:image/...;base64,...)`
  // in the freshly-generated assistant message, so the lightbox can swap in
  // the new image without a round-trip through the message list.
  const GENERATED_IMAGE_DATA_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/;

  async function handleRegenerateImage(prompt: string) {
    setLightboxRegenerating(true);
    try {
      const id = await ensureChat();
      const { message } = await generateChatImage(id, prompt);
      pushMessage({ id: message.id, role: "ASSISTANT", content: message.content, createdAt: new Date().toISOString(), model: selectedModel });
      const match = message.content.match(GENERATED_IMAGE_DATA_RE);
      if (match) {
        setLightbox({ src: match[0], prompt });
      } else {
        alert("Regeneration finished, but no image was returned.");
      }
    } catch (err) {
      alert(err instanceof Error ? `Regeneration failed: ${err.message}` : "Regeneration failed");
    } finally {
      setLightboxRegenerating(false);
    }
  }

  // Guards against ensureChat() being called twice back-to-back (e.g. a
  // file drop immediately followed by hitting send) before React has
  // re-rendered with the new chatId — without this, the second call's
  // `if (chatId)` check still sees the old value and creates a SECOND
  // chat, silently splitting the document attach and the message across
  // two different chats.
  const ensureChatPromiseRef = useRef<Promise<string> | null>(null);

  async function ensureChat(): Promise<string> {
    if (chatId) return chatId;
    // Covers the gap this guard doesn't: ensureChat() already resolved
    // once (e.g. from attaching a document on the homepage), the chat was
    // created and router.push() fired, but Next.js navigation hasn't
    // finished re-rendering this component with the new chatId prop yet.
    // Without this, a second ensureChat() call (e.g. hitting send right
    // after) still sees the stale chatId and creates a SECOND chat,
    // silently splitting the attached document and the message across
    // two different chats — the doc lands on chat A, the message on chat B.
    if (justCreatedChatId) return justCreatedChatId;
    if (ensureChatPromiseRef.current) return ensureChatPromiseRef.current;
    const promise = (async () => {
      const defaultModel = selectedModel || (await getDefaultModel());
      if (!defaultModel) throw new Error("No chat model is available.");
      const chat = await createChat(defaultModel);
      setJustCreatedChatId(chat.id);
      bumpChatListVersion();
      // Chat Controls edits made before this chat existed (on the homepage)
      // are staged in localStorage since there was no chat id to save them
      // against yet — apply them to the chat we just created.
      try {
        const raw = localStorage.getItem("visiyon_pending_chat_params");
        if (raw) {
          const pending = JSON.parse(raw);
          localStorage.removeItem("visiyon_pending_chat_params");
          setChatParameters(chat.id, pending).catch(() => {});
        }
      } catch {}
      router.push(`/chat/${chat.id}`);
      return chat.id;
    })();
    ensureChatPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      ensureChatPromiseRef.current = null;
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Strip the "data:image/png;base64," prefix — Ollama wants raw base64.
        const result = reader.result as string;
        resolve(result.split(",")[1] ?? result);
      };
      reader.onerror = () => reject(new Error("Could not read image"));
      reader.readAsDataURL(file);
    });
  }

  async function handleImagePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!imageUploadEnabled) {
      alert("Image attachments are currently disabled by the administrator.");
      return;
    }
    const remaining = Math.max(0, 4 - pendingImages.length);
    const picked = Array.from(files).slice(0, remaining);
    try {
      const encoded = await Promise.all(picked.map(fileToBase64));
      setPendingImages((prev) => [...prev, ...encoded]);
    } catch {
      // ignore unreadable files
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  const DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".csv", ".zip"];

  function isDocumentFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return DOCUMENT_EXTENSIONS.some((ext) => name.endsWith(ext));
  }

  // Shared by the page-wide drop overlay and the composer's own drop zone.
  // Routes images to the vision attachment flow, recognized document types
  // (including .zip, which the backend unpacks and searches file-by-file —
  // see extractZipText in backend/src/lib/rag.ts) to the RAG upload flow,
  // and anything else (exe, ...) to a clear heads-up instead of silently
  // doing nothing.
  function handleFilesDropped(files: File[]) {
    if (files.length === 0) return;
    const images = files.filter((f) => f.type.startsWith("image/"));
    const docs = files.filter((f) => !f.type.startsWith("image/") && isDocumentFile(f));
    const unsupported = files.filter((f) => !images.includes(f) && !docs.includes(f));
    if (images.length > 0) {
      const dt = new DataTransfer();
      images.forEach((f) => dt.items.add(f));
      handleImagePick(dt.files);
    }
    if (docs.length > 0) {
      handleDocumentPick(docs);
    }
    if (unsupported.length > 0) {
      alert(
        unsupported.length === 1
          ? `"${unsupported[0].name}" isn't a supported file type. You can attach images or PDF, DOCX, TXT, MD, CSV, and ZIP files.`
          : `${unsupported.length} files aren't a supported type (${unsupported.map((f) => f.name).join(", ")}). You can attach images or PDF, DOCX, TXT, MD, CSV, and ZIP files.`
      );
    }
  }

  // Documents process (extract -> chunk -> embed) asynchronously
  // server-side after upload/attach, so a freshly-attached doc starts out
  // PENDING/PROCESSING — sending straight away used to silently produce a
  // reply with no document context, because the RAG step only looks at
  // documents whose status is already READY. Poll until it settles into
  // READY or FAILED so the composer can hold off (and the chip can show
  // real status) until the document is actually usable.
  async function pollDocumentStatus(chatId: string, documentId: string) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const docs = await listChatDocuments(chatId);
        const doc = docs.find((d) => d.id === documentId);
        if (!doc) return; // detached in the meantime
        setAttachedDocsMeta((prev) => prev.map((d) => (d.id === documentId ? { ...d, status: doc.status } : d)));
        if (doc.status === "READY" || doc.status === "FAILED") return;
      } catch {
        return;
      }
    }
  }

  async function handleDocumentPick(files: File[]) {
    if (files.length === 0) return;
    if (!documentUploadEnabled) {
      alert("Document uploads are currently disabled by the administrator.");
      return;
    }
    setUploadingDocs(true);
    try {
      const id = await ensureChat();
      for (const file of files) {
        try {
          const doc = await uploadDocument(file);
          await attachDocument(id, doc.id);
          setAttachedDocIds((prev) => (prev.includes(doc.id) ? prev : [...prev, doc.id]));
          setAttachedDocsMeta((prev) =>
            prev.some((d) => d.id === doc.id) ? prev : [...prev, { id: doc.id, filename: doc.filename, status: doc.status }]
          );
          pollDocumentStatus(id, doc.id);
        } catch (err) {
          alert(err instanceof Error ? `${file.name}: ${err.message}` : `${file.name}: upload failed`);
        }
      }
    } finally {
      setUploadingDocs(false);
    }
  }

  async function send(regenerate = false, continueGeneration = false, overrideText?: string, streamSpeech = false) {
    if (isStreaming || isGeneratingImage) return;
    if (!regenerate && !continueGeneration && attachedDocsMeta.some((d) => d.status === "PENDING" || d.status === "PROCESSING")) return;
    const id = await ensureChat();
    const isFirstMessage = messages.length === 0 && !regenerate && !continueGeneration;
    let content = regenerate || continueGeneration ? "" : (overrideText ?? input).trim();
    // A message with no typed text but with an attached document (or a
    // pending image) is still a real thing to send — the guard used to
    // check only content/pendingImages, so attaching a file and hitting
    // send with an empty text box silently did nothing.
    if (!regenerate && !continueGeneration && !content && pendingImages.length === 0 && attachedDocIds.length === 0) return;
    // A file-only send (no typed text) used to need a synthetic question
    // filled in here so the model would actually look at the attachment —
    // but that showed up as a fake user bubble ("Bekijk het bijgevoegde
    // bestand...") cluttering the chat, unlike Claude, where dropping a
    // file with nothing typed just works. Now that the backend's own
    // ragReminderBlock (routes/chats.ts) reliably tells the model it HAS
    // an attached document to read, content can stay genuinely empty here
    // — no fake question needed, and no empty-looking bubble either since
    // the message renders as just the file chip.
    // New turn — let this turn's gestures fire again even if the same
    // keyword was used earlier in the conversation.
    firedGesturesRef.current = new Set();
    if (content) applyAvatarDirectives(content, "user");
    const imagesToSend = regenerate || continueGeneration ? undefined : pendingImages;
    // Auto-detect "draw me a...", "generate an image of..." style
    // requests so people don't have to remember to flip the image-mode
    // toggle first. Only kicks in for plain text (no vision attachments,
    // which imply "look at this" rather than "make me a new picture").
    const autoImageIntent =
      !imageMode &&
      !regenerate &&
      !continueGeneration &&
      imageGenAvailable &&
      pendingImages.length === 0 &&
      looksLikeImageRequest(content);

    if ((imageMode || autoImageIntent) && !regenerate && !continueGeneration) {
      pushMessage({ id: safeRandomUUID(), role: "USER", content, createdAt: new Date().toISOString() });
      setInput("");
      setGeneratingImage(true, content);
      try {
        const { message } = await generateChatImage(id, content);
        pushMessage({ id: message.id, role: "ASSISTANT", content: message.content, createdAt: new Date().toISOString(), model: selectedModel });
      } catch (err) {
        pushMessage({
          id: safeRandomUUID(),
          role: "ASSISTANT",
          content: `Sorry, image generation failed: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(),
          model: selectedModel,
        });
      } finally {
        setGeneratingImage(false);
        if (isFirstMessage) {
          bumpChatListVersion();
          getChat(id).then((c) => setChatTitle(c.title ?? null)).catch(() => {});
        }
      }
      return;
    }

    if (!regenerate && !continueGeneration && content) {
      addPromptToHistory(content);
      setPromptHistory(getPromptHistory());
    }

    const localUserId = safeRandomUUID();
    // Snapshot whichever docs are currently attached and not yet shown on
    // an earlier message — they move from the composer's chip row onto
    // this bubble, while staying attached to the chat (attachedDocIds)
    // for RAG on later turns too.
    const docsToSend = regenerate || continueGeneration ? undefined : unsentDocsMeta;
    if (!regenerate && !continueGeneration) {
      pushMessage({
        id: localUserId,
        role: "USER",
        content,
        createdAt: new Date().toISOString(),
        ...(imagesToSend && imagesToSend.length > 0 ? { images: imagesToSend } : {}),
        ...(docsToSend && docsToSend.length > 0 ? { documents: docsToSend } : {}),
      });
      setInput("");
      setPendingImages([]);
    }
    // Continue resumes the existing last assistant bubble in place —
    // pushing a fresh empty one would create a second, separate reply.
    const localAssistantId = safeRandomUUID();
    if (!continueGeneration) {
      pushMessage({ id: localAssistantId, role: "ASSISTANT", content: "", createdAt: new Date().toISOString(), model: selectedModel });
    }
    setStreaming(true);
    setActiveTool(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // onMeta below swaps this bubble's id from localAssistantId to the
    // server's real assistantMessageId partway through streaming (so
    // Edit/regenerate/rating work without a reload) — track whatever the
    // *current* id is here so the end-of-stream lookup further down
    // doesn't search for an id that's already been replaced in the store.
    let liveAssistantId = localAssistantId;
    // When streamSpeech is on (voice mode), sentences get queued for TTS
    // as soon as they're complete in the token stream, instead of waiting
    // for the whole reply to finish generating first — this is what makes
    // the AI start talking almost immediately instead of after a long
    // pause. speechBuffer accumulates the in-progress trailing fragment
    // between calls.
    if (streamSpeech) {
      ttsGenerationRef.current++; // a fresh reply invalidates any leftover queue from before
      ttsQueueRef.current = [];
    }
    const speechBuffer = { current: "" };

    try {
      await streamMessage(id, content, (token) => {
        appendToLastAssistant(token);
        const live = useChatStore.getState().messages;
        const bubble = live.find((m) => m.id === localAssistantId);
        if (bubble) applyAvatarDirectives(bubble.content, "assistant");
        if (streamSpeech && ttsEnabled) {
          speechBuffer.current += token;
          for (const sentence of popCompleteSentences(speechBuffer)) {
            enqueueSpeech(sentence, localAssistantId);
          }
        }
      }, {
        regenerate,
        continueGeneration,
        webSearch,
        images: imagesToSend,
        documents: docsToSend,
        location: !regenerate && !continueGeneration ? readStoredLocation() ?? undefined : undefined,
        signal: controller.signal,
        onTool: (event) => setActiveTool(event),
        onMeta: (meta) => {
          // Swap the client-generated placeholder ids from above for the
          // real, persisted ones so Edit/regenerate/rating on these
          // bubbles works without needing a page reload first.
          if (meta.userMessageId && !regenerate && !continueGeneration) {
            updateMessageId(localUserId, meta.userMessageId);
          }
          if (meta.assistantMessageId && !continueGeneration) {
            updateMessageId(localAssistantId, meta.assistantMessageId);
            liveAssistantId = meta.assistantMessageId;
          }
        },
        onUsage: (usage) => setLastAssistantUsage(usage.promptTokens, usage.completionTokens),
        onStep: (step) => pushStepToLastAssistant(step),
        onReasoning: (token) => appendReasoningToLastAssistant(token),
      });
      // Safety net: the SSE `usage` event should always stamp token counts
      // onto the last bubble live, but if it's ever missed (dropped chunk,
      // tool round-trip, etc.) the badge would otherwise only show up after
      // a manual page refresh, since that's the only other place the DB's
      // stored promptTokens/completionTokens get read back in. Re-pull the
      // persisted message here too so the count always appears immediately.
      if (id) {
        getChat(id)
          .then((chat) => {
            // The server doesn't know about `documents` (it's a
            // client-only snapshot of what was attached at send time —
            // see send() above), so a plain overwrite here would wipe it
            // off the just-sent bubble and make the file "jump back" into
            // the composer. Carry it over from the local copy by id.
            const localDocs = new Map(useChatStore.getState().messages.map((m) => [m.id, m.documents]));
            setMessages(
              (chat.messages as ChatMessage[]).map((m) =>
                m.documents ? m : localDocs.get(m.id) ? { ...m, documents: localDocs.get(m.id) } : m
              )
            );
          })
          .catch(() => {});
      }
    } catch (err: any) {
      // stopped/aborted requests have no status — only surface the modal
      // for an actual quota rejection from the server.
      if (err?.status === 429) {
        setLimitResetAt(err.resetAt || null);
        setShowBuyCredits(true);
      }
      const wasUserStopped = err?.name === "AbortError" || controller.signal.aborted;
      // If the generation never produced any content, drop the empty
      // assistant bubble we optimistically pushed above — otherwise it
      // sits there forever with no content and no Regenerate/Continue
      // button (those only show once a bubble has content), leaving the
      // user stuck. But if tokens had already streamed in before the
      // error hit (e.g. the connection dropped partway through a long
      // file), keep that bubble as-is instead of throwing away work the
      // user already saw appear on screen — that's what used to make a
      // reply "explode"/disappear right as it was finishing up.
      if (!continueGeneration) {
        const live = useChatStore.getState().messages;
        const bubble = live.find((m) => m.id === liveAssistantId);
        if (bubble && !bubble.content.trim()) {
          if (wasUserStopped || err?.status === 429) {
            // User-initiated stop, or the quota modal above already told
            // them what happened — no need to also show an error bubble.
            setMessages(live.filter((m) => m.id !== liveAssistantId));
          } else {
            // A real failure (model/provider error, meta-model race with
            // no working candidate, stalled connection, ...) previously
            // deleted this bubble silently — the message just vanished
            // with zero feedback. Show what went wrong instead so the
            // user isn't left guessing.
            setMessages(
              live.map((m) =>
                m.id === liveAssistantId
                  ? { ...m, content: `⚠️ ${err?.message || "Er ging iets mis bij het genereren van een antwoord."}` }
                  : m
              )
            );
          }
        }
      }
      if (!regenerate && !continueGeneration && content) {
        const live = useChatStore.getState().messages;
        const bubble = live.find((m) => m.id === liveAssistantId);
        if (!bubble || !bubble.content.trim()) {
          setInput(content);
        }
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      refreshUsage();
      if (isFirstMessage) {
        bumpChatListVersion();
        getChat(id).then((c) => setChatTitle(c.title ?? null)).catch(() => {});
      }
      const finished = useChatStore.getState().messages.find((m) => m.id === liveAssistantId);
      if (finished?.content.trim()) notifyReplyReady(finished.content.trim());
      // Whatever's left in the buffer is the tail end of the reply that
      // never hit a sentence-ending punctuation mark — queue it too so
      // the AI doesn't silently drop its last clause.
      if (streamSpeech && ttsEnabled && speechBuffer.current.trim()) {
        enqueueSpeech(speechBuffer.current, localAssistantId);
      }
    }
  }

  async function submitEdit(messageId: string) {
    const content = editText.trim();
    if (!content || !chatId || isStreaming) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    try {
      await editMessage(chatId, messageId, content);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Editing the message failed.");
      return;
    }

    // Discard everything after the edited message locally too — the
    // backend already dropped it, this just keeps the UI in sync before
    // the regenerated reply streams back in.
    const truncated = messages.slice(0, index + 1);
    truncated[index] = { ...truncated[index], content };
    setMessages(truncated);
    setEditingId(null);
    setEditText("");

    await send(true);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText("");
  }

  async function toggleShare() {
    if (!chatId) return;
    if (isShared) {
      await unshareChat(chatId);
      setIsShared(false);
    } else {
      const { shareId: newId } = await shareChat(chatId);
      setShareId(newId);
      setIsShared(true);
    }
  }

  async function copyShareLink() {
    if (!shareId) return;
    const link = `${window.location.origin}/share/${shareId}`;
    await copyToClipboard(link);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }

  async function toggleChatPinned() {
    if (!chatId) return;
    const next = !isPinned;
    setIsPinned(next);
    setShowMoreMenu(false);
    try {
      await pinChat(chatId, next);
      bumpChatListVersion();
    } catch {
      setIsPinned(!next); // revert on failure
    }
  }

  function startRenamingTitle() {
    if (!chatId) return;
    setTitleDraft(chatTitle || "");
    setRenamingTitle(true);
    setTitleMenuOpen(false);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitTitleRename() {
    setRenamingTitle(false);
    if (!chatId) return;
    const next = titleDraft.trim();
    if (!next || next === chatTitle) return;
    const prev = chatTitle;
    setChatTitle(next);
    try {
      await renameChat(chatId, next);
      bumpChatListVersion();
    } catch {
      setChatTitle(prev); // revert on failure
    }
  }

  async function archiveCurrentChat() {
    if (!chatId) return;
    setShowMoreMenu(false);
    const next = !isArchived;
    setIsArchived(next);
    await archiveChat(chatId, next);
    bumpChatListVersion();
    // Only navigate away when archiving — unarchiving should just flip the
    // label/state and leave you looking at the chat you were already in.
    if (next) router.push("/");
  }

  async function deleteCurrentChat() {
    if (!chatId) return;
    setShowMoreMenu(false);
    if (!(await askConfirm({ title: "Delete this chat?", confirmLabel: "Delete", danger: true }))) return;
    await deleteChat(chatId);
    bumpChatListVersion();
    router.push("/");
  }

  function openFilesInChat() {
    setShowMoreMenu(false);
    setShowAttachMenu(true);
    setExpandedSubPanel("documents");
    setForceOpenDocsPanel(true);
  }

  function stopGenerating() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  // Pops the composer out into its own real browser window (draggable to
  // another monitor, unlike anything still living inside this page). The
  // popout has no chat state of its own — it's a remote control that talks
  // to this window over a BroadcastChannel keyed by chatId, so "new chat"
  // (no id yet) and a specific chat each get their own isolated channel.
  function composerChannelKey() {
    return `visiyon-composer-${chatId || "new"}`;
  }

  function openComposerPopout() {
    const key = composerChannelKey();
    const channel = new BroadcastChannel(key);
    composerChannelRef.current = channel;
    channel.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === "hello") {
        channel.postMessage({ type: "state", streaming: isStreaming });
      } else if (msg?.type === "send") {
        send(false, false, msg.text as string);
      } else if (msg?.type === "stop") {
        stopGenerating();
      } else if (msg?.type === "bye") {
        setComposerPopoutOpen(false);
      }
    };
    const w = window.open(
      `/composer-popout?chatId=${encodeURIComponent(chatId || "")}`,
      "visiyon-composer",
      "width=420,height=260"
    );
    composerPopoutWinRef.current = w;
    setComposerPopoutOpen(true);
  }

  function closeComposerPopout() {
    composerPopoutWinRef.current?.close();
    composerChannelRef.current?.postMessage({ type: "closed" });
    composerChannelRef.current?.close();
    composerChannelRef.current = null;
    setComposerPopoutOpen(false);
  }

  // Keeps the popout's "streaming/idle" indicator (which flips its button
  // between Send and Stop) live as this window's own streaming state
  // changes, and cleans up if the popout window is still open when this
  // chat/component goes away.
  useEffect(() => {
    if (composerPopoutOpen) {
      composerChannelRef.current?.postMessage({ type: "state", streaming: isStreaming });
    }
  }, [isStreaming, composerPopoutOpen]);

  useEffect(() => {
    return () => {
      composerPopoutWinRef.current?.close();
      composerChannelRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Voice input: record with MediaRecorder, send the blob to our
  // self-hosted Whisper transcription endpoint, drop the text into the
  // input box (doesn't auto-send — user can review/edit first). ----
  function stopVoiceCycleInternals() {
    if (voiceSilenceTimerRef.current) {
      clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = null;
    }
    if (voiceMaxDurationTimerRef.current) {
      clearTimeout(voiceMaxDurationTimerRef.current);
      voiceMaxDurationTimerRef.current = null;
    }
    if (voiceRafRef.current != null) {
      cancelAnimationFrame(voiceRafRef.current);
      voiceRafRef.current = null;
    }
  }

  // Fully tears down the mic stream + audio graph — called when voice
  // mode is switched off (as opposed to between utterances, where the
  // same stream is reused so the browser doesn't re-prompt for mic
  // permission every single sentence).
  function teardownVoiceMode() {
    stopVoiceCycleInternals();
    stopBargeInMonitor();
    voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    voiceStreamRef.current = null;
    voiceAudioCtxRef.current?.close().catch(() => {});
    voiceAudioCtxRef.current = null;
    voiceAnalyserRef.current = null;
    mediaRecorderRef.current = null;
  }

  // ---- Streaming TTS queue: sentences come in via enqueueSpeech() as the
  // model streams tokens, and are synthesized+played one at a time here.
  // ttsGenerationRef is bumped by interruptSpeech() so any synth request or
  // playback already in flight recognizes it's stale and stops instead of
  // talking over whatever interrupted it. ----
  function resolveTtsDrainWaiters() {
    const waiters = ttsDrainWaitersRef.current;
    ttsDrainWaitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  }

  function waitForTtsDrain(): Promise<void> {
    if (!ttsRunningRef.current && ttsQueueRef.current.length === 0) return Promise.resolve();
    return new Promise((resolve) => ttsDrainWaitersRef.current.push(resolve));
  }

  // Stops whatever is currently playing/queued immediately — used both for
  // manual "Stop" clicks and for barge-in (the person started talking over
  // the AI, so it should shut up right away instead of finishing its
  // sentence).
  function interruptSpeech() {
    ttsGenerationRef.current++;
    ttsQueueRef.current = [];
    ttsRunningRef.current = false;
    audioPlayerRef.current?.pause();
    setSpeakingId(null);
    resolveTtsDrainWaiters();
  }

  async function runTtsQueue(messageId: string) {
    if (ttsRunningRef.current) return; // already draining the queue on another call
    ttsRunningRef.current = true;
    const myGeneration = ttsGenerationRef.current;
    while (ttsQueueRef.current.length > 0) {
      if (myGeneration !== ttsGenerationRef.current) break; // interrupted mid-queue
      const sentence = ttsQueueRef.current.shift()!;
      try {
        const url = await speakText(sentence);
        if (myGeneration !== ttsGenerationRef.current) break;
        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          audioPlayerRef.current = audio;
          setSpeakingId(messageId);
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio.play().catch(() => resolve());
        });
      } catch {
        // Synthesis failed for this sentence — skip it and keep going
        // rather than aborting the rest of the reply.
      }
    }
    ttsRunningRef.current = false;
    if (myGeneration === ttsGenerationRef.current) setSpeakingId(null);
    resolveTtsDrainWaiters();
  }

  function enqueueSpeech(sentence: string, messageId: string) {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    ttsQueueRef.current.push(trimmed);
    runTtsQueue(messageId);
  }

  // Pulls any complete sentence(s) off the front of a growing token buffer,
  // leaving an in-progress trailing fragment behind for the next call.
  // Heuristic, not a real sentence tokenizer — good enough for speech
  // pacing, where an occasional split on "Mr." or "3.14" just means one
  // slightly-too-short clip rather than a broken conversation.
  function popCompleteSentences(bufferRef: { current: string }): string[] {
    const out: string[] = [];
    let buf = bufferRef.current;
    const enderRe = /[^.!?\n]*[.!?\n]+(?:["'”’)\]]*\s+)/;
    let match;
    while ((match = enderRe.exec(buf)) && match.index === 0) {
      const chunk = match[0];
      if (chunk.trim().length >= 2) {
        out.push(chunk);
        buf = buf.slice(chunk.length);
      } else {
        break;
      }
    }
    bufferRef.current = buf;
    return out;
  }

  // ---- Barge-in: while the AI is speaking in voice mode, keep half an
  // eye on the mic. The moment the person starts talking again, cut the
  // AI off mid-sentence and drop straight into listening for what they're
  // saying — instead of making them wait for the AI to finish, or having
  // to press anything. ----
  function stopBargeInMonitor() {
    if (bargeInRafRef.current != null) {
      cancelAnimationFrame(bargeInRafRef.current);
      bargeInRafRef.current = null;
    }
  }

  function startBargeInMonitor(stream: MediaStream, analyser: AnalyserNode) {
    stopBargeInMonitor();
    const data = new Uint8Array(analyser.fftSize);
    const BARGE_IN_THRESHOLD = 14; // slightly higher than the listening threshold to avoid false triggers
    const CONSECUTIVE_FRAMES_NEEDED = 3; // a few frames in a row of real speech, not just a click/pop
    let consecutive = 0;

    function monitor() {
      if (!voiceModeRef.current) {
        stopBargeInMonitor();
        return;
      }
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const dev = Math.abs(data[i] - 128);
        if (dev > peak) peak = dev;
      }
      if (peak > BARGE_IN_THRESHOLD) {
        consecutive++;
        if (consecutive >= CONSECUTIVE_FRAMES_NEEDED) {
          stopBargeInMonitor();
          interruptSpeech();
          // Jump straight into a fresh listening cycle instead of waiting
          // for the normal post-reply hand-off — that's the whole point
          // of barge-in.
          if (voiceModeRef.current && mediaRecorderRef.current?.state !== "recording") {
            beginVoiceCycle(stream, analyser);
          }
          return;
        }
      } else {
        consecutive = 0;
      }
      bargeInRafRef.current = requestAnimationFrame(monitor);
    }
    bargeInRafRef.current = requestAnimationFrame(monitor);
  }

  // Records one utterance on the already-open stream: starts a
  // MediaRecorder, watches the mic level via an AnalyserNode, and stops
  // itself once the person has spoken and then gone quiet for ~900ms (or
  // after a 15s hard cap). On stop, transcribes and auto-sends what was
  // said, then loops back into another cycle so the next thing you say
  // is picked up automatically — no re-clicking the mic needed.
  function beginVoiceCycle(stream: MediaStream, analyser: AnalyserNode) {
    if (!voiceModeRef.current) return;
    const mimeType = ["audio/mp4", "audio/webm", "audio/ogg"].find(
      (t) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(t)
    );
    // A low bitrate is plenty for speech (this isn't music) and keeps the
    // recorded blob small — a smaller upload to /voice/transcribe is a
    // direct, easy win on how long it takes before a reply starts coming
    // back after you stop talking.
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 32000,
    });
    audioChunksRef.current = [];
    voiceHasSpokenRef.current = false;
    recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);

    const data = new Uint8Array(analyser.fftSize);
    const SPEECH_THRESHOLD = 10; // amplitude deviation from silence (0-128 scale)
    const SILENCE_HOLD_MS = 700; // was 900 — every ms here is dead air the person waits through after they stop talking
    const MAX_UTTERANCE_MS = 15000;

    function monitor() {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const dev = Math.abs(data[i] - 128);
        if (dev > peak) peak = dev;
      }
      if (peak > SPEECH_THRESHOLD) {
        voiceHasSpokenRef.current = true;
        if (voiceSilenceTimerRef.current) {
          clearTimeout(voiceSilenceTimerRef.current);
          voiceSilenceTimerRef.current = null;
        }
      } else if (voiceHasSpokenRef.current && !voiceSilenceTimerRef.current) {
        voiceSilenceTimerRef.current = setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, SILENCE_HOLD_MS);
      }
      voiceRafRef.current = requestAnimationFrame(monitor);
    }
    voiceRafRef.current = requestAnimationFrame(monitor);
    voiceMaxDurationTimerRef.current = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, MAX_UTTERANCE_MS);

    recorder.onstop = async () => {
      stopVoiceCycleInternals();
      // Voice mode was switched off while this utterance was recording —
      // discard it instead of sending a message the person no longer
      // wants sent, and don't loop into another cycle.
      if (!voiceModeRef.current) {
        teardownVoiceMode();
        return;
      }
      const spoke = voiceHasSpokenRef.current;
      if (spoke) {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setIsTranscribing(true);
        try {
          const text = (await transcribeAudio(blob)).trim();
          if (text) {
            setInput("");
            // streamSpeech=true: sentences get spoken as they're generated
            // instead of waiting for the full reply, so the AI starts
            // talking almost immediately. Barge-in (see startBargeInMonitor)
            // can cut this off early if the person starts talking again.
            await send(false, false, text, true);
            // Let the AI finish "talking" before we start listening again
            // — otherwise the mic would immediately pick its own reply
            // back up as if the person had said it themselves. If the
            // person barges in, interruptSpeech() already drains the
            // queue and this resolves right away.
            if (voiceModeRef.current && ttsEnabled) {
              await waitForTtsDrain();
            }
          }
        } catch {
          setMicError("Couldn't reach the transcription service. You can still type your message.");
        } finally {
          setIsTranscribing(false);
        }
      }
      if (voiceModeRef.current) beginVoiceCycle(stream, analyser);
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
  }

  async function toggleRecording() {
    if (voiceMode) {
      voiceModeRef.current = false;
      setVoiceMode(false);
      setIsRecording(false);
      interruptSpeech();
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop(); // onstop sees voiceModeRef=false and tears everything down
      } else {
        teardownVoiceMode();
      }
      return;
    }
    setMicError(null);
    // Same secure-context/API-presence gap as the camera below: on a
    // non-https origin (or a browser build without the API) calling
    // getUserMedia throws immediately, before any permission prompt —
    // so the button appeared to just do nothing on tap, with no clue why.
    if (!window.isSecureContext) {
      setMicError("Microphone access requires HTTPS. Serve this app over a secure (https://) connection to use it.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError("Microphone access isn't supported in this browser.");
      return;
    }
    try {
      // Constraints matter here for two reasons: echoCancellation is what
      // keeps the AI's own voice (coming out of the speakers) from being
      // picked back up as "the person is talking" — without it, barge-in
      // and the between-turn silence detection both get confused and feel
      // laggy/twitchy. The low, speech-only sample rate keeps the
      // recorded blob small, which matters more than it sounds: a smaller
      // upload to /voice/transcribe is the single biggest lever on how
      // long "duurt lang" feels after you stop talking.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000, // Whisper resamples to 16kHz internally anyway
        },
      });
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx: AudioContext = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024; // smaller = cheaper per-frame peak scan, plenty of resolution for level detection
      source.connect(analyser);

      voiceStreamRef.current = stream;
      voiceAudioCtxRef.current = audioCtx;
      voiceAnalyserRef.current = analyser;
      voiceModeRef.current = true;
      setVoiceMode(true);
      beginVoiceCycle(stream, analyser);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        setMicError("No microphone was found on this device.");
      } else if (name === "NotReadableError") {
        setMicError("The microphone couldn't be started — it may already be in use by another app.");
      } else if (name === "NotAllowedError" || name === "SecurityError") {
        setMicError("Microphone access was denied. Check your browser's site permissions and try again.");
      } else {
        setMicError("Microphone access was denied or is unavailable on this device.");
      }
    }
  }

  // Leaving the page mid voice-mode shouldn't leave the mic hot.
  useEffect(() => {
    return () => {
      voiceModeRef.current = false;
      teardownVoiceMode();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Runs the barge-in mic monitor exactly while the AI is talking during
  // voice mode — started as each reply starts speaking, stopped as soon as
  // it stops (either naturally or via interruptSpeech), so the person can
  // cut in at any point in the AI's reply, not just between turns.
  useEffect(() => {
    if (voiceMode && speakingId && voiceStreamRef.current && voiceAnalyserRef.current) {
      startBargeInMonitor(voiceStreamRef.current, voiceAnalyserRef.current);
    } else {
      stopBargeInMonitor();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode, speakingId]);


  // ---- Camera: opens the device webcam in a live preview modal so the
  // user can frame the shot before sending it to the model as an image. ----
  async function openCamera() {
    setCameraError(null);
    // getUserMedia is a secure-context-only API — on a plain http://
    // deployment it's simply absent from navigator.mediaDevices, so
    // calling it throws a generic TypeError immediately, before any
    // permission prompt. Without this check that always looked exactly
    // like "access denied", even when the real cause was no HTTPS or no
    // camera hardware at all.
    if (!window.isSecureContext) {
      setCameraError("Camera access requires HTTPS. Serve this app over a secure (https://) connection to use it.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setIsCameraOpen(true);
      // The <video> element only mounts once isCameraOpen flips, so attach
      // the stream on the next tick once the ref is available.
      requestAnimationFrame(() => {
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          cameraVideoRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
      // Distinguish the actual cause instead of one blanket message — a
      // real permission denial, no camera present, and the camera being
      // in use by another app are different problems with different
      // fixes, and lumping them together made this look "always broken".
      const name = err instanceof Error ? err.name : "";
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        setCameraError("No camera was found on this device.");
      } else if (name === "NotReadableError") {
        setCameraError("The camera couldn't be started — it may already be in use by another app.");
      } else if (name === "NotAllowedError" || name === "SecurityError") {
        setCameraError("Camera access was denied. Check your browser's site permissions and try again.");
      } else {
        setCameraError("Camera access was denied or is unavailable on this device.");
      }
    }
  }

  function closeCamera() {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    setIsCameraOpen(false);
  }

  function capturePhoto() {
    const video = cameraVideoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = captureCanvasRef.current ?? document.createElement("canvas");
    captureCanvasRef.current = canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    // pendingImages/message rendering stores bare base64 and adds the
    // "data:image/...;base64," prefix itself — pushing the full data URL
    // here (as this used to) produced a double-prefixed, unparseable
    // image (the "broken image" bug).
    const base64 = dataUrl.split(",")[1] ?? dataUrl;
    setPendingImages((prev) => (prev.length >= 4 ? prev : [...prev, base64]));
    closeCamera();
  }

  // ---- Screen capture: uses the browser's native screen/window/tab
  // picker (getDisplayMedia), grabs a single frame, and attaches it the
  // same way as a picked image. No recording/storage — the stream is
  // stopped immediately after the frame is captured, so nothing is kept
  // beyond the one screenshot the user sees attached below the input box.
  async function captureScreen() {
    if (pendingImages.length >= 4) return;
    setCameraError(null);
    // getDisplayMedia is a secure-context-only API: on a plain http://
    // deployment (no TLS) it's simply undefined, so calling it throws
    // immediately and, without this check, would look exactly like the
    // button "doing nothing". Surface that clearly instead of failing
    // silently — same for browsers that don't implement it at all.
    if (!window.isSecureContext) {
      setCameraError("Screen sharing requires HTTPS. Serve this app over a secure (https://) connection to use it.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCameraError("Screen sharing isn't supported in this browser.");
      return;
    }
    setIsCapturingScreen(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      // ImageCapture gives a clean single-frame grab without needing to
      // render into a <video> element first.
      if ("ImageCapture" in window) {
        const capture = new (window as unknown as { ImageCapture: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture(track);
        const bitmap = await capture.grabFrame();
        if (bitmap.width === 0 || bitmap.height === 0) {
          throw new Error("Captured frame was empty");
        }
        const canvas = captureCanvasRef.current ?? document.createElement("canvas");
        captureCanvasRef.current = canvas;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
          const base64 = dataUrl.split(",")[1] ?? dataUrl;
          setPendingImages((prev) => (prev.length >= 4 ? prev : [...prev, base64]));
        }
      } else {
        // Fallback for browsers without the ImageCapture API: draw one
        // frame from a hidden <video> element instead. A single
        // requestAnimationFrame isn't enough here — the video's metadata
        // (and therefore videoWidth/videoHeight) often isn't ready yet by
        // then, which used to silently produce and attach a 0×0/corrupt
        // frame (the "broken image" the user saw). Wait for real
        // dimensions instead, with a timeout so a failure surfaces as an
        // error rather than a broken thumbnail.
        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();
        await new Promise<void>((resolve, reject) => {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            resolve();
            return;
          }
          const onLoaded = () => {
            cleanup();
            resolve();
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for the screen share frame"));
          }, 4000);
          function cleanup() {
            clearTimeout(timer);
            video.removeEventListener("loadedmetadata", onLoaded);
          }
          video.addEventListener("loadedmetadata", onLoaded);
        });
        const canvas = captureCanvasRef.current ?? document.createElement("canvas");
        captureCanvasRef.current = canvas;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
          const base64 = dataUrl.split(",")[1] ?? dataUrl;
          setPendingImages((prev) => (prev.length >= 4 ? prev : [...prev, base64]));
        }
      }
    } catch (err) {
      // NotAllowedError = user cancelled the picker or denied permission —
      // that's an expected, silent no-op. Anything else is unexpected and
      // worth surfacing so the button doesn't look broken.
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError") {
        setCameraError("Couldn't capture the screen. Please try again.");
      }
      // nothing to attach.
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setIsCapturingScreen(false);
    }
  }

  // ---- Voice output: Piper WAV playback, driving the avatar overlay's
  // CSS mouth-movement approximation. One message speaks at a time.
  // Returns a promise that resolves once playback finishes (or fails/is
  // stopped), so voice mode can wait for the AI to finish "talking"
  // before it starts listening again — otherwise the mic would just
  // pick the reply back up as if the person had said it. ----
  function playText(text: string, messageId: string): Promise<void> {
    if (speakingId === messageId) {
      interruptSpeech();
      return Promise.resolve();
    }
    // Manual "Read aloud" always wins over anything already queued/playing
    // (e.g. a leftover streaming-TTS reply) — stop that first so they
    // don't talk over each other.
    interruptSpeech();
    const myGeneration = ttsGenerationRef.current;
    setSpeakingId(messageId);

    return speakText(text)
      .then(
        (url) =>
          new Promise<void>((resolve) => {
            if (myGeneration !== ttsGenerationRef.current) return resolve();
            const audio = new Audio(url);
            audioPlayerRef.current = audio;
            audio.onended = () => {
              if (myGeneration === ttsGenerationRef.current) setSpeakingId(null);
              resolve();
            };
            audio.onerror = () => {
              if (myGeneration === ttsGenerationRef.current) setSpeakingId(null);
              resolve();
            };
            audio.play().catch(() => {
              if (myGeneration === ttsGenerationRef.current) setSpeakingId(null);
              resolve();
            });
          })
      )
      .catch(() => {
        if (myGeneration === ttsGenerationRef.current) setSpeakingId(null);
      });
  }

  async function copyMessage(text: string, messageId: string) {
    await copyToClipboard(text);
    setCopiedId(messageId);
    setTimeout(() => setCopiedId((cur) => (cur === messageId ? null : cur)), 1500);
  }

  async function handleExportPdf(messageId: string) {
    if (exportingId) return;
    setExportingId(messageId);
    try {
      await exportMessageToPdf(`msg-content-${messageId}`, `visiyon-${messageId}.pdf`);
    } catch {
      // Best-effort — if the browser blocks it or the element is gone,
      // there's nothing else useful to do here.
    } finally {
      setExportingId(null);
    }
  }

  async function toggleRating(messageId: string, value: 1 | -1) {
    if (!chatId) return;
    const current = messages.find((m) => m.id === messageId)?.rating ?? null;
    const next = current === value ? null : value; // clicking the same thumb again clears it
    setMessageRating(messageId, next); // optimistic
    try {
      await rateMessage(chatId, messageId, next);
    } catch {
      setMessageRating(messageId, current); // revert on failure
    }
  }

  async function handleRunAction(actionId: string, messageId: string, content: string) {
    setRunningActionId(actionId);
    setActionResult(null);
    try {
      const { body } = await runAction(actionId, content);
      setActionResult({ messageId, text: body?.message || JSON.stringify(body) });
    } catch (err: any) {
      setActionResult({ messageId, text: err?.message || "Action failed" });
    } finally {
      setRunningActionId(null);
    }
  }

  // Whether the composer shows its full toolbar (model picker, mic, send)
  // or the compact collapsed pill (just a plain mic icon) — expanded
  // whenever the box is focused, has content worth keeping visible for,
  // or a response is actively streaming (the stop button must never
  // disappear mid-generation just because the box isn't focused).
  const composerExpanded =
    composerFocused || Boolean(input.trim()) || pendingImages.length > 0 || unsentDocsMeta.length > 0 || isStreaming;
  // A document that's still PENDING/PROCESSING has no chunks to retrieve
  // yet — sending while that's true used to produce a reply with no
  // document context at all, since the RAG step only reads READY docs.
  // Block send until every attached doc has settled (READY, or FAILED —
  // a failed doc shouldn't hold the conversation hostage).
  const docsStillProcessing = attachedDocsMeta.some((d) => d.status === "PENDING" || d.status === "PROCESSING");

  const inputBar = (
    <>
      {imageMode && (
        <div className="max-w-3xl mx-auto mb-2 flex items-center gap-1.5 text-[12px] text-visiyon-text-2">
          <ImageIcon size={12} /> Your next message will be used as an image generation prompt
        </div>
      )}
      {showLimitWarning && (
        <div className="max-w-3xl mx-auto mb-1.5 px-2">
          <div className="flex items-center justify-center gap-2 rounded-[2px] px-3 py-2 text-[13px] text-center mx-auto w-fit max-w-md bg-visiyon-bg text-visiyon-text">
            <AlertTriangle size={14} />
            <span>
              You've used {Math.round(usagePct * 100)}% of your session limit
              {usage?.windowHours ? ` (resets in the next ${usage.windowHours}h window)` : ""}.
            </span>
            <button
              onClick={() => setLimitWarningDismissed(true)}
              className="opacity-70 hover:opacity-100 transition-opacity"
              title="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      <div
        ref={inputBarWrapRef}
        className={`max-w-3xl mx-auto relative rounded-2xl transition-shadow ${
          isDraggingFile ? "ring-2 ring-white/40" : ""
        }`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setIsDraggingFile(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setIsDraggingFile(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingFile(false);
          // stopPropagation above means the page-wide drop zone's own onDrop
          // (which normally resets these) won't fire — reset them here too,
          // or the full-page drag overlay can get stuck visible.
          dragCounterRef.current = 0;
          setIsDraggingFilePage(false);
          handleFilesDropped(Array.from(e.dataTransfer.files));
        }}
      >
        {isDraggingFile && (
          <div className="absolute inset-0 z-40 rounded-2xl bg-black/70 border-2 border-dashed border-white/50 flex items-center justify-center pointer-events-none">
            <span className="text-[13px] text-white/80 flex items-center gap-2">
              <ImagePlus size={16} /> Drop image or document to attach
            </span>
          </div>
        )}
        {uploadingDocs && !isDraggingFile && (
          <div className="absolute -top-8 left-0 right-0 flex justify-center pointer-events-none">
            <span className="text-[12px] text-visiyon-text-3 bg-black/80 rounded-full px-3 py-1">
              Uploading document…
            </span>
          </div>
        )}
        {showSuggestions && suggestions.length > 0 && (
          <div
            className={`menu-popup absolute left-0 right-0 bg-visiyon-bg rounded-2xl visiyon-elevated-md overflow-hidden z-30 py-1 ${
              messages.length === 0 ? "top-full mt-2" : "bottom-full mb-2"
            }`}
          >
            {suggestions.map((s, i) => (
              <button
                key={`${s.type}-${s.text}`}
                type="button"
                onMouseDown={(e) => {
                  // onMouseDown (not onClick) so this fires before the
                  // textarea's blur/click-outside handler closes the menu.
                  e.preventDefault();
                  applySuggestion(s.text);
                }}
                onMouseEnter={() => setActiveSuggestionIdx(i)}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-[13.5px] transition-colors ${
                  activeSuggestionIdx === i ? "bg-visiyon-text/[0.08] text-visiyon-text" : "text-visiyon-text-2"
                }`}
              >
                {s.type === "history" ? <RotateCcw size={13} className="shrink-0 opacity-60" /> : <Zap size={13} className="shrink-0 opacity-60" />}
                <span className="truncate flex-1">{s.text}</span>
                {s.type === "history" && (
                  <span
                    role="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removePromptFromHistory(s.text);
                      setPromptHistory(getPromptHistory());
                    }}
                    className="shrink-0 p-0.5 rounded-full text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/10"
                    title="Remove from history"
                  >
                    <X size={11} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {!previewOpen && Object.keys(previewBlocks).length > 0 && (
          <div className="w-fit mb-1.5 px-1">
            <button
              onClick={showPreview}
              title="Reopen preview"
              className="cursor-pointer group relative flex items-center gap-2.5 bg-[#161616]/95 backdrop-blur-xl border border-white/10 rounded-2xl pl-2 pr-3.5 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.5)] hover:border-white/20 transition-colors"
            >
              <span className="relative shrink-0 h-9 w-9 rounded-lg bg-white overflow-hidden">
                {/* Miniature, non-interactive facsimile of the code lines —
                    just a visual hint of "there's a document here", not an
                    actual render of the content. */}
                <span className="absolute inset-0 flex flex-col justify-center gap-[3px] px-1.5">
                  <span className="h-[2px] w-[70%] rounded-full bg-violet-400/70" />
                  <span className="h-[2px] w-[85%] rounded-full bg-neutral-300" />
                  <span className="h-[2px] w-[55%] rounded-full bg-neutral-300" />
                  <span className="h-[2px] w-[65%] rounded-full bg-sky-400/70" />
                </span>
              </span>
              <span className="text-[12.5px] font-medium text-visiyon-text truncate max-w-[160px]">
                {previewFileName || "index.html"}
              </span>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissPreview();
                }}
                title="Dismiss"
                className="cursor-pointer shrink-0 flex items-center justify-center h-5 w-5 rounded-full bg-visiyon-panel2 border border-white/10 text-visiyon-text-2 hover:text-visiyon-text opacity-0 group-hover:opacity-100 transition-opacity -mr-1"
              >
                <X size={11} />
              </span>
            </button>
          </div>
        )}
        <NotifyBanner />
        <div className="rounded-[13px] visiyon-rgb-wrap">
        <div
          className={`chat-input-bar relative z-[1] flex flex-wrap items-center gap-1 px-2 transition-[min-height,padding,colors] duration-150 rounded-[13px] shadow-[0_4px_16px_rgba(0,0,0,0.6)] bg-[#161616]/95 backdrop-blur-xl ${
            composerExpanded ? "py-2 min-h-[56px]" : "py-1 min-h-[44px]"
          }`}
        >
          {(pendingImages.length > 0 || unsentDocsMeta.length > 0) && (
            <div className="w-full order-0 basis-full flex flex-wrap items-center gap-2 px-1 pt-1 pb-2">
              {unsentDocsMeta.map((doc) => {
                const ext = doc.filename.split(".").pop()?.toUpperCase() || "FILE";
                return (
                  <div
                    key={doc.id}
                    className="group relative flex items-center gap-2 h-14 pl-2.5 pr-3 rounded-xl border border-white/10 bg-white/[0.04] text-visiyon-text-2"
                  >
                    <a
                      href={documentDownloadUrl(doc.id)}
                      download={doc.filename}
                      title={`${doc.filename} downloaden`}
                      className="flex items-center gap-2 min-w-0 no-underline text-inherit"
                    >
                      <div className="shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-white/[0.06]">
                        {doc.status === "PENDING" || doc.status === "PROCESSING" ? (
                          <Loader2 size={16} className="animate-spin text-visiyon-text-2" />
                        ) : (
                          <FileText size={16} className="text-visiyon-text-2" />
                        )}
                      </div>
                      <div className="min-w-0 max-w-[140px]">
                        <div className="text-[12.5px] font-medium text-visiyon-text truncate">{doc.filename}</div>
                        <div className="text-[11px] text-visiyon-text-3">
                          {doc.status === "PENDING" || doc.status === "PROCESSING"
                            ? "Verwerken…"
                            : doc.status === "FAILED"
                              ? "Mislukt"
                              : ext}
                        </div>
                      </div>
                    </a>
                    <button
                      onClick={async () => {
                        setAttachedDocIds((prev) => prev.filter((id) => id !== doc.id));
                        setAttachedDocsMeta((prev) => prev.filter((d) => d.id !== doc.id));
                        if (chatId) {
                          try {
                            await detachDocument(chatId, doc.id);
                          } catch {
                            // best-effort — UI already reflects the removal
                          }
                        }
                      }}
                      title="Remove"
                      className="absolute -top-2 -right-2 flex items-center justify-center h-6 w-6 rounded-full bg-[#3a3a3a] border border-white/15 text-white shadow-md hover:bg-[#4a4a4a] transition-colors"
                    >
                      <X size={14} strokeWidth={2.5} />
                    </button>
                  </div>
                );
              })}
              {pendingImages.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={`data:image/png;base64,${img}`}
                    alt="Attached"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleOpenImage(`data:image/png;base64,${img}`, "Attached", undefined)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleOpenImage(`data:image/png;base64,${img}`, "Attached", undefined);
                      }
                    }}
                    className="h-16 w-16 object-cover rounded-lg border border-white/10 cursor-zoom-in"
                  />
                  <button
                    onClick={() => setPendingImages((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-visiyon-panel2 border border-white/10 rounded-full p-0.5 text-visiyon-text-2 hover:text-visiyon-text opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="relative shrink-0 order-2" ref={attachMenuRef}>
            <button
              onClick={() => {
                setShowAttachMenu((v) => {
                  const next = !v;
                  if (!next) {
                    setExpandedSubPanel(null);
                    setForceOpenDocsPanel(false);
                  }
                  return next;
                });
              }}
              className={`flex items-center justify-center h-9 w-9 rounded-full text-visiyon-text transition-colors ${
                showAttachMenu || webSearch || imageMode || agentMode ? "bg-visiyon-text/15" : "hover:bg-visiyon-text/10"
              }`}
              title="Attach & tools"
            >
              <Plus size={18} />
            </button>
            {showAttachMenu && (
                <div
                  className={`menu-popup absolute left-0 bg-visiyon-bg border border-visiyon-border rounded-xl z-20 visiyon-elevated-md overflow-visible ${
                    messages.length === 0 ? "top-full mt-2" : "bottom-full mb-2"
                  } ${expandedSubPanel ? "w-auto max-w-[calc(100vw-2rem)]" : "w-56 max-w-[calc(100vw-2rem)]"}`}
                >
                  {/* Scroll/clip lives on this inner wrapper, never the
                      outer one — the outer box carries the shadow, and an
                      element's own overflow (hidden/auto/scroll) clips its
                      own box-shadow, since the shadow paints outside the
                      box but the overflow clip region only covers the box
                      itself. Outer must stay overflow-visible or the
                      shadow gets cut into a hard, lopsided edge again.
                      rounded-xl here (matching the outer corners) keeps
                      hovered rows from squaring off past the rounded
                      corners now that the outer box no longer clips them. */}
                  <div
                    ref={attachMenuPopupRef}
                    style={{ maxHeight: expandedSubPanel ? undefined : attachMenuMaxHeight ?? 420 }}
                    className={
                      expandedSubPanel
                        ? "rounded-xl py-0"
                        : "rounded-xl overflow-y-auto overflow-x-hidden py-1"
                    }
                  >
                  {!expandedSubPanel && (
                    <>
                      <button
                        onClick={() => {
                          imageInputRef.current?.click();
                          setShowAttachMenu(false);
                        }}
                        disabled={pendingImages.length >= 4}
                        className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors disabled:opacity-40 ${imageUploadEnabled ? "" : "hidden"}`}
                      >
                        <span className="flex items-center gap-2.5">
                          <ImagePlus size={15} /> Attach image
                        </span>
                        <span className="text-[11px] text-visiyon-text-3">Ctrl U</span>
                      </button>
                      <button
                        onClick={() => {
                          openCamera();
                          setShowAttachMenu(false);
                        }}
                        disabled={isCameraOpen || pendingImages.length >= 4}
                        title="Use camera — let the AI see what you see"
                        className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors disabled:opacity-40 ${cameraCaptureEnabled ? "" : "hidden"}`}
                      >
                        <span className="flex items-center gap-2.5">
                          <Camera size={15} /> Use camera
                        </span>
                        <span className="text-[11px] text-visiyon-text-3">Ctrl Shift U</span>
                      </button>
                      <button
                        onClick={() => {
                          captureScreen();
                          setShowAttachMenu(false);
                        }}
                        disabled={isCapturingScreen || pendingImages.length >= 4}
                        title="Share your screen — let the AI see it"
                        className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors disabled:opacity-40 ${screenShareEnabled ? "" : "hidden"}`}
                      >
                        <span className="flex items-center gap-2.5">
                          {isCapturingScreen ? <Loader2 size={15} className="animate-spin" /> : <ScreenShare size={15} />}
                          Share screen
                        </span>
                        <span className="text-[11px] text-visiyon-text-3">Ctrl Shift E</span>
                      </button>
                      <button
                        onClick={() => {
                          composerPopoutOpen ? closeComposerPopout() : openComposerPopout();
                          setShowAttachMenu(false);
                        }}
                        title={composerPopoutOpen ? "Close the popped-out composer window" : "Pop the composer out into its own window"}
                        className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                      >
                        <span className="flex items-center gap-2.5">
                          <PictureInPicture2 size={15} /> Pop-out composer
                        </span>
                        {composerPopoutOpen ? <Check size={14} /> : <span className="text-[11px] text-visiyon-text-3">Ctrl Shift .</span>}
                      </button>
                      <button
                        onClick={() => {
                          setWebSearch((v) => !v);
                          setShowAttachMenu(false);
                        }}
                        className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                      >
                        <span className="flex items-center gap-2.5">
                          <Globe size={15} /> Web search
                        </span>
                        {webSearch ? <Check size={14} /> : <span className="text-[11px] text-visiyon-text-3">Ctrl Shift J</span>}
                      </button>
                      <button
                        onClick={handleImprovePrompt}
                        disabled={!input.trim() || isImprovingPrompt}
                        title="Turn your short idea into a full, detailed prompt"
                        className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors disabled:opacity-40"
                      >
                        <span className="flex items-center gap-2.5">
                          {isImprovingPrompt ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
                          Improve prompt
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          setAgentMode(!agentMode);
                          setShowAttachMenu(false);
                        }}
                        title="Let the AI run several steps/tools on its own in one turn"
                        className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                      >
                        <span className="flex items-center gap-2.5">
                          <Bot size={15} /> Cowork
                        </span>
                        {agentMode ? <Check size={14} /> : <span className="text-[11px] text-visiyon-text-3">Ctrl Shift L</span>}
                      </button>
                      {imageGenAvailable && (
                        <button
                          onClick={() => {
                            setImageMode((v) => !v);
                            setShowAttachMenu(false);
                          }}
                          className="w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                        >
                          <span className="flex items-center gap-2.5">
                            <ImageIcon size={15} /> Generate image
                          </span>
                          {imageMode ? <Check size={14} /> : <span className="text-[11px] text-visiyon-text-3">Ctrl Shift G</span>}
                        </button>
                      )}
                    </>
                  )}
                  {documentUploadEnabled && (!expandedSubPanel || expandedSubPanel === "documents") && (
                    <DocumentPanel
                      chatId={chatId}
                      ensureChatId={ensureChat}
                      attachedIds={attachedDocIds}
                      onAttachedChange={(ids) => {
                        // Keep attachedDocsMeta (used by the composer's
                        // file cards) in sync — DocumentPanel only knows
                        // ids, not filenames, so re-fetch the chat's
                        // actual document list rather than let the two
                        // states drift apart (which was masking real
                        // attach/detach state from the composer).
                        setAttachedDocIds(ids);
                        const id = chatId;
                        if (id) {
                          listChatDocuments(id)
                            .then((docs) => setAttachedDocsMeta(docs.map((d) => ({ id: d.id, filename: d.filename, status: d.status }))))
                            .catch(() => {});
                        } else {
                          setAttachedDocsMeta((prev) => prev.filter((d) => ids.includes(d.id)));
                        }
                      }}
                      asMenuItem
                      forceOpen={forceOpenDocsPanel}
                      onOpened={() => setExpandedSubPanel("documents")}
                      onClosed={() => {
                        setExpandedSubPanel(null);
                        setForceOpenDocsPanel(false);
                      }}
                    />
                  )}
                  {toolsMenuEnabled && (!expandedSubPanel || expandedSubPanel === "tools") && (
                    <ToolsPanel
                      chatId={chatId}
                      ensureChatId={ensureChat}
                      attachedIds={attachedToolIds}
                      onAttachedChange={setAttachedToolIds}
                      asMenuItem
                      onOpened={() => setExpandedSubPanel("tools")}
                      onClosed={() => setExpandedSubPanel(null)}
                    />
                  )}
                  {(!expandedSubPanel || expandedSubPanel === "prompts") && (
                    <PromptLibrary
                      chatId={chatId}
                      activeSystemPrompt={systemPrompt}
                      onApply={(content) => setSystemPrompt(content || null)}
                      asMenuItem
                      onOpened={() => setExpandedSubPanel("prompts")}
                      onClosed={() => setExpandedSubPanel(null)}
                    />
                  )}
                  </div>
                </div>
            )}
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleImagePick(e.target.files)}
          />
          <textarea
            ref={textareaRef}
            value={input}
            // The browser's own autofill (saved form entries, sometimes
            // showing a stray contact-card-like popup) was competing with
            // typing here — autoComplete="off" plus a random name stops
            // Chrome/Edge from treating this as a fillable form field.
            // spellCheck + lang="en" gives real red-squiggly English
            // spelling corrections instead.
            autoComplete="off"
            autoCorrect="off"
            name="chat-message-input"
            spellCheck={true}
            lang="en"
            onChange={(e) => {
              setInput(e.target.value);
              setShowSuggestions(e.target.value.trim().length > 0);
              setActiveSuggestionIdx(-1);
            }}
            onFocus={() => {
              setComposerFocused(true);
              if (input.trim().length > 0) setShowSuggestions(true);
            }}
            onBlur={() => setComposerFocused(false)}
            onKeyDown={(e) => {
              if (showSuggestions && suggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveSuggestionIdx((prev) => (prev + 1) % suggestions.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveSuggestionIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowSuggestions(false);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && activeSuggestionIdx >= 0)) {
                  e.preventDefault();
                  applySuggestion(suggestions[Math.max(activeSuggestionIdx, 0)].text);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setShowSuggestions(false);
                send();
              }
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const item of Array.from(items)) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (file) files.push(file);
                }
              }
              if (files.length > 0) {
                // Pasted a screenshot/image — attach it like a picked file
                // instead of letting it fall through into the text.
                e.preventDefault();
                const dt = new DataTransfer();
                files.forEach((f) => dt.items.add(f));
                handleImagePick(dt.files);
              }
            }}
            rows={1}
            placeholder={messages.length === 0 && !input ? typedPlaceholder || "Ask anything" : "Ask anything"}
            className="w-full order-1 min-w-0 bg-transparent outline-none resize-none py-1 text-[14px] max-h-[240px] text-visiyon-text placeholder-visiyon-text-3/40"
          />
          <div className="flex items-center gap-1 shrink-0 order-4 ml-auto">
            {composerExpanded ? (
              // Expanded toolbar — matches the full composer: avatar toggle,
              // model picker, mic, send/stop.
              <>
                {aiFaceAvatarEnabled && (
                  <button
                    onClick={() => setShowAvatar(!showAvatar)}
                    className={`flex items-center justify-center h-9 w-9 rounded-full transition-colors ${
                      showAvatar ? "bg-visiyon-text/10 text-visiyon-text" : "text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text"
                    }`}
                    title={showAvatar ? "Hide AI avatar" : "Show AI avatar"}
                  >
                    <AIFaceAvatar
                      audioRef={audioPlayerRef}
                      isSpeaking={speakingId !== null}
                      isGenerating={isStreaming}
                      gazeX={avatarGaze.x}
                      gazeY={avatarGaze.y}
                      expression={avatarExpression}
                      trigger={avatarTrigger}
                      size={20}
                    />
                  </button>
                )}
                <ModelSelector
                  compact
                  dropUp={messages.length > 0}
                  value={selectedModel || ""}
                  onChange={(m) => {
                    setSelectedModel(m);
                    if (chatId) setChatParameters(chatId, { model: m }).catch(() => {});
                  }}
                />
                {sttEnabled && (
                  <button
                    onClick={toggleRecording}
                    className={`flex items-center justify-center h-9 w-9 rounded-full transition-colors ${
                      voiceMode ? "text-red-400" : "text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text"
                    }`}
                    title={voiceMode ? "Stop voice mode" : "Start voice mode (speaks and sends automatically)"}
                  >
                    {isTranscribing ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
                  </button>
                )}
                {isStreaming ? (
                  <button
                    onClick={stopGenerating}
                    className="group flex items-center justify-center h-9 w-9 rounded-full bg-white text-black hover:bg-visiyon-text/80 transition-colors"
                    title="Stop generating"
                  >
                    <Square size={16} className="hidden group-hover:block" />
                    <span className="block group-hover:hidden">
                      <SendWaveIcon size={16} active />
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={() => send()}
                    className="flex items-center justify-center h-9 w-9 rounded-full bg-white text-black hover:bg-visiyon-text/80 transition-colors disabled:opacity-40"
                    disabled={
                      (!input.trim() && pendingImages.length === 0 && attachedDocIds.length === 0) ||
                      isGeneratingImage ||
                      docsStillProcessing
                    }
                    title={docsStillProcessing ? "Wachten tot het document verwerkt is…" : "Send"}
                  >
                    {isGeneratingImage ? <Loader2 size={16} className="animate-spin" /> : <SendWaveIcon size={16} />}
                  </button>
                )}
              </>
            ) : (
              // Collapsed toolbar — just a plain mic button, like the
              // compact pill in the reference (no model name, no send
              // circle) until the composer is actually focused or has
              // content, at which point it swaps to the full row above.
              sttEnabled && (
                <button
                  onClick={toggleRecording}
                  className="flex items-center justify-center h-9 w-9 rounded-full text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
                  title="Start voice mode (speaks and sends automatically)"
                >
                  <Mic size={16} />
                </button>
              )
            )}
          </div>
        </div>
        </div>
      </div>
    </>
  );

  return (
    <div
      className="flex flex-row h-full flex-1 w-full min-w-0 relative"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounterRef.current += 1;
        setIsDraggingFilePage(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        // Required so the browser allows a drop here at all — without
        // this, onDrop never fires and the OS shows the "forbidden" cursor.
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setIsDraggingFilePage(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounterRef.current = 0;
        setIsDraggingFilePage(false);
        handleFilesDropped(Array.from(e.dataTransfer.files));
      }}
    >
      {isDraggingFilePage && (
        <div className="fixed inset-0 z-[70] bg-white/70 dark:bg-black/70 backdrop-blur-md flex items-center justify-center pointer-events-none">
          <div className="m-6 flex-1 h-full max-h-[calc(100%-3rem)] w-full max-w-[calc(100%-3rem)] rounded-3xl border-2 border-dashed border-black/25 dark:border-white/25 flex flex-col items-center justify-center gap-3 text-black dark:text-white">
            <ImagePlus size={32} className="text-black/70 dark:text-white/70" />
            <p className="text-[17px] font-medium">Drop files to add to the conversation</p>
            <p className="text-[13px] text-black/50 dark:text-white/50">Images, or PDF, DOCX, TXT, MD, CSV, and ZIP files</p>
          </div>
        </div>
      )}
    <div className="flex flex-col h-full flex-1 w-full min-w-0">
      <div
        className={`h-12 flex items-center justify-between px-4 sm:px-6 gap-2 relative z-20 ${
          chatId && messages.length > 0 && scrolledDown ? "visiyon-elevated-sm" : ""
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => {
              setMobileSidebarOpen(true);
              setDesktopSidebarCollapsed(false);
            }}
            className={`text-visiyon-text-2 hover:text-visiyon-text p-1 shrink-0 ${desktopSidebarCollapsed ? "" : "lg:hidden"}`}
            title="Open menu"
          >
            <Menu size={20} />
          </button>
          {chatId && (
            renamingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitleRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitTitleRename(); }
                  if (e.key === "Escape") { e.preventDefault(); setRenamingTitle(false); }
                }}
                className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-visiyon-text border-b border-visiyon-text/30 focus:border-visiyon-text outline-none py-0.5"
              />
            ) : (
              <div className="relative min-w-0" ref={titleMenuRef}>
                <button
                  onClick={() => setTitleMenuOpen((v) => !v)}
                  className="flex items-center gap-1 min-w-0 px-1.5 py-1 rounded-lg hover:bg-visiyon-text/[0.06] transition-colors"
                  title={chatTitle || "Chat"}
                >
                  <span className="truncate max-w-[52vw] sm:max-w-xs text-[14px] font-medium text-visiyon-text">
                    {chatTitle || "New chat"}
                  </span>
                  <ChevronDown size={14} className="text-visiyon-text-3 shrink-0" />
                </button>
                {titleMenuOpen && (
                  <div className="absolute top-[calc(100%+4px)] left-0 w-52 bg-visiyon-panel border border-visiyon-border rounded-[8px] shadow-[0_4px_16px_-2px_rgba(0,0,0,0.25)] dark:shadow-[0_4px_16px_-2px_rgba(0,0,0,0.6)] py-1.5 z-50">
                    <button
                      onClick={startRenamingTitle}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
                    >
                      <Pencil size={14} /> Rename
                    </button>
                    <button
                      onClick={toggleChatPinned}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
                    >
                      {isPinned ? <PinOff size={14} /> : <Pin size={14} />} {isPinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                      onClick={() => { setTitleMenuOpen(false); toggleShare(); }}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
                    >
                      <Share2 size={14} /> {isShared ? "Stop sharing" : "Share"}
                    </button>
                    <button
                      onClick={() => { setTitleMenuOpen(false); archiveCurrentChat(); }}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
                    >
                      {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {isArchived ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      onClick={() => { setTitleMenuOpen(false); deleteCurrentChat(); }}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-visiyon-text/[0.06] rounded-[6px]"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={toggleServerPanel}
            className={`flex items-center gap-1.5 text-[12.5px] px-2 sm:px-3 py-1.5 rounded-lg transition-colors ${
              serverPanelOpen ? "bg-white text-black" : "bg-visiyon-panel2 text-visiyon-text-2 hover:bg-visiyon-text/10"
            }`}
            title="Browse files on your connected server"
          >
            <HardDrive size={13} />
            <span className="hidden sm:inline">Server files</span>
          </button>
          {upgradeButtonEnabled && (
            <button
              onClick={() => setShowBuyCredits(true)}
              className="group flex items-center gap-1.5 text-[12.5px] font-semibold px-2.5 sm:px-3.5 py-1.5 rounded-lg text-black bg-gradient-to-b from-white to-visiyon-text/85 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_6px_14px_-6px_rgba(0,0,0,0.5)] transition-all duration-150 hover:shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_8px_18px_-6px_rgba(0,0,0,0.6)] hover:-translate-y-[1px] active:translate-y-0"
              title="Buy credits"
            >
              <Zap size={13} className="fill-black/80 text-black/80 transition-transform group-hover:scale-110" />
              <span className="hidden sm:inline">Buy credits</span>
            </button>
          )}
          {(chatControlsEnabledByModel[selectedModel || ""] ?? true) &&
            (chatControlsButtonEnabled || currentUser?.role === "ADMIN") && (
            <button
              onClick={() => setShowControls((v) => !v)}
              className={`flex items-center gap-1.5 text-[12.5px] px-2 sm:px-3 py-1.5 rounded-lg transition-colors ${
                showControls ? "bg-white text-black" : "bg-visiyon-panel2 text-visiyon-text-2 hover:bg-visiyon-text/10"
              }`}
              title="Chat Controls"
            >
              <Wrench size={13} />
              <span className="hidden sm:inline">Controls</span>
            </button>
          )}
          {chatId && (
            <>
            {isShared && shareId && (
              <button
                onClick={copyShareLink}
                className="flex items-center gap-1.5 text-[12.5px] px-2 sm:px-3 py-1.5 rounded-lg bg-visiyon-panel2 hover:bg-visiyon-text/10 transition-colors"
                title="Copy share link"
              >
                {shareCopied ? <Check size={13} /> : <Link2 size={13} />}
                <span className="hidden sm:inline">{shareCopied ? "Copied" : "Copy link"}</span>
              </button>
            )}
            <button
              onClick={toggleShare}
              className={`flex items-center gap-1.5 text-[12.5px] px-2 sm:px-3 py-1.5 rounded-lg transition-colors ${
                isShared ? "bg-white text-black" : "bg-visiyon-panel2 text-visiyon-text-2 hover:bg-visiyon-text/10"
              }`}
              title={isShared ? "Stop sharing this chat" : "Share this chat via a public read-only link"}
            >
              <Share2 size={13} />
              <span className="hidden sm:inline">{isShared ? "Shared" : "Share"}</span>
            </button>
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setShowMoreMenu((v) => !v)}
                className={`flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
                  showMoreMenu ? "bg-visiyon-text/15" : "bg-visiyon-panel2 text-visiyon-text-2 hover:bg-visiyon-text/10"
                }`}
                title="More options"
              >
                <MoreHorizontal size={15} />
              </button>
              {showMoreMenu && (
                  <div className="absolute top-full right-0 mt-1.5 w-52 bg-visiyon-bg border border-visiyon-border rounded-xl overflow-hidden z-30 py-1 visiyon-elevated-md">
                    <button
                      onClick={openFilesInChat}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                    >
                      <FolderOpen size={15} /> View files in chat
                    </button>
                    <button
                      onClick={toggleChatPinned}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                    >
                      {isPinned ? <PinOff size={15} /> : <Pin size={15} />}
                      {isPinned ? "Unpin chat" : "Pin chat"}
                    </button>
                    <button
                      onClick={archiveCurrentChat}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                    >
                      {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />} {isArchived ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      onClick={deleteCurrentChat}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-red-400 hover:bg-visiyon-text/[0.06] transition-colors"
                    >
                      <Trash2 size={15} /> Delete
                    </button>
                  </div>
              )}
            </div>
            </>
          )}
        </div>
      </div>
      {showBuyCredits && (
        <BuyCreditsModal
          onClose={() => {
            setShowBuyCredits(false);
            setLimitResetAt(null);
          }}
        />
      )}

      <div className="relative flex-1 min-h-0">
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 right-0 h-8 z-10 bg-gradient-to-b from-visiyon-bg to-transparent"
        />
        <div
          ref={messagesScrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScrolledDown(el.scrollTop > 4);
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            setShowScrollToBottom(distanceFromBottom > 240);
          }}
          className={`absolute inset-0 flex flex-col ${messages.length === 0 ? "justify-center pb-[12vh] pt-0 overflow-visible" : "overflow-y-auto"}`}
        >
        <div className="max-w-3xl mx-auto px-6 py-8 w-full">
          {messages
            .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
            .map((m, i, visibleMessages) => (
            <MessageBubble
              key={m.id}
              m={m}
              i={i}
              isLast={i === visibleMessages.length - 1}
              isLastUserMessage={
                m.role === "USER" && !visibleMessages.slice(i + 1).some((x) => x.role === "USER")
              }
              isStreaming={isStreaming}
              activeTool={activeTool}
              editingId={editingId}
              editText={editText}
              setEditText={setEditText}
              setEditingId={setEditingId}
              submitEdit={submitEdit}
              cancelEdit={cancelEdit}
              copiedId={copiedId}
              copyMessage={copyMessage}
              exportingId={exportingId}
              onExportPdf={handleExportPdf}
              speakingId={speakingId}
              playText={playText}
              toggleRating={toggleRating}
              availableActions={availableActions}
              runningActionId={runningActionId}
              actionResult={actionResult}
              handleRunAction={handleRunAction}
              onRegenerate={() => send(true)}
              onContinue={() => send(false, true)}
              imagePrompt={
                m.role === "ASSISTANT" && m.content.includes("data:image/") && i > 0 && visibleMessages[i - 1].role === "USER"
                  ? visibleMessages[i - 1].content
                  : undefined
              }
              onEditImage={handleEditImage}
              onOpenImage={handleOpenImage}
              ttsEnabled={ttsEnabled}
              userName={currentUser?.name || "You"}
              userAvatarUrl={currentUser?.avatarUrl}
              modelDisplayNames={modelDisplayNames}
            />
          ))}
          {isGeneratingImage && <GeneratingImageCard prompt={generatingImagePrompt} />}
          <div ref={bottomRef} />
          {/* Spacer so the last message can scroll clear of the input bar
              overlaid at the bottom below — without this the bar would
              cover the tail end of the conversation. */}
          {messages.length > 0 && <div className="h-28" />}
        </div>
        {messages.length === 0 && (
          <div className="w-full max-w-3xl mx-auto px-4 pb-8">
            <div className="flex justify-center mb-4">
              {greetingLogoEnabled && (
                <SparkleAvatarIcon size={36} />
              )}
            </div>
            <p className="text-center text-[19px] text-visiyon-text mb-4">
              {(() => {
                const h = new Date().getHours();
                const greeting = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
                return currentUser?.name ? `${greeting}, ${currentUser.name}` : greeting;
              })()}
            </p>
            <LocationBanner />
            {inputBar}
            <div className="mt-3 space-y-0.5">
              <button
                onClick={() => {
                  setImageMode(true);
                  textareaRef.current?.focus();
                }}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-[13.5px] text-visiyon-text-2 hover:bg-visiyon-text/[0.05] hover:text-visiyon-text transition-colors"
              >
                <ImageIcon size={15} /> Create an image
              </button>
              <button
                onClick={() => textareaRef.current?.focus()}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-[13.5px] text-visiyon-text-2 hover:bg-visiyon-text/[0.05] hover:text-visiyon-text transition-colors"
              >
                <Pencil size={15} /> Write or edit
              </button>
              <button
                onClick={() => {
                  setWebSearch(true);
                  textareaRef.current?.focus();
                }}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-[13.5px] text-visiyon-text-2 hover:bg-visiyon-text/[0.05] hover:text-visiyon-text transition-colors"
              >
                <Globe size={15} /> Look something up
              </button>
            </div>
          </div>
        )}
        </div>

        {messages.length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 p-4 pointer-events-none">
            {showScrollToBottom && (
              <div className="flex justify-center mb-3 pointer-events-none">
                <button
                  onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth" })}
                  title="Scroll to bottom"
                  className="pointer-events-auto flex items-center justify-center h-9 w-9 rounded-full bg-visiyon-panel2 border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/10 shadow-lg transition-colors"
                >
                  <ChevronDown size={16} />
                </button>
              </div>
            )}
            <div className="pointer-events-auto">{inputBar}</div>
          </div>
        )}
      </div>
    </div>
    <PreviewPanel />
    <ServerFilesPanel />
    {showControls && (
      <ChatControlsPanel
        chatId={chatId}
        onClose={() => setShowControls(false)}
        onSystemPromptChange={setSystemPrompt}
      />
    )}
    {showAvatar && (
      <div ref={avatarOverlayRef} className="avatar-overlay fixed inset-0 z-50 flex bg-black">
        {/* Dark left rail — the live conversation, so the avatar view stays
            in sync with what's actually being said instead of floating
            in an empty panel. Hidden on narrow screens (avatar takes the
            full viewport there instead of getting squeezed). */}
        <div className="hidden md:flex md:w-[30%] md:min-w-[280px] md:max-w-[400px] h-full flex-col overflow-y-auto">
          <div className="px-4 py-4 text-[12.5px] font-medium text-visiyon-text-2 shrink-0 sticky top-0 bg-transparent">
            Conversation
          </div>
          <div className="flex-1 px-4 py-3 space-y-3">
            {messages
              .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
              .map((m) => (
                <div key={m.id} className={`text-[12.5px] leading-snug ${m.role === "USER" ? "text-visiyon-text" : "text-visiyon-text-2"}`}>
                  <span className="block text-[10.5px] uppercase tracking-wide opacity-50 mb-0.5">
                    {m.role === "USER" ? (currentUser?.name || "You") : ((m.model && modelDisplayNames[m.model]) || m.model || "Visiyon")}
                  </span>
                  <span className="whitespace-pre-wrap">{m.content}</span>
                </div>
              ))}
            <div ref={avatarBottomRef} />
          </div>
        </div>

        {/* Fullsize hologram face, centered, translucent over the dark
            backdrop — synced live via the same isSpeaking/isGenerating/
            gaze state driving the small prompt-bar icon. */}
        <div ref={avatarStageRef} className="relative flex-1 flex items-center justify-center min-h-0 overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(80,140,255,0.08),transparent_65%)]" />
          <div className="absolute top-4 right-4 z-10 flex items-center gap-2 max-w-[calc(100%-2rem)]">
            <button
              onClick={() => {
                const el = avatarOverlayRef.current;
                if (!el) return;
                if (document.fullscreenElement) {
                  document.exitFullscreen().catch(() => {});
                } else {
                  el.requestFullscreen?.().catch(() => {});
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] bg-visiyon-text/5 border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/10 transition-colors shrink-0"
            >
              <Maximize2 size={12} /> <span className="hidden sm:inline">Fullscreen</span>
            </button>
            <button
              onClick={() => setShowAvatar(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] bg-visiyon-text/5 border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/10 transition-colors shrink-0"
            >
              <X size={12} /> <span className="hidden sm:inline">Hide avatar</span>
            </button>
          </div>
          <AIFaceAvatar
            audioRef={audioPlayerRef}
            isSpeaking={speakingId !== null}
            isGenerating={isStreaming}
            gazeX={avatarGaze.x}
            gazeY={avatarGaze.y}
            expression={avatarExpression}
            trigger={avatarTrigger}
            size={
              (() => {
                const PHOTO_ASPECT = 1536 / 1024;
                const { width, height } = avatarStageSize;
                if (!width || !height) return 1080;
                // Fit the photo's own aspect ratio fully inside the
                // *actual measured* space (not the whole window, which
                // ignores the conversation rail eating into it) — pick
                // whichever dimension is the binding constraint so
                // nothing gets clipped off an edge.
                return width / height > PHOTO_ASPECT ? height * PHOTO_ASPECT : width;
              })()
            }
            className="max-w-full max-h-full opacity-90"
          />
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-4 pointer-events-none md:px-10">
          <div className="pointer-events-auto max-w-2xl mx-auto">{inputBar}</div>
        </div>
      </div>
    )}
    {isCameraOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-lg rounded-2xl bg-visiyon-panel border border-visiyon-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-visiyon-border">
            <span className="text-[13.5px] font-medium text-visiyon-text flex items-center gap-2">
              <Camera size={15} /> Camera
            </span>
            <button
              onClick={closeCamera}
              className="flex items-center justify-center h-7 w-7 rounded-full text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
          <video ref={cameraVideoRef} className="w-full aspect-video bg-black" playsInline muted />
          <div className="flex items-center justify-center gap-3 px-4 py-3 border-t border-visiyon-border">
            <button
              onClick={closeCamera}
              className="px-4 py-2 rounded-lg text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={capturePhoto}
              className="px-5 py-2 rounded-lg text-[13px] font-medium bg-white text-black hover:bg-visiyon-text/80 transition-colors"
            >
              Capture
            </button>
          </div>
        </div>
      </div>
    )}
    {cameraError && (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/90 text-white text-[13px]">
        <AlertTriangle size={14} />
        {cameraError}
        <button onClick={() => setCameraError(null)} className="ml-1 hover:opacity-70" title="Dismiss">
          <X size={13} />
        </button>
      </div>
    )}
    {micError && (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/90 text-white text-[13px]">
        <AlertTriangle size={14} />
        {micError}
        <button onClick={() => setMicError(null)} className="ml-1 hover:opacity-70" title="Dismiss">
          <X size={13} />
        </button>
      </div>
    )}
    {lightbox && (
      <ImageLightbox
        src={lightbox.src}
        alt={lightbox.alt}
        prompt={lightbox.prompt}
        isRegenerating={lightboxRegenerating}
        onClose={() => setLightbox(null)}
        onRegenerate={lightbox.prompt ? handleRegenerateImage : undefined}
      />
    )}
    </div>
  );
}
