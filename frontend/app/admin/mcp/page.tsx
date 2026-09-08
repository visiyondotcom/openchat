"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";
import Select from "@/components/Select";

import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import Link from "next/link";
import { listMcpServers, createMcpServer, deleteMcpServer, syncMcpServer } from "@/lib/api";
import { Plus, Trash2, RefreshCw, ArrowLeft, AlertCircle } from "lucide-react";

interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
}

export default function McpAdminPage() {
  const ready = useRequireAdmin();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState("http");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  async function refresh() {
    const { servers } = await listMcpServers();
    setServers(servers);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function handleAdd() {
    if (!name.trim() || !url.trim()) return;
    await createMcpServer({ name, url, transport });
    setName("");
    setUrl("");
    await refresh();
  }

  async function handleSync(id: string) {
    setSyncing(id);
    setSyncMsg(null);
    try {
      const result = await syncMcpServer(id);
      setSyncMsg(result.ok ? `Synced ${result.toolCount ?? 0} tool(s) — check the Tools admin to attach them to chats.` : result.error || "Sync failed");
      await refresh();
    } finally {
      setSyncing(null);
    }
  }

  async function handleDelete(id: string) {
    if (!(await askConfirm({ title: "Remove this MCP server? Tools it backs will stop working.", confirmLabel: "Remove", danger: true }))) return;
    await deleteMcpServer(id);
    await refresh();
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto bg-visiyon-bg text-visiyon-text">
    <div className="p-6 max-w-3xl mx-auto">
      <Link href="/admin" className="text-sm text-visiyon-text-3 flex items-center gap-1 mb-4 hover:text-visiyon-text">
        <ArrowLeft size={14} /> Back to admin
      </Link>
      <h1 className="text-xl font-semibold mb-1">MCP Tool Servers</h1>
      <p className="text-xs text-visiyon-text-3 mb-4">
        Synced tools are added to the normal Tools catalog automatically — attach them to a chat the same way as any other tool.
      </p>
      {syncMsg && <div className="text-xs bg-visiyon-text/5 rounded px-3 py-2 mb-4">{syncMsg}</div>}

      <div className="bg-visiyon-text/5 rounded-[6px] p-4 mb-6 space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="w-full bg-visiyon-text/5 rounded-[6px] px-3 py-2 text-sm outline-none focus:bg-visiyon-text/10 transition-colors placeholder:text-visiyon-text-3"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Server URL"
          className="w-full bg-visiyon-text/5 rounded-[6px] px-3 py-2 text-sm outline-none focus:bg-visiyon-text/10 transition-colors placeholder:text-visiyon-text-3"
        />
        <Select
          value={transport}
          onChange={setTransport}
          options={[
            { value: "http", label: "HTTP" },
            { value: "sse", label: "SSE" },
          ]}
          className="w-full"
          buttonClassName="border-transparent bg-visiyon-text/5 hover:border-transparent focus:bg-visiyon-text/10"
        />
        <button
          onClick={handleAdd}
          disabled={!name.trim() || !url.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-[6px] bg-visiyon-accent text-visiyon-bg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          <Plus size={14} /> Add server
        </button>
      </div>

      <div className="space-y-2">
        {servers.map((s) => (
          <div key={s.id} className="bg-visiyon-text/5 rounded-[6px] p-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-sm flex items-center gap-2">
                {s.name}
                <span className="text-xs text-visiyon-text-3">({s.transport})</span>
                {s.lastSyncError && <AlertCircle size={13} className="text-red-400" />}
              </div>
              <div className="text-xs text-visiyon-text-3">{s.url}</div>
              {s.lastSyncError && <div className="text-xs text-red-400 mt-1">{s.lastSyncError}</div>}
              {s.lastSyncAt && !s.lastSyncError && (
                <div className="text-xs text-visiyon-text-3 mt-1">Synced {new Date(s.lastSyncAt).toLocaleString()}</div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => handleSync(s.id)} className="p-2 rounded hover:bg-visiyon-text/10" title="Discover tools">
                <RefreshCw size={15} className={syncing === s.id ? "animate-spin" : ""} />
              </button>
              <button onClick={() => handleDelete(s.id)} className="p-2 rounded hover:bg-visiyon-text/10 text-red-400">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
        {servers.length === 0 && <p className="text-sm text-visiyon-text-3">No MCP servers connected yet.</p>}
      </div>
    </div>
    </div>
  );
}
