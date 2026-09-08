"use client";

// Mirrors the embedding-model detection used elsewhere (see
// EMBEDDING_NAME_PATTERN in backend/src/routes/models.ts and
// frontend/app/admin/models/page.tsx) — filters these out of this
// dashboard's "Installed models" badge list specifically, since it's just
// an informational summary and embedding models (nomic-embed-text, etc.)
// aren't chat models a user would pick. The Pull/Delete Models page keeps
// showing every installed model, embeddings included, since managing them
// (deleting, re-pulling) is exactly what that page is for.
const EMBEDDING_NAME_PATTERN = /nomic-embed|embed|bge-|minilm|e5-|gte-/i;

import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import AnalyticsPanel from "@/components/AnalyticsPanel";
import { apiFetch, SystemStats } from "@/lib/api";
import { Cpu, MemoryStick, HardDrive, Gauge } from "lucide-react";

interface Stats {
  userCount: number;
  chatCount: number;
  messageCount: number;
  ollamaUp: boolean;
}
interface User {
  id: string;
  email: string;
  name?: string;
  role: "USER" | "ADMIN";
  groupId?: string | null;
  group?: { id: string; name: string } | null;
  createdAt: string;
  lastActiveAt?: string | null;
}

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

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// Color follows the % used, same green/amber/red thresholds across
// CPU/RAM/disk/GPU so a glance at the dashboard tells you what needs
// attention without reading the numbers. Explicit colors (not the
// monochrome theme accent) so the bar stays visible against both the
// black and white themes instead of disappearing on a white background.
function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 75) return "bg-amber-400";
  return "bg-emerald-500";
}
function sparkColor(pct: number): string {
  if (pct >= 90) return "#ef4444";
  if (pct >= 75) return "#f59e0b";
  return "#10b981";
}

const RESOURCE_ICONS = { cpu: Cpu, ram: MemoryStick, disk: HardDrive, gpu: Gauge } as const;

function UsageBar({
  label,
  pct,
  detail,
  icon,
  history,
}: {
  label: string;
  pct: number;
  detail: string;
  icon?: keyof typeof RESOURCE_ICONS;
  history?: number[];
}) {
  const Icon = icon ? RESOURCE_ICONS[icon] : undefined;
  const sparkData = (history ?? []).map((v, i) => ({ i, v }));
  return (
    <div className="rounded-xl p-4 border border-visiyon-border hover:border-visiyon-text/25 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-[12.5px] text-visiyon-text-3">
          {Icon && <Icon size={13} className="text-visiyon-text-3" />}
          {label}
        </span>
        <span className="text-[12.5px] font-medium tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-visiyon-text/10 overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all ${barColor(pct)}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="text-[11.5px] text-visiyon-text-3 mb-1">{detail}</div>
      {sparkData.length > 1 && (
        <div className="h-8 -mx-1 -mb-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`spark-${label.replace(/\s+/g, "-")}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={sparkColor(pct)} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={sparkColor(pct)} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={sparkColor(pct)}
                strokeWidth={1.5}
                fill={`url(#spark-${label.replace(/\s+/g, "-")})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Small blinking dot to signal "this section is polling live data" —
// a plain animate-ping halo plus a solid core dot, both explicit green
// so it reads the same in both themes.
function LiveDot() {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
    </span>
  );
}

export default function AdminPage() {
  const ready = useRequireAdmin();
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<{
    ollama: { up: boolean; models: string[] };
    searxng?: { up: boolean };
    system?: SystemStats;
  } | null>(null);

  // Rolling client-side history for the system-resource sparklines. The
  // backend only exposes current values (see /admin/health), so "history"
  // here is just the last N points we've polled ourselves — reset on
  // page load, capped so it stays a short "last few minutes" trend.
  const HISTORY_LEN = 30;
  const [resourceHistory, setResourceHistory] = useState<{ cpu: number[]; ram: number[]; disk: number[]; gpus: Record<number, number[]> }>({
    cpu: [],
    ram: [],
    disk: [],
    gpus: {},
  });

  function recordResourceHistory(h: { system?: SystemStats } | null) {
    if (!h?.system) return;
    setResourceHistory((prev) => {
      const push = (arr: number[], v: number) => [...arr, v].slice(-HISTORY_LEN);
      const gpus: Record<number, number[]> = { ...prev.gpus };
      (h.system!.gpus ?? []).forEach((g) => {
        gpus[g.index] = push(prev.gpus[g.index] ?? [], g.utilizationPercent);
      });
      return {
        cpu: push(prev.cpu, h.system!.cpu.usedPercent),
        ram: push(prev.ram, h.system!.memory.usedPercent),
        disk: h.system!.disk ? push(prev.disk, h.system!.disk.usedPercent) : prev.disk,
        gpus,
      };
    });
  }

  useEffect(() => {
    apiFetch("/admin/dashboard").then(setStats).catch(() => {});
    apiFetch("/admin/health").then((h) => {
      setHealth(h);
      recordResourceHistory(h);
    }).catch(() => {});

    // Keep CPU/RAM/disk/GPU numbers live — cheap enough to poll every 5s
    // (see lib/system.ts on the backend), and this is the one section of
    // the dashboard where a stale number is actually misleading.
    const interval = setInterval(() => {
      apiFetch("/admin/health").then((h) => {
        setHealth(h);
        recordResourceHistory(h);
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!ready) return null;

  return (
    <>
    <div className="h-full overflow-y-auto px-6 py-10">
    <div className="max-w-[1600px] mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
      </div>
      <div className="mb-10">
        <div className="flex gap-2 mt-3">
          <a href="/admin/mcp" className="text-sm px-3 py-1.5 rounded-full border border-visiyon-border hover:bg-visiyon-text/[0.06]">
            MCP tool servers
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
        {[
          ["Users", stats?.userCount],
          ["Chats", stats?.chatCount],
          ["Messages", stats?.messageCount],
          ["Ollama", stats?.ollamaUp ? "Online" : "Offline"],
          ["Web search", health?.searxng?.up ? "Online" : "Offline"],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-[6px] p-5">
            <div className="text-[12.5px] text-visiyon-text-3 mb-1">{label}</div>
            <div className="text-2xl font-semibold">{value ?? "—"}</div>
          </div>
        ))}
      </div>

      <AnalyticsPanel variant="overview" />

      <div className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-lg font-semibold">System resources</h2>
          {health?.system && <LiveDot />}
        </div>
        {health?.system ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              <UsageBar
                label="CPU"
                icon="cpu"
                pct={health.system.cpu.usedPercent}
                detail={`Load avg ${health.system.cpu.loadAvg1.toFixed(2)} / ${health.system.cpu.cores} cores`}
                history={resourceHistory.cpu}
              />
              <UsageBar
                label="RAM"
                icon="ram"
                pct={health.system.memory.usedPercent}
                detail={`${formatBytes(health.system.memory.usedBytes)} / ${formatBytes(health.system.memory.totalBytes)}`}
                history={resourceHistory.ram}
              />
              {health.system.disk && (
                <UsageBar
                  label="Disk"
                  icon="disk"
                  pct={health.system.disk.usedPercent}
                  detail={`${formatBytes(health.system.disk.usedBytes)} / ${formatBytes(health.system.disk.totalBytes)}`}
                  history={resourceHistory.disk}
                />
              )}
            </div>

            {health.system.gpus && health.system.gpus.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
                {health.system.gpus.map((gpu) => (
                  <UsageBar
                    key={gpu.index}
                    label={`GPU ${gpu.index} · ${gpu.name}`}
                    icon="gpu"
                    pct={gpu.utilizationPercent}
                    detail={`${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)} VRAM${
                      gpu.temperatureC != null ? ` · ${gpu.temperatureC}°C` : ""
                    }`}
                    history={resourceHistory.gpus[gpu.index]}
                  />
                ))}
              </div>
            )}
            {(!health.system.gpus || health.system.gpus.length === 0) && (
              <p className="text-[11.5px] text-visiyon-text-3 mt-3">
                No GPU stats available — nvidia-smi isn't reachable from this container. See the
                comment in <code>backend/src/lib/system.ts</code> for how to enable GPU passthrough.
              </p>
            )}
          </>
        ) : (
          <p className="text-visiyon-text-3 text-sm">Loading…</p>
        )}
      </div>

      <div className="mb-10">
        <h2 className="text-lg font-semibold mb-4">Installed models</h2>
        <div className="flex flex-wrap gap-2">
          {health?.ollama.models.filter((m) => !EMBEDDING_NAME_PATTERN.test(m)).length ? (
            health.ollama.models
              .filter((m) => !EMBEDDING_NAME_PATTERN.test(m))
              .map((m) => (
                <span key={m} className="text-[13px] border border-visiyon-border rounded-full px-3 py-1.5">
                  {m}
                </span>
              ))
          ) : (
            <p className="text-visiyon-text-3 text-sm">No models detected yet.</p>
          )}
        </div>
      </div>

    </div>
    </div>
    </>
  );
}
