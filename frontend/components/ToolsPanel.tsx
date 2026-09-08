"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";
import Select from "@/components/Select";

import { useEffect, useRef, useState } from "react";
import {
  listTools,
  listAllTools,
  attachTool,
  detachTool,
  createHttpTool,
  updateTool,
  deleteTool,
  apiFetch,
  Tool,
} from "@/lib/api";
import { Wrench, X, Plus, Calculator, Clock, Globe2, Pencil, Trash2, Search } from "lucide-react";

interface HeaderRow {
  key: string;
  value: string;
}

function toolIcon(tool: Tool) {
  if (tool.type === "HTTP") return <Globe2 size={14} className="text-visiyon-text-3 shrink-0" />;
  if (tool.name === "calculator") return <Calculator size={14} className="text-visiyon-text-3 shrink-0" />;
  if (tool.name === "search_chats") return <Search size={14} className="text-visiyon-text-3 shrink-0" />;
  return <Clock size={14} className="text-visiyon-text-3 shrink-0" />;
}

function emptyHeaderRows(headers?: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
  return rows.length ? rows : [{ key: "", value: "" }];
}

export default function ToolsPanel({
  chatId,
  ensureChatId,
  attachedIds,
  onAttachedChange,
  asMenuItem,
  onOpened,
  onClosed,
}: {
  chatId?: string;
  // Creates the chat on first use and returns its id — lets a tool be
  // attached even before any message has been sent.
  ensureChatId: () => Promise<string>;
  attachedIds: string[];
  onAttachedChange: (ids: string[]) => void;
  asMenuItem?: boolean;
  onOpened?: () => void;
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<Tool[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // "new" for create form
  const [saving, setSaving] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // The panel opens *upward* from this trigger, so its natural height
  // (up to 70vh) can exceed the space actually available above it —
  // pushing the header and top tools off the top of the screen with no
  // way to scroll back up to them. Clamp it to what's really there.
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);

  // Form state (shared by create + edit)
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">("GET");
  const [url, setUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(emptyHeaderRows());
  const [bodyTemplate, setBodyTemplate] = useState("");

  async function refresh() {
    try {
      const me = await apiFetch("/auth/me");
      const admin = me.user?.role === "ADMIN";
      setIsAdmin(admin);
      setTools(admin ? await listAllTools() : await listTools());
    } catch {
      /* not logged in yet */
    }
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // The panel's bottom edge sits at roughly rect.top (or rect.bottom,
      // for the asMenuItem flyout) and it grows upward from there — so
      // cap its height to the distance from that point to the top of the
      // viewport, minus a little breathing room. Using rect.top is the
      // more conservative of the two anchors, which keeps this safe for
      // both.
      const available = rect.top - 8;
      setMaxPanelHeight(Math.max(160, Math.min(available, window.innerHeight * 0.7)));
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [open, editingId, tools.length]);

  async function toggleAttach(tool: Tool) {
    const isAttached = attachedIds.includes(tool.id);
    if (isAttached) {
      const id = chatId ?? (await ensureChatId());
      await detachTool(id, tool.id);
      onAttachedChange(attachedIds.filter((id) => id !== tool.id));
    } else {
      const id = await ensureChatId();
      await attachTool(id, tool.id);
      onAttachedChange([...attachedIds, tool.id]);
    }
  }

  function startCreate() {
    setName("");
    setDescription("");
    setMethod("GET");
    setUrl("");
    setHeaderRows(emptyHeaderRows());
    setBodyTemplate("");
    setEditingId("new");
  }

  function startEdit(tool: Tool) {
    setName(tool.name);
    setDescription(tool.description);
    setMethod((tool.config.method as typeof method) ?? "GET");
    setUrl(tool.config.url ?? "");
    setHeaderRows(emptyHeaderRows(tool.config.headers));
    setBodyTemplate(tool.config.bodyTemplate ?? "");
    setEditingId(tool.id);
  }

  function headersFromRows(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of headerRows) {
      if (row.key.trim()) out[row.key.trim()] = row.value;
    }
    return out;
  }

  async function handleSave() {
    if (!description.trim() || !url.trim()) return;
    setSaving(true);
    try {
      const config = {
        method,
        url: url.trim(),
        headers: headersFromRows(),
        bodyTemplate: bodyTemplate.trim() || undefined,
        parameters: [] as never[],
      };
      if (editingId === "new") {
        if (!name.trim()) return;
        const tool = await createHttpTool({ name: name.trim(), description: description.trim(), config });
        setTools((prev) => [...prev, tool]);
      } else if (editingId) {
        const tool = await updateTool(editingId, { description: description.trim(), config });
        setTools((prev) => prev.map((t) => (t.id === tool.id ? tool : t)));
      }
      setEditingId(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save tool");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(tool: Tool) {
    if (!(await askConfirm({ title: `Delete tool "${tool.name}"?`, confirmLabel: "Delete", danger: true }))) return;
    await deleteTool(tool.id);
    setTools((prev) => prev.filter((t) => t.id !== tool.id));
    onAttachedChange(attachedIds.filter((id) => id !== tool.id));
  }

  async function handleToggleEnabled(tool: Tool) {
    const updated = await updateTool(tool.id, { enabled: !tool.enabled });
    setTools((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  const editing = editingId !== null;

  return (
    <div className="relative" ref={wrapperRef}>
      {asMenuItem ? (
        <button
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) onOpened?.();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
        >
          <Wrench size={15} /> Tools{attachedIds.length > 0 ? ` (${attachedIds.length})` : ""}
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 p-2.5 rounded-xl border transition-colors ${
            attachedIds.length > 0 ? "border-visiyon-text text-visiyon-text" : "border-visiyon-border text-visiyon-text-2"
          }`}
          title="Tools"
        >
          <Wrench size={16} />
          {attachedIds.length > 0 && <span className="text-[11px] font-medium">{attachedIds.length}</span>}
        </button>
      )}

      {open && (
        <div
          className={`menu-popup absolute w-[min(24rem,92vw)] max-h-[70vh] overflow-y-auto z-30 bg-visiyon-bg rounded-2xl shadow-2xl ${
            asMenuItem ? "bottom-0 left-0" : "bottom-full left-0 mb-2"
          }`}
          style={maxPanelHeight != null ? { maxHeight: maxPanelHeight } : undefined}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13.5px] font-medium">Tools</span>
            <button
              onClick={() => {
                setOpen(false);
                onClosed?.();
              }}
              className="text-visiyon-text-3 hover:text-visiyon-text"
            >
              <X size={14} />
            </button>
          </div>

          {!editing && (
            <div className="max-h-72 overflow-y-auto">
              {tools.length === 0 && (
                <p className="text-[12.5px] text-visiyon-text-3 px-4 py-4">No tools available yet.</p>
              )}
              {tools.map((t) => {
                const attached = attachedIds.includes(t.id);
                return (
                  <div key={t.id} className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-visiyon-text/[0.04] group">
                    {toolIcon(t)}
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate flex items-center gap-1.5">
                        {t.name}
                        {isAdmin && !t.enabled && (
                          <span className="text-[10px] text-visiyon-text-3 border border-visiyon-border rounded-full px-1.5">
                            disabled
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-visiyon-text-3 truncate">{t.description}</div>
                    </div>
                    {isAdmin && t.type === "HTTP" && (
                      <div className="hidden group-hover:flex items-center gap-1.5 text-visiyon-text-3 shrink-0">
                        <button onClick={() => startEdit(t)} title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => handleDelete(t)} title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                    {isAdmin ? (
                      <button
                        onClick={() => handleToggleEnabled(t)}
                        className={`text-[11px] px-2 py-1 rounded-full border shrink-0 transition-colors ${
                          t.enabled
                            ? "bg-white text-black border-visiyon-text"
                            : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                        }`}
                      >
                        {t.enabled ? "Enabled" : "Disabled"}
                      </button>
                    ) : (
                      <button
                        onClick={() => toggleAttach(t)}
                        className={`text-[11px] px-2 py-1 rounded-full border shrink-0 transition-colors ${
                          attached
                            ? "bg-white text-black border-visiyon-text"
                            : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                        }`}
                      >
                        {attached ? "On" : "Off"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {isAdmin && !editing && (
            <div className="border-t border-visiyon-border p-3">
              <button
                onClick={startCreate}
                className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium py-2 rounded-xl border border-dashed border-visiyon-border hover:border-visiyon-text transition-colors"
              >
                <Plus size={13} /> Add HTTP tool
              </button>
            </div>
          )}

          {editing && (
            <div className="p-3 space-y-2 max-h-96 overflow-y-auto">
              {editingId === "new" && (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Tool name (e.g. weather_lookup)"
                  className="w-full bg-transparent border border-visiyon-border rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-visiyon-text"
                />
              )}
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this tool does (shown to the model)"
                rows={2}
                className="w-full bg-transparent border border-visiyon-border rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-visiyon-text resize-none"
              />
              <div className="flex gap-2">
                <Select
                  value={method}
                  onChange={(v) => setMethod(v as typeof method)}
                  options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
                  className="w-28 shrink-0"
                  buttonClassName="py-1.5 text-[12.5px]"
                />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.example.com/{{param}}"
                  className="flex-1 min-w-0 bg-transparent border border-visiyon-border rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-visiyon-text"
                />
              </div>

              {method !== "GET" && method !== "DELETE" && (
                <textarea
                  value={bodyTemplate}
                  onChange={(e) => setBodyTemplate(e.target.value)}
                  placeholder='JSON body template, e.g. {"query": "{{query}}"}'
                  rows={2}
                  className="w-full bg-transparent border border-visiyon-border rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-visiyon-text resize-none font-mono"
                />
              )}

              <div>
                <div className="text-[11px] text-visiyon-text-3 mb-1">
                  Headers (e.g. Authorization: Bearer sk-...)
                </div>
                <div className="space-y-1.5">
                  {headerRows.map((row, i) => (
                    <div key={i} className="flex gap-1.5">
                      <input
                        value={row.key}
                        onChange={(e) =>
                          setHeaderRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))
                        }
                        placeholder="Header name"
                        className="w-2/5 bg-transparent border border-visiyon-border rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-visiyon-text"
                      />
                      <input
                        value={row.value}
                        onChange={(e) =>
                          setHeaderRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))
                        }
                        placeholder="Value"
                        type="password"
                        className="flex-1 min-w-0 bg-transparent border border-visiyon-border rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-visiyon-text"
                      />
                      <button
                        onClick={() => setHeaderRows((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-visiyon-text-3 hover:text-red-400 shrink-0"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setHeaderRows((prev) => [...prev, { key: "", value: "" }])}
                    className="text-[11.5px] text-visiyon-text-3 hover:text-visiyon-text"
                  >
                    + Add header
                  </button>
                </div>
              </div>

              <p className="text-[11px] text-visiyon-text-3">
                Use <code>{"{{paramName}}"}</code> in the URL or body — the model fills these in when it calls the tool.
              </p>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setEditingId(null)}
                  className="flex-1 text-[12.5px] py-1.5 rounded-lg border border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 text-[12.5px] py-1.5 rounded-lg bg-white text-black disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
