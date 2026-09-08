"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";
import { Search, Bell, HelpCircle, ChevronDown, LogOut, Settings as SettingsIcon, User, Menu } from "lucide-react";
import { getMe, listLogs, listSecurityAlerts, logout as apiLogout, LogEntry, SecurityAlert } from "@/lib/api";

type Notification =
  | { kind: "log"; id: string; level: "WARN" | "ERROR"; text: string; createdAt: string; href: string }
  | { kind: "alert"; id: string; text: string; createdAt: string; href: string };

const LAST_SEEN_KEY = "visiyon_admin_notifications_last_seen";
const POLL_MS = 45_000;

// Azure-portal-style top bar — logo on the left, a centered search field for
// jumping straight to admin functions/plugins/settings, and a row of icon
// buttons ending flush against the right edge with the profile menu. Flat
// black, no borders/dividers anywhere, 6px-radius buttons throughout. Sits
// above AdminSidebar in app/admin/layout.tsx.

const SEARCHABLE = [
  { label: "Users", href: "/admin/users" },
  { label: "Models", href: "/admin/models" },
  { label: "AI Providers", href: "/admin/providers" },
  { label: "Meta-Models (Jean)", href: "/admin/meta-models" },
  { label: "Analytics", href: "/admin/analytics" },
  { label: "Evaluations", href: "/admin/evaluations" },
  { label: "Functions", href: "/admin/functions" },
  { label: "MCP Servers", href: "/admin/mcp" },
  { label: "Settings", href: "/admin/settings" },
  { label: "Music generation settings", href: "/admin/settings/music" },
  { label: "Billing settings", href: "/admin/settings/billing" },
];

export default function AdminTopbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const router = useRouter();
  const [user, setUser] = useState<{ name?: string | null; email?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [queryOpen, setQueryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string>("");
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Pulls the same data the Overview > Event log and security-alert panels
  // show, so the bell reflects real WARN/ERROR log entries and open
  // security alerts rather than being decorative. Polled on an interval
  // since there's no push channel for this yet.
  useEffect(() => {
    setLastSeen(localStorage.getItem(LAST_SEEN_KEY) || "");

    async function refresh() {
      try {
        const [logs, alerts] = await Promise.all([
          listLogs({ limit: 20 }),
          listSecurityAlerts("OPEN"),
        ]);
        const logItems: Notification[] = (logs as LogEntry[])
          .filter((l) => l.level === "WARN" || l.level === "ERROR")
          .map((l) => ({
            kind: "log",
            id: `log-${l.id}`,
            level: l.level as "WARN" | "ERROR",
            text: l.message,
            createdAt: l.createdAt,
            href: "/admin#logs",
          }));
        const alertItems: Notification[] = (alerts as SecurityAlert[]).map((a) => ({
          kind: "alert",
          id: `alert-${a.id}`,
          text: a.summary,
          createdAt: a.createdAt,
          href: "/admin#logs",
        }));
        const combined = [...logItems, ...alertItems]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 12);
        setNotifications(combined);
      } catch {
        // Admin session not ready yet, or the endpoints aren't reachable —
        // leave the bell inert rather than erroring out the whole topbar.
      }
    }

    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const unseenCount = notifications.filter((n) => !lastSeen || n.createdAt > lastSeen).length;
  const hasUnseen = unseenCount > 0;

  function toggleNotifications() {
    setNotifOpen((open) => {
      const next = !open;
      if (next) {
        // Mark everything currently loaded as seen the moment the panel
        // opens, same convention as most bell menus — the badge clears,
        // new items after this point light it back up.
        const now = new Date().toISOString();
        localStorage.setItem(LAST_SEEN_KEY, now);
        setLastSeen(now);
      }
      return next;
    });
  }

  function timeAgo(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  const initial = (user?.name || user?.email || "?").charAt(0).toUpperCase();
  const results = query.trim()
    ? SEARCHABLE.filter((r) => r.label.toLowerCase().includes(query.trim().toLowerCase()))
    : SEARCHABLE;

  function goTo(href: string) {
    setQuery("");
    setQueryOpen(false);
    router.push(href);
  }

  function logout() {
    apiLogout();
    router.push("/login");
  }

  return (
    <header className="h-12 shrink-0 flex items-center gap-4 pl-4 bg-visiyon-bg">
      <button
        onClick={onOpenSidebar}
        className="text-visiyon-text-2 hover:text-visiyon-text p-1 shrink-0 lg:hidden"
        title="Open menu"
      >
        <Menu size={20} />
      </button>
      <Link href="/admin" className="flex items-center gap-2 shrink-0">
        <Logo size={18} />
        <span className="text-[13px] font-medium text-visiyon-text-2 hidden sm:inline">Admin</span>
      </Link>

      <div className="flex-1 max-w-xl mx-auto relative hidden md:block">
        <div className="flex items-center gap-2 bg-visiyon-text/[0.06] rounded-[6px] px-3 h-8 text-visiyon-text-3 focus-within:bg-visiyon-text/[0.1]">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setQueryOpen(true)}
            onBlur={() => setTimeout(() => setQueryOpen(false), 120)}
            placeholder="Search functions, plugins, settings…"
            autoComplete="off"
            name="admin-topbar-search"
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-visiyon-text-3"
          />
        </div>
        {queryOpen && (
          <div className="absolute top-[calc(100%+6px)] left-0 right-0 bg-visiyon-panel rounded-[6px] shadow-lg py-1.5 max-h-80 overflow-y-auto z-50">
            {results.length === 0 ? (
              <div className="px-3 py-2 text-[12.5px] text-visiyon-text-3">No matches.</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.href}
                  onMouseDown={() => goTo(r.href)}
                  className="w-full text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
                >
                  {r.label}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 ml-auto shrink-0 pr-2">
        <div className="relative" ref={notifRef}>
          <button
            onClick={toggleNotifications}
            className={`relative p-2 rounded-[6px] transition-colors ${
              hasUnseen ? "text-visiyon-text hover:bg-visiyon-text/[0.08]" : "text-visiyon-text-3 hover:bg-visiyon-text/[0.08] hover:text-visiyon-text"
            }`}
            title="Notifications"
          >
            <Bell size={16} />
            {hasUnseen && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            )}
          </button>

          {notifOpen && (
            <div className="absolute top-[calc(100%+6px)] right-0 w-80 bg-visiyon-panel rounded-[6px] shadow-lg py-1.5 z-50">
              <div className="px-3 py-2 text-[13px] font-medium text-visiyon-text">Notifications</div>
              {notifications.length === 0 ? (
                <div className="px-3 py-3 text-[12.5px] text-visiyon-text-3">
                  No warnings, errors, or open security alerts.
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onMouseDown={() => goTo(n.href)}
                      className="w-full text-left px-3 py-2 hover:bg-visiyon-text/[0.06] rounded-[6px] flex items-start gap-2"
                    >
                      <span
                        className={`mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                          n.kind === "log" && n.level === "ERROR"
                            ? "bg-red-400/20 text-red-400"
                            : "bg-yellow-500 text-black"
                        }`}
                      >
                        {n.kind === "log" ? n.level : "ALERT"}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[12.5px] text-visiyon-text-2 truncate">{n.text}</span>
                        <span className="block text-[11px] text-visiyon-text-3">{timeAgo(n.createdAt)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <a
          href="/docs/visiyon-admin-manual.pdf"
          target="_blank"
          rel="noreferrer"
          className="p-2 rounded-[6px] text-visiyon-text-3 hover:bg-visiyon-text/[0.08] hover:text-visiyon-text transition-colors"
          title="Help"
        >
          <HelpCircle size={16} />
        </a>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-[6px] hover:bg-visiyon-text/[0.08] transition-colors"
          >
            <div className="relative w-7 h-7 rounded-full bg-visiyon-text/10 flex items-center justify-center text-[12px] font-medium shrink-0">
              {initial}
              <span className="absolute bottom-0 right-0 w-2 h-2" title="Online">
                <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-75" />
                <span className="absolute inset-0 rounded-full bg-emerald-500 ring-2 ring-visiyon-bg" />
              </span>
            </div>
            <ChevronDown size={14} className="text-visiyon-text-3" />
          </button>

          {menuOpen && (
            <div className="absolute top-[calc(100%+6px)] right-0 w-56 bg-visiyon-panel rounded-[6px] shadow-lg py-1.5 z-50">
              <div className="px-3 py-2">
                <div className="text-[13px] text-visiyon-text truncate">{user?.name || "Admin"}</div>
                <div className="text-[11.5px] text-visiyon-text-3 truncate">{user?.email}</div>
              </div>
              <button
                onMouseDown={() => goTo("/settings")}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
              >
                <User size={14} /> Your profile
              </button>
              <button
                onMouseDown={() => goTo("/admin/settings")}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text rounded-[6px]"
              >
                <SettingsIcon size={14} /> Admin settings
              </button>
              <button
                onMouseDown={logout}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-visiyon-text/[0.06] rounded-[6px]"
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
