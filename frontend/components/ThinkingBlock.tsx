"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Search,
  Globe,
  Terminal,
  FileCode,
  FilePen,
  StickyNote,
  Brain,
  AlertTriangle,
} from "lucide-react";
import type { ThinkingStep } from "@/lib/store";

// Best-effort classification of a step into one of the trace "kinds" shown
// in the reference UI (Ran N commands, edited N files, viewed a file, N
// notes). `type` is the coarse category the backend sends (rag, websearch,
// tool, reasoning, ...); within "tool" we further guess at command vs.
// file-read vs. file-edit vs. note from the label text, since the backend
// doesn't (yet) send a finer-grained kind.
type StepKind = "command" | "edit" | "view" | "note" | "rag" | "websearch" | "reasoning" | "other";

function classify(step: ThinkingStep): StepKind {
  if (step.type === "rag") return "rag";
  if (step.type === "websearch") return "websearch";
  if (step.type === "reasoning") return "reasoning";
  const label = step.label.toLowerCase();
  if (/^(ran|run|check|checking|search(ing)?|grep|verify|test)/.test(label)) return "command";
  if (/^(edit|edited|writ|updat|creat|delet)/.test(label)) return "edit";
  if (/^(read|view|viewed|open|inspect)/.test(label)) return "view";
  if (step.type === "tool") return "command";
  return "note";
}

const KIND_ICON: Record<StepKind, typeof Brain> = {
  command: Terminal,
  edit: FilePen,
  view: FileCode,
  note: StickyNote,
  rag: Search,
  websearch: Globe,
  reasoning: Brain,
  other: Brain,
};

function StepIcon({ kind, status }: { kind: StepKind; status: ThinkingStep["status"] }) {
  const Icon = status === "error" ? AlertTriangle : KIND_ICON[kind];
  return (
    <Icon
      size={13}
      className={status === "error" ? "text-red-400 shrink-0" : status === "start" ? "text-visiyon-text-3 animate-pulse shrink-0" : "text-visiyon-text-3 shrink-0"}
    />
  );
}

// A single step. Steps whose detail reads like a command/output (has
// newlines, or the step itself is a "command" kind) get a proper
// monospace, dark, scrollable block — same idea as a terminal/code panel —
// instead of being squeezed into an italic one-liner.
function StepRow({ step }: { step: ThinkingStep }) {
  const kind = classify(step);
  const [open, setOpen] = useState(false);
  const hasBlock = !!step.detail && (kind === "command" || step.detail.includes("\n"));
  const detail = step.detail ?? "";
  const preview = detail.length > 300 ? detail.slice(0, 300) + "…" : detail;

  if (hasBlock) {
    return (
      <li>
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-start gap-1.5 text-left not-italic hover:text-visiyon-text transition-colors"
        >
          <span className="mt-0.5">
            <StepIcon kind={kind} status={step.status} />
          </span>
          <span className="flex-1 min-w-0">{step.label}</span>
          <ChevronDown size={12} className={`mt-0.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <pre className="mt-1.5 ml-[19px] not-italic text-[11.5px] leading-relaxed text-visiyon-text-2 bg-black/30 border border-visiyon-border rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono">
            {preview}
          </pre>
        )}
      </li>
    );
  }

  return (
    <li className="flex items-start gap-1.5">
      <span className="mt-0.5">
        <StepIcon kind={kind} status={step.status} />
      </span>
      <span>
        {step.label}
        {step.detail && (
          <span className="block text-[11.5px] text-visiyon-text-3 mt-0.5 break-words not-italic">
            {preview}
          </span>
        )}
      </span>
    </li>
  );
}

function summarize(steps: ThinkingStep[]): string | null {
  let commands = 0;
  let filesEdited = 0;
  let filesViewed = 0;
  let notes = 0;
  for (const s of steps) {
    switch (classify(s)) {
      case "command":
        commands++;
        break;
      case "edit":
        filesEdited++;
        break;
      case "view":
        filesViewed++;
        break;
      case "note":
        notes++;
        break;
      default:
        break;
    }
  }
  const parts: string[] = [];
  if (commands > 0) parts.push(`Ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (filesEdited > 0) parts.push(`edited ${filesEdited} file${filesEdited === 1 ? "" : "s"}`);
  if (filesViewed > 0) parts.push(filesViewed === 1 ? "viewed a file" : `viewed ${filesViewed} files`);
  if (parts.length === 0) return null;
  let summary = parts.join(", ");
  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (notes > 0) summary += ` · ${notes} note${notes === 1 ? "" : "s"}`;
  return summary;
}

// Shows what the assistant did (RAG lookups, web search, tool/command
// calls, file reads/edits) and thought (the model's own chain-of-thought,
// for reasoning-capable models) while producing THIS reply — this
// component is rendered once per assistant message (see ChatWindow.tsx),
// so every message gets and keeps its own independent trace; nothing here
// is shared/global state. Collapsed by default, like Claude/ChatGPT's
// "Thought for Xs" block. Live during streaming (ticking timer, steps
// appearing one by one as they happen), then frozen once the reply is
// done and persisted with the message.
export default function ThinkingBlock({
  steps,
  reasoning,
  isLive,
}: {
  steps?: ThinkingStep[] | null;
  reasoning?: string | null;
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const hasContent = (steps && steps.length > 0) || !!reasoning;
  const summary = useMemo(() => (steps && steps.length > 0 ? summarize(steps) : null), [steps]);

  const startedAt = useMemo(() => {
    const first = steps && steps[0];
    return first ? new Date(first.at).getTime() : Date.now();
  }, [steps && steps[0]?.at]);

  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000))), 500);
    return () => clearInterval(t);
  }, [isLive, startedAt]);

  // Once streaming stops, freeze the timer at whatever it last read instead
  // of continuing to tick — that's the final "thought for Xs" figure.
  useEffect(() => {
    if (!isLive && steps && steps.length > 0) {
      const last = steps[steps.length - 1];
      setElapsed(Math.max(1, Math.round((new Date(last.at).getTime() - startedAt) / 1000)));
    }
  }, [isLive, steps, startedAt]);

  return (
    <div className="pb-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-0 py-1 text-[12.5px] text-visiyon-text-2 hover:text-visiyon-text transition-colors"
      >
        <span className={isLive ? "visiyon-shimmer-text" : ""}>
          {isLive ? "Thinking" : "Thought"}
          {elapsed > 0 ? ` (${elapsed}s)` : ""}
        </span>
        {!expanded && summary && (
          <span className="text-visiyon-text-3 truncate font-normal">— {summary}</span>
        )}
      </button>
      {expanded && (
        <div className="ml-1 pl-3 pb-3 space-y-2 text-[12.5px] text-visiyon-text-2 italic border-l-2 border-visiyon-border">
          {hasContent ? (
            <>
              {summary && <div className="not-italic text-visiyon-text-3">{summary}</div>}
              {steps && steps.length > 0 && (
                <ul className="space-y-1.5 not-italic">
                  {steps.map((s, i) => (
                    <StepRow key={i} step={s} />
                  ))}
                </ul>
              )}
              {reasoning && (
                <div className="whitespace-pre-wrap border-t border-visiyon-border/60 pt-2">
                  {reasoning}
                </div>
              )}
            </>
          ) : (
            <div>
              {isLive
                ? "Working on a reply — no searches, tools, or reasoning needed."
                : "Answered directly — no searches, tools, or reasoning used."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
