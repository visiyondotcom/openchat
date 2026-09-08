"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { adminGetVersion, adminCheckForUpdate } from "@/lib/api";
import {
  LayoutDashboard,
  Cpu,
  Plug,
  BarChart3,
  ClipboardCheck,
  FunctionSquare,
  Server,
  Settings as SettingsIcon,
  Users as UsersIcon,
  DownloadCloud,
  GraduationCap,
  KeyRound,
  UsersRound,
  ShieldAlert,
  Webhook as WebhookIcon,
  ScrollText,
  Blend,
} from "lucide-react";

const ITEMS = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: UsersIcon },
  { href: "/admin/models", label: "Models", icon: Cpu },
  { href: "/admin/training", label: "Training", icon: GraduationCap },
  { href: "/admin/providers", label: "AI Providers", icon: Plug },
  { href: "/admin/meta-models", label: "Meta-Models (Jean)", icon: Blend },
  { href: "/admin/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/admin/authentication", label: "Authentication", icon: KeyRound },
  { href: "/admin/groups", label: "Groups & Access", icon: UsersRound },
  { href: "/admin/moderation", label: "Moderation", icon: ShieldAlert },
  { href: "/admin/evaluations", label: "Evaluations", icon: ClipboardCheck },
  { href: "/admin/webhooks", label: "Webhooks", icon: WebhookIcon },
  { href: "/admin/functions", label: "Functions", icon: FunctionSquare },
  { href: "/admin/mcp", label: "MCP Servers", icon: Server },
  { href: "/admin/logs", label: "Logs", icon: ScrollText },
  { href: "/admin/updates", label: "Updates", icon: DownloadCloud },
  { href: "/admin/settings", label: "Settings", icon: SettingsIcon },
];

// Flat, black, vertical admin nav — replaces the old horizontal AdminNav
// tab strip. Full height, shared by every /admin/* page via
// app/admin/layout.tsx. Fixed-width column on desktop (lg+); below that it
// becomes an off-canvas drawer (same slide-in pattern as the main chat
// sidebar) so it doesn't permanently eat 220px on a phone screen.
export default function AdminSidebar({
  mobileOpen,
  onClose,
}: {
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const [version, setVersion] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    adminGetVersion()
      .then((d) => setVersion(d.version))
      .catch(() => setVersion(null));

    // Cheap: the backend caches the actual GitHub check for an hour, so
    // polling every 10 minutes here just re-reads that cache, it doesn't
    // trigger a fresh check each time.
    const check = () =>
      adminCheckForUpdate()
        .then((d) => setUpdateAvailable(d.enabled && d.updateAvailable))
        .catch(() => {});
    check();
    const interval = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      {/* Backdrop — mobile only, closes the drawer on tap */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={onClose} />
      )}
      <aside
        className={`w-[220px] shrink-0 h-full flex flex-col bg-visiyon-bg
          fixed inset-y-0 left-0 z-50 transition-transform duration-200
          lg:static lg:translate-x-0
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="px-5 py-4">
          <div className="text-[11px] uppercase tracking-wide text-visiyon-text-3">Admin Center</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {ITEMS.map(({ href, label, icon: Icon }) => {
            // "/admin" itself must be an exact match so it doesn't stay
            // highlighted on every other /admin/* route; every other item
            // matches its whole subtree (e.g. /admin/functions/123).
            const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`flex items-center gap-2.5 px-3 py-2 mb-0.5 rounded-[6px] text-[13.5px] font-medium transition-colors ${
                  active
                    ? "bg-white text-black"
                    : "text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text"
                }`}
              >
                <Icon size={16} strokeWidth={2} />
                {label}
                {href === "/admin/updates" && updateAvailable && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" title="Update available" />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="px-5 py-4 text-[11px] text-visiyon-text-3">
          <div className="flex items-center justify-between">
            <span>Visiyon AI · Community Edition</span>
            {version && <span className="font-mono text-visiyon-text-3">v{version}</span>}
          </div>
          <a
            href="https://community.visiyon.com"
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1 hover:text-visiyon-text transition-colors"
          >
            community.visiyon.com
          </a>
        </div>
      </aside>
    </>
  );
}
