"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";

import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  listFilters, createFilter, updateFilter, deleteFilter,
  listPipes, createPipe, updatePipe, deletePipe,
  listActions, createAction, updateAction, deleteAction,
} from "@/lib/api";
import { Plus, Trash2, ArrowLeft, AlertCircle } from "lucide-react";

type Tab = "filters" | "pipes" | "actions";

const DEFAULT_CODE: Record<Tab, string> = {
  filters: `class Filter:
    def inlet(self, body, user):
        # Runs before the message is sent to the model.
        # Return the (optionally modified) body dict, or raise to block it.
        return body

    def outlet(self, body, user):
        # Runs after the model's reply, before it's persisted.
        return body
`,
  pipes: `class Pipe:
    def pipe(self, body, user):
        # Return the full response as a string. You can call out to an
        # external API or chain multiple model calls here.
        return "Hello from a custom pipe!"
`,
  actions: `class Action:
    def action(self, body, user):
        # Runs when the toolbar button is clicked. Return a dict — the
        # frontend shows it as a toast/side panel.
        return {"message": "Action ran!"}
`,
};

export default function FunctionsAdminPage() {
  const ready = useRequireAdmin();
  const [tab, setTab] = useState<Tab>("filters");
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);

  const api = {
    filters: { list: listFilters, create: createFilter, update: updateFilter, del: deleteFilter },
    pipes: { list: listPipes, create: createPipe, update: updatePipe, del: deletePipe },
    actions: { list: listActions, create: createAction, update: updateAction, del: deleteAction },
  }[tab];

  async function refresh() {
    const key = tab; // filters/pipes/actions
    const res = await api.list();
    setItems(res[key] ?? res.items ?? []);
  }
  useEffect(() => {
    setEditing(null);
    refresh();
  }, [tab]);

  async function handleNew() {
    const name = await askPrompt({ title: `New ${tab.slice(0, -1)}`, label: "Name" });
    if (!name) return;
    const payload: any = { name, code: DEFAULT_CODE[tab] };
    if (tab !== "filters") payload.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await api.create(payload);
    await refresh();
  }

  async function handleSave() {
    if (!editing) return;
    await api.update(editing.id, { name: editing.name, code: editing.code, enabled: editing.enabled });
    await refresh();
  }

  async function handleDelete(id: string) {
    if (!(await askConfirm({ title: "Delete this?", confirmLabel: "Delete", danger: true }))) return;
    await api.del(id);
    if (editing?.id === id) setEditing(null);
    await refresh();
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto bg-visiyon-bg text-visiyon-text">
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Functions</h1>

      <div className="flex gap-2 mb-6 border-b border-visiyon-border">
        {(["filters", "pipes", "actions"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 ${tab === t ? "border-visiyon-accent text-visiyon-text" : "border-transparent text-visiyon-text-3"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-1">
          <button onClick={handleNew} className="w-full flex items-center justify-center gap-1.5 py-2 rounded bg-visiyon-text/10 hover:bg-visiyon-text/20 text-sm mb-3">
            <Plus size={14} /> New {tab.slice(0, -1)}
          </button>
          <div className="space-y-1">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => setEditing(item)}
                className={`w-full text-left px-3 py-2 rounded text-sm flex items-center justify-between ${editing?.id === item.id ? "bg-visiyon-text/10" : "hover:bg-visiyon-text/5"}`}
              >
                <span className="flex items-center gap-2 truncate">
                  <span className={`w-1.5 h-1.5 rounded-full ${item.enabled ? "bg-green-400" : "bg-visiyon-text/20"}`} />
                  {item.name}
                  {item.lastError && <AlertCircle size={12} className="text-red-400" />}
                </span>
              </button>
            ))}
            {items.length === 0 && <p className="text-xs text-visiyon-text-3 px-1">None yet.</p>}
          </div>
        </div>

        <div className="col-span-2">
          {editing ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="flex-1 bg-visiyon-text/5 rounded px-3 py-2 text-sm"
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                  Enabled
                </label>
                <button onClick={() => handleDelete(editing.id)} className="p-2 rounded hover:bg-visiyon-text/10 text-red-400">
                  <Trash2 size={16} />
                </button>
              </div>
              {editing.lastError && (
                <div className="text-xs text-red-400 bg-red-500/10 rounded p-2 flex gap-1.5 items-start">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" /> {editing.lastError}
                </div>
              )}
              <textarea
                value={editing.code}
                onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                rows={20}
                spellCheck={false}
                className="w-full bg-black/40 rounded px-3 py-2 text-sm font-mono outline-none"
              />
              <button onClick={handleSave} className="px-4 py-2 rounded-[6px] bg-visiyon-accent text-visiyon-bg text-sm font-medium hover:opacity-90 transition-opacity">
                Save
              </button>
            </div>
          ) : (
            <p className="text-visiyon-text-3 text-sm">Select a {tab.slice(0, -1)} to edit, or create a new one. Code runs in an isolated, network-less sandbox container.</p>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
