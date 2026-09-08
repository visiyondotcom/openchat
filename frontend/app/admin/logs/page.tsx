"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import { askConfirm } from "@/components/PromptDialog";
import { listLogs, clearLogs, LogEntry } from "@/lib/api";
import { RefreshCw, Trash2 } from "lucide-react";
import Select from "@/components/Select";

export default function AdminLogsPage() {
  const ready = useRequireAdmin();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logLevelFilter, setLogLevelFilter] = useState<string>("");

  function refreshLogs(level?: string) {
    listLogs({ level: level || undefined, limit: 200 })
      .then(setLogs)
      .catch(() => {});
  }

  useEffect(() => {
    refreshLogs();
  }, []);

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-semibold">Logs</h1>
          <div className="flex items-center gap-2">
            <Select
              value={logLevelFilter}
              onChange={(v) => {
                setLogLevelFilter(v);
                refreshLogs(v);
              }}
              options={[
                { value: "", label: "All levels" },
                { value: "ERROR", label: "Error" },
                { value: "WARN", label: "Warn" },
                { value: "INFO", label: "Info" },
              ]}
              className="w-32"
              buttonClassName="py-1.5 text-[12px]"
            />
            <button
              onClick={() => refreshLogs(logLevelFilter)}
              className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors"
            >
              <RefreshCw size={13} /> Refresh
            </button>
            <button
              onClick={async () => {
                if (await askConfirm({ title: "Clear all logged events? This can't be undone.", confirmLabel: "Clear", danger: true })) {
                  await clearLogs();
                  refreshLogs(logLevelFilter);
                }
              }}
              className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] border border-visiyon-border hover:border-red-400 hover:text-red-400 transition-colors"
            >
              <Trash2 size={13} /> Clear
            </button>
          </div>
        </div>
        <div className="rounded-[6px] overflow-hidden">
          {logs.length === 0 && <p className="text-visiyon-text-3 text-sm px-5 py-4">No events logged yet.</p>}
          {logs.map((l) => (
            <div key={l.id} className="px-5 py-3 border-b border-visiyon-border last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10.5px] font-medium px-2 py-0.5 rounded-full border ${
                    l.level === "ERROR"
                      ? "border-red-400 text-red-400 animate-blink"
                      : l.level === "WARN"
                      ? "border-yellow-500 bg-yellow-500 text-black font-semibold animate-pulse"
                      : "border-visiyon-border text-visiyon-text-3"
                  }`}
                >
                  {l.level}
                </span>
                <span className="text-[11px] text-visiyon-text-3">{l.source}</span>
                <span className="text-[11px] text-visiyon-text-3 ml-auto">
                  {new Date(l.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-[13px] text-visiyon-text-2">{l.message}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
