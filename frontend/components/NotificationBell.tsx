"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, ImageIcon, VideoIcon, AlertTriangle } from "lucide-react";
import {
  AppNotification,
  getUnreadNotificationCount,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/useAuth";

const POLL_MS = 25_000;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// Account-synced notification bell — a server-backed history of
// generation events (see backend routes/notifications.ts), distinct from
// the browser-permission desktop popup in lib/notificationPref.ts. Polls
// the unread count in the background; the dropdown list is only fetched
// once actually opened.
export default function NotificationBell() {
  const { user } = useRequireAuth();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  const refreshCount = useCallback(async () => {
    try {
      const { count } = await getUnreadNotificationCount();
      setUnread(count);
    } catch {
      // Silent — polling shouldn't surface transient network errors.
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshCount();
    const id = setInterval(refreshCount, POLL_MS);
    return () => clearInterval(id);
  }, [user, refreshCount]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function toggleOpen() {
    if (!open && btnRef.current) {
      // Same fixed-coords trick as UserMenu — the rail sits inside an
      // overflow-hidden flex layout, so a right-anchored absolute
      // dropdown gets clipped instead of floating next to the rail.
      const rect = btnRef.current.getBoundingClientRect();
      setCoords({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom });
      setLoading(true);
      try {
        const { notifications } = await listNotifications();
        setItems(notifications);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  }

  async function onItemClick(n: AppNotification) {
    setOpen(false);
    if (!n.readAt) {
      setUnread((c) => Math.max(0, c - 1));
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)));
      markNotificationRead(n.id).catch(() => {});
    }
    router.push("/generate");
  }

  async function onMarkAllRead() {
    setUnread(0);
    setItems((prev) => prev.map((i) => (i.readAt ? i : { ...i, readAt: new Date().toISOString() })));
    markAllNotificationsRead().catch(() => {});
  }

  if (!user) return null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggleOpen}
        className="relative h-8 w-8 rounded-lg flex items-center justify-center text-visiyon-text-2 hover:text-visiyon-text hover:bg-white/5 transition-colors"
        title="Notifications"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute top-1 right-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-visiyon-panel2" />
        )}
      </button>

      {open && coords && (
        <div
          ref={menuRef}
          style={{ position: "fixed", left: coords.left, bottom: coords.bottom }}
          className="w-80 max-h-96 flex flex-col rounded-xl border border-visiyon-border bg-visiyon-panel2 shadow-xl z-[100] text-[13px]"
        >
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-visiyon-border">
            <span className="font-medium text-visiyon-text">Notifications</span>
            {unread > 0 && (
              <button
                onClick={onMarkAllRead}
                className="flex items-center gap-1 text-[11px] text-visiyon-text-2 hover:text-visiyon-text"
              >
                <CheckCheck size={12} />
                Mark all read
              </button>
            )}
          </div>

          <div className="overflow-y-auto flex-1">
            {loading && <div className="px-3.5 py-6 text-center text-visiyon-text-2">Loading…</div>}
            {!loading && items.length === 0 && (
              <div className="px-3.5 py-6 text-center text-visiyon-text-2">No notifications yet.</div>
            )}
            {!loading &&
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  className={`w-full flex items-start gap-2.5 px-3.5 py-2.5 text-left hover:bg-white/5 border-b border-visiyon-border/50 last:border-b-0 ${
                    n.readAt ? "opacity-60" : ""
                  }`}
                >
                  <span className="mt-0.5 shrink-0 text-visiyon-text-2">
                    {n.type === "GENERATION_FAILED" ? (
                      <AlertTriangle size={14} className="text-red-400" />
                    ) : n.title.toLowerCase().includes("video") ? (
                      <VideoIcon size={14} />
                    ) : (
                      <ImageIcon size={14} />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-visiyon-text truncate">{n.title}</span>
                    {n.body && <span className="block text-visiyon-text-2 text-[11px] truncate">{n.body}</span>}
                    <span className="block text-visiyon-text-2 text-[10px] mt-0.5">{timeAgo(n.createdAt)}</span>
                  </span>
                  {!n.readAt && <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />}
                </button>
              ))}
          </div>
        </div>
      )}
    </>
  );
}
