"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import { askConfirm } from "@/components/PromptDialog";
import Select from "@/components/Select";
import {
  listPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
  listFlaggedMessages,
  Pipeline,
  FlaggedMessage,
  listSecurityAlerts,
  updateSecurityAlert,
  SecurityAlert,
} from "@/lib/api";
import { Plus, Trash2, Ban, Flag, Sparkles } from "lucide-react";

function timeAgoOrDate(iso?: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "a few seconds ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AdminModerationPage() {
  const ready = useRequireAdmin();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [flagged, setFlagged] = useState<FlaggedMessage[]>([]);
  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>([]);
  const [securityFilter, setSecurityFilter] = useState<"" | "OPEN" | "DISMISSED" | "ACTIONED">("OPEN");
  const [newRule, setNewRule] = useState({
    name: "",
    stage: "PRE" as "PRE" | "POST",
    matchType: "KEYWORD" as "KEYWORD" | "REGEX" | "AI",
    pattern: "",
    action: "FLAG" as "BLOCK" | "FLAG",
    message: "This message was blocked by a moderation rule.",
    order: 0,
  });

  function refreshPipelines() {
    listPipelines().then(setPipelines).catch(() => {});
    listFlaggedMessages().then(setFlagged).catch(() => {});
  }

  function refreshSecurityAlerts(status?: "" | "OPEN" | "DISMISSED" | "ACTIONED") {
    listSecurityAlerts((status || securityFilter) || undefined).then(setSecurityAlerts).catch(() => {});
  }

  useEffect(() => {
    refreshPipelines();
    refreshSecurityAlerts("OPEN");
  }, []);

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Moderation</h1>
        </div>

        <div className="mb-10">
          <h2 className="text-lg font-semibold mb-4">Pipelines (moderation/hooks)</h2>
          <p className="text-[12px] text-visiyon-text-3 mb-4">
            PRE rules run on the user&apos;s message before it reaches the model — BLOCK refuses the
            message entirely. POST rules run on the model&apos;s full reply — they can only FLAG it
            (the reply has already streamed), for review below. AI rules run automatically on
            every message, 24/7 — no schedule to configure, they fire the instant a message comes in.
          </p>

          <div className="rounded-[6px] p-5 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newRule.name}
                onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                placeholder="Rule name"
                className="text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />
              <input
                value={newRule.pattern}
                onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
                placeholder={
                  newRule.matchType === "KEYWORD"
                    ? "word1, word2, ..."
                    : newRule.matchType === "REGEX"
                    ? "regex pattern"
                    : "AI instruction, e.g. 'Flag spam, scam links or phishing'"
                }
                className="text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Select
                value={newRule.stage}
                onChange={(v) => setNewRule({ ...newRule, stage: v as "PRE" | "POST" })}
                options={[
                  { value: "PRE", label: "PRE (user message)" },
                  { value: "POST", label: "POST (model reply)" },
                ]}
                buttonClassName="py-2 text-[12px]"
              />
              <Select
                value={newRule.matchType}
                onChange={(v) => setNewRule({ ...newRule, matchType: v as "KEYWORD" | "REGEX" | "AI" })}
                options={[
                  { value: "KEYWORD", label: "Keyword (comma-separated)" },
                  { value: "REGEX", label: "Regex" },
                  { value: "AI", label: "AI (model reviews every message)" },
                ]}
                buttonClassName="py-2 text-[12px]"
              />
              <Select
                value={newRule.action}
                onChange={(v) => setNewRule({ ...newRule, action: v as "BLOCK" | "FLAG" })}
                disabled={newRule.stage === "POST"}
                options={[
                  { value: "FLAG", label: "FLAG" },
                  { value: "BLOCK", label: "BLOCK" },
                ]}
                buttonClassName="py-2 text-[12px]"
              />
            </div>
            {newRule.action === "BLOCK" && newRule.stage === "PRE" && (
              <input
                value={newRule.message}
                onChange={(e) => setNewRule({ ...newRule, message: e.target.value })}
                placeholder="Message shown to the user when blocked"
                className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />
            )}
            <button
              onClick={async () => {
                if (!newRule.name.trim() || !newRule.pattern.trim()) return;
                await createPipeline({
                  ...newRule,
                  action: newRule.stage === "POST" ? "FLAG" : newRule.action,
                });
                setNewRule({ ...newRule, name: "", pattern: "" });
                refreshPipelines();
              }}
              className="flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-[6px] bg-white text-black"
            >
              <Plus size={14} /> Add rule
            </button>
          </div>

          <div className="space-y-2.5 mb-6">
            {pipelines.length === 0 && <p className="text-visiyon-text-3 text-sm">No pipeline rules yet.</p>}
            {pipelines.map((p) => {
              const isBlock = p.action === "BLOCK";
              return (
                <div
                  key={p.id}
                  className={`rounded-[10px] border px-4 py-3.5 transition-colors sm:px-5 ${
                    p.enabled
                      ? isBlock
                        ? "border-red-500/25 bg-red-500/[0.04] hover:border-red-500/40"
                        : "border-amber-500/25 bg-amber-500/[0.04] hover:border-amber-500/40"
                      : "border-visiyon-border bg-visiyon-text/[0.015] opacity-60"
                  }`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold truncate">{p.name}</span>
                        <span className="inline-flex items-center rounded-full border border-visiyon-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-visiyon-text-3">
                          {p.stage}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-visiyon-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-visiyon-text-3">
                          {p.matchType === "AI" && <Sparkles size={10} />}
                          {p.matchType}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            isBlock ? "bg-red-500/15 text-red-400" : "bg-amber-500/15 text-amber-400"
                          }`}
                        >
                          {isBlock ? <Ban size={10} /> : <Flag size={10} />}
                          {p.action}
                        </span>
                      </div>
                      <div className="mt-1.5 truncate rounded-[5px] bg-visiyon-text/[0.05] px-2 py-1 font-mono text-[11.5px] text-visiyon-text-2">
                        {p.pattern}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 self-start sm:self-auto">
                      <button
                        onClick={async () => {
                          await updatePipeline(p.id, { enabled: !p.enabled });
                          refreshPipelines();
                        }}
                        className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                          p.enabled ? "border-emerald-500/40 text-emerald-400" : "border-visiyon-border text-visiyon-text-3"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${p.enabled ? "bg-emerald-400 animate-blink" : "bg-visiyon-text-3"}`} />
                        {p.enabled ? "Active" : "Off"}
                      </button>
                      <button
                        onClick={async () => {
                          if (await askConfirm({ title: `Delete rule "${p.name}"?`, confirmLabel: "Delete", danger: true })) {
                            await deletePipeline(p.id);
                            refreshPipelines();
                          }
                        }}
                        className="text-visiyon-text-3 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <h3 className="text-sm font-semibold mb-3">Flagged messages ({flagged.length})</h3>
          <div className="rounded-[6px] overflow-hidden">
            {flagged.length === 0 && (
              <p className="text-visiyon-text-3 text-sm px-5 py-4">Nothing flagged.</p>
            )}
            {flagged.map((m) => (
              <div key={m.id} className="px-5 py-3.5 border-b border-visiyon-border last:border-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-medium">{m.chat.title}</span>
                  <span className="text-[11px] text-visiyon-text-3">{m.role}</span>
                </div>
                <p className="text-[13px] text-visiyon-text-2 line-clamp-2">{m.content}</p>
                <p className="text-[11px] text-yellow-500 mt-1">{m.flagReason}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Security (24/7 scanner)</h2>
              <p className="text-[12px] text-visiyon-text-3 mt-1">
                A background job scans the whole platform every 2 minutes for spam/abuse patterns
                no single message can show on its own — the same text spammed across many chats,
                a burst of messages far above normal, or a wave of new signups at once.
              </p>
            </div>
            <Select
              value={securityFilter}
              onChange={(v) => {
                const val = v as "" | "OPEN" | "DISMISSED" | "ACTIONED";
                setSecurityFilter(val);
                refreshSecurityAlerts(val);
              }}
              options={[
                { value: "OPEN", label: "Open" },
                { value: "ACTIONED", label: "Actioned" },
                { value: "DISMISSED", label: "Dismissed" },
                { value: "", label: "All" },
              ]}
              className="w-32"
              buttonClassName="py-1.5 text-[12px]"
            />
          </div>

          <div className="rounded-[6px] overflow-hidden">
            {securityAlerts.length === 0 && (
              <p className="text-visiyon-text-3 text-sm px-5 py-4">No alerts in this view.</p>
            )}
            {securityAlerts.map((a) => (
              <div key={a.id} className="px-5 py-3.5 border-b border-visiyon-border last:border-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        a.status === "OPEN"
                          ? "border-yellow-500 bg-yellow-500 text-black font-semibold animate-pulse"
                          : a.status === "ACTIONED"
                          ? "border-red-400 text-red-400"
                          : "border-visiyon-border text-visiyon-text-3"
                      }`}
                    >
                      {a.status}
                    </span>
                    <span className="text-[12px] font-medium">{a.type.replace(/_/g, " ")}</span>
                  </div>
                  <span className="text-[11px] text-visiyon-text-3">{timeAgoOrDate(a.createdAt)}</span>
                </div>
                <p className="text-[13px] text-visiyon-text-2">{a.summary}</p>
                {a.user && (
                  <p className="text-[11px] text-visiyon-text-3 mt-1">{a.user.email}</p>
                )}
                {a.status === "OPEN" && (
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={async () => {
                        await updateSecurityAlert(a.id, "ACTIONED");
                        refreshSecurityAlerts();
                      }}
                      className="text-[11px] px-2.5 py-1 rounded-full border border-red-400 text-red-400 hover:bg-red-400/10"
                    >
                      Mark actioned
                    </button>
                    <button
                      onClick={async () => {
                        await updateSecurityAlert(a.id, "DISMISSED");
                        refreshSecurityAlerts();
                      }}
                      className="text-[11px] px-2.5 py-1 rounded-full border border-visiyon-border text-visiyon-text-3 hover:border-visiyon-text"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
