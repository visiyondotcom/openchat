"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomationNow,
  listAutomationRuns,
  listModels,
  type Automation,
  type AutomationRun,
} from "@/lib/api";
import { Plus, Trash2, Play, Pause, ArrowLeft, RotateCw } from "lucide-react";
import Select from "@/components/Select";

const INTERVAL_PRESETS = [
  { label: "Every 15 min", minutes: 15 },
  { label: "Every 30 min", minutes: 30 },
  { label: "Hourly", minutes: 60 },
  { label: "Every 6 hours", minutes: 360 },
  { label: "Daily", minutes: 1440 },
];

export default function AutomationsPage() {
  const { ready } = useRequireAuth();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [models, setModels] = useState<{ name: string; displayName?: string }[]>([]);
  const [active, setActive] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", prompt: "", model: "", intervalMinutes: 60 });
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const list = await listAutomations();
    setAutomations(list);
    if (active) {
      const updated = list.find((a) => a.id === active.id);
      setActive(updated ?? null);
    }
  }

  useEffect(() => {
    refresh();
    listModels()
      .then((m) => {
        setModels(m);
        setForm((f) => ({ ...f, model: f.model || m[0]?.name || "" }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) {
      setRuns([]);
      return;
    }
    listAutomationRuns(active.id).then(setRuns).catch(() => setRuns([]));
  }, [active?.id]);

  async function handleCreate() {
    if (!form.name.trim() || !form.prompt.trim() || !form.model) return;
    setSaving(true);
    try {
      await createAutomation(form);
      setForm({ name: "", prompt: "", model: models[0]?.name || "", intervalMinutes: 60 });
      setShowNew(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(a: Automation) {
    await updateAutomation(a.id, { enabled: !a.enabled });
    await refresh();
  }

  async function handleDelete(id: string) {
    await deleteAutomation(id);
    if (active?.id === id) setActive(null);
    await refresh();
  }

  async function handleRunNow(id: string) {
    await runAutomationNow(id);
    await refresh();
  }

  if (!ready) return null;

  return (
    <div className="flex h-full bg-visiyon-bg text-visiyon-text">
      <div className={`${active ? "hidden md:flex" : "flex"} w-full md:w-80 shrink-0 border-r border-visiyon-border flex-col`}>
        <div className="px-4 pt-4">
          <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
            <ArrowLeft size={14} /> Back to chat
          </Link>
        </div>
        <div className="p-4 flex items-center justify-between">
          <div>
            <h1 className="font-semibold">Automations</h1>
            <p className="text-xs text-visiyon-text-3 mt-0.5">Background agents that run 24/7</p>
          </div>
          <button onClick={() => setShowNew((s) => !s)} className="p-1.5 rounded hover:bg-visiyon-text/10">
            <Plus size={18} />
          </button>
        </div>

        {showNew && (
          <div className="mx-4 mb-3 p-3 rounded-lg border border-visiyon-border space-y-2">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name (e.g. Hourly server report)"
              className="w-full bg-transparent border border-visiyon-border rounded-lg px-3 py-2 text-sm outline-none focus:border-visiyon-text"
            />
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="Prompt to run every time (e.g. 'Check the status of X and summarize any issues')"
              rows={3}
              className="w-full bg-transparent border border-visiyon-border rounded-lg px-3 py-2 text-sm outline-none focus:border-visiyon-text resize-none"
            />
            <Select
              value={form.model}
              onChange={(v) => setForm({ ...form, model: v })}
              options={models.map((m) => ({ value: m.name, label: m.displayName || m.name }))}
              className="w-full"
            />
            <Select
              value={String(form.intervalMinutes)}
              onChange={(v) => setForm({ ...form, intervalMinutes: Number(v) })}
              options={INTERVAL_PRESETS.map((p) => ({ value: String(p.minutes), label: p.label }))}
              className="w-full"
            />
            <button
              onClick={handleCreate}
              disabled={saving}
              className="w-full bg-white text-black rounded-lg py-2 text-sm font-medium hover:bg-visiyon-text/85 disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create automation"}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {automations.map((a) => (
            <button
              key={a.id}
              onClick={() => setActive(a)}
              className={`w-full text-left px-4 py-3 border-b border-white/5 hover:bg-visiyon-text/5 ${active?.id === a.id ? "bg-visiyon-text/10" : ""}`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${a.enabled ? "bg-green-400" : "bg-visiyon-text-3"}`} />
                <span className="truncate font-medium">{a.name}</span>
              </div>
              <p className="text-xs text-visiyon-text-3 truncate mt-1">
                {a.model} · every {a.intervalMinutes < 60 ? `${a.intervalMinutes}m` : `${Math.round(a.intervalMinutes / 60)}h`}
                {a.lastError ? " · last run failed" : ""}
              </p>
            </button>
          ))}
          {automations.length === 0 && !showNew && (
            <p className="p-4 text-sm text-visiyon-text-3">
              No automations yet. Create one to have a model run a prompt on a schedule, 24/7, with no one needing to click send.
            </p>
          )}
        </div>
      </div>

      <div className={`${active ? "flex" : "hidden md:flex"} flex-1 flex-col w-full min-w-0`}>
        {active ? (
          <>
            <div className="flex items-center gap-2 p-4 border-b border-visiyon-border">
              <button
                onClick={() => setActive(null)}
                className="md:hidden p-1 -ml-1 text-visiyon-text-2 hover:text-visiyon-text shrink-0"
                title="Back to automations"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold truncate">{active.name}</h2>
                <p className="text-xs text-visiyon-text-3 mt-0.5">
                  {active.model} · every {active.intervalMinutes < 60 ? `${active.intervalMinutes} min` : `${Math.round(active.intervalMinutes / 60)}h`} ·{" "}
                  {active.lastRunAt ? `last ran ${new Date(active.lastRunAt).toLocaleString()}` : "never run yet"}
                </p>
              </div>
              {active.chatId && (
                <Link href={`/chat/${active.chatId}`} className="text-xs text-visiyon-accent hover:underline">
                  View chat
                </Link>
              )}
              <button onClick={() => handleRunNow(active.id)} className="p-1.5 rounded hover:bg-visiyon-text/10" title="Run now">
                <RotateCw size={16} />
              </button>
              <button
                onClick={() => toggleEnabled(active)}
                className={`p-1.5 rounded hover:bg-visiyon-text/10 ${active.enabled ? "text-green-400" : "text-visiyon-text-3"}`}
                title={active.enabled ? "Pause" : "Resume"}
              >
                {active.enabled ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button onClick={() => handleDelete(active.id)} className="p-1.5 rounded hover:bg-visiyon-text/10 text-red-400">
                <Trash2 size={16} />
              </button>
            </div>

            <div className="p-4 border-b border-visiyon-border">
              <p className="text-xs text-visiyon-text-3 mb-1">Prompt</p>
              <p className="text-sm whitespace-pre-wrap">{active.prompt}</p>
            </div>

            {active.lastError && (
              <div className="p-4 border-b border-visiyon-border text-sm text-red-400">Last error: {active.lastError}</div>
            )}

            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-xs text-visiyon-text-3 mb-2">Run history</p>
              {runs.length === 0 && <p className="text-sm text-visiyon-text-3">No runs yet.</p>}
              <div className="space-y-2">
                {runs.map((r) => (
                  <div key={r.id} className="p-3 rounded-lg border border-visiyon-border">
                    <div className="flex items-center gap-2 text-xs text-visiyon-text-3">
                      <span className={r.status === "SUCCESS" ? "text-green-400" : "text-red-400"}>{r.status}</span>
                      <span>{new Date(r.startedAt).toLocaleString()}</span>
                    </div>
                    {r.output && <p className="text-sm mt-1.5 whitespace-pre-wrap line-clamp-4">{r.output}</p>}
                    {r.error && <p className="text-sm mt-1.5 text-red-400">{r.error}</p>}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-visiyon-text-3">Select or create an automation</div>
        )}
      </div>
    </div>
  );
}
