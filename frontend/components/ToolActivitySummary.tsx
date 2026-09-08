"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal, FilePenLine, FileText, Globe, ImageIcon, Search } from "lucide-react";
import type { ThinkingStep } from "@/lib/store";

// Buckets each built-in tool name (see backend/src/lib/tools.ts) into the
// category shown in the one-line summary — mirrors how Claude groups its
// own tool calls into "Ran N commands", "Edited N files", etc.
const CATEGORY_BY_TOOL: Record<string, "command" | "edited" | "read" | "web" | "image" | "chats"> = {
  run_python: "command",
  calculator: "command",
  create_file: "edited",
  server_write_file: "edited",
  server_read_file: "read",
  server_list_files: "read",
  browse_web: "web",
  search_chats: "chats",
  generate_image: "image",
};

const ICON_BY_CATEGORY: Record<string, typeof Terminal> = {
  command: Terminal,
  edited: FilePenLine,
  read: FileText,
  web: Globe,
  image: ImageIcon,
  chats: Search,
};

function extractToolName(label: string): string | null {
  const m = /Calling tool "([^"]+)"/.exec(label);
  return m ? m[1] : null;
}

// Reads the same per-message `steps` log the "Thought for Xs" block reads
// (see ThinkingBlock.tsx) and turns the "tool" entries into a single
// collapsed summary line under the reply — e.g. "Ran 2 commands, edited a
// file, read a file". Persisted, not just live: since it's derived from
// stored steps, it shows the same way for old messages as for one that
// just finished streaming.
export default function ToolActivitySummary({ steps }: { steps?: ThinkingStep[] | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!steps || steps.length === 0) return null;

  const calls: { name: string; category: keyof typeof ICON_BY_CATEGORY; detail?: string; failed?: boolean }[] = [];
  for (const s of steps) {
    if (s.type !== "tool" || s.status !== "start") continue;
    const name = extractToolName(s.label);
    if (!name) continue;
    calls.push({ name, category: CATEGORY_BY_TOOL[name] ?? "command", detail: s.detail });
  }
  if (calls.length === 0) return null;

  const counts: Partial<Record<keyof typeof ICON_BY_CATEGORY, number>> = {};
  for (const c of calls) counts[c.category] = (counts[c.category] ?? 0) + 1;

  const parts: string[] = [];
  if (counts.command) parts.push(`Ran ${counts.command} ${counts.command === 1 ? "command" : "commands"}`);
  if (counts.edited) parts.push(counts.edited === 1 ? "edited a file" : `edited ${counts.edited} files`);
  if (counts.read) parts.push(counts.read === 1 ? "read a file" : `read ${counts.read} files`);
  if (counts.web) parts.push(counts.web === 1 ? "searched the web" : `searched the web ${counts.web} times`);
  if (counts.image) parts.push(counts.image === 1 ? "generated an image" : `generated ${counts.image} images`);
  if (counts.chats) parts.push("searched your chats");

  // Capitalize only the first fragment, comma-join the rest — matches
  // "Ran 2 commands, edited a file, read a file" casing.
  const summary = parts.length > 0 ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + (parts.length > 1 ? ", " + parts.slice(1).join(", ") : "") : "";
  if (!summary) return null;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 text-[12.5px] text-visiyon-text-2 hover:text-visiyon-text transition-colors"
      >
        <span className="truncate">{summary}</span>
        {expanded ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
      </button>
      {expanded && (
        <ul className="ml-1 pl-3 mt-1.5 space-y-1.5 text-[12.5px] text-visiyon-text-2 border-l-2 border-visiyon-border">
          {calls.map((c, i) => {
            const Icon = ICON_BY_CATEGORY[c.category];
            return (
              <li key={i} className="flex items-start gap-1.5">
                <span className="mt-0.5">
                  <Icon size={13} className="text-visiyon-text-3" />
                </span>
                <span className="break-words">
                  {c.name}
                  {c.detail && (
                    <span className="block text-[11.5px] text-visiyon-text-3 mt-0.5">
                      {c.detail.length > 200 ? c.detail.slice(0, 200) + "…" : c.detail}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
