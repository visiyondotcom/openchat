// Per-user preference for desktop notifications when a reply finishes
// streaming while the tab is in the background. Deliberately client-side
// only (localStorage + the browser's own Notification permission), not a
// backend/User field — there's no server-side push infra here, this is
// purely "ping me when the tab isn't focused". See Settings > Notifications
// and components/ChatWindow.tsx (the actual notify() call on stream end).
const STORAGE_KEY = "visiyon_desktop_notifications_enabled";

export function getNotificationsPref(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setNotificationsPref(enabled: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

// Browsers only grant/deny per-origin, and only in response to a user
// gesture (a settings toggle click qualifies) — this is what the
// Notifications tab's toggle calls before turning the pref on.
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission === "default") {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

// Called from ChatWindow when a reply finishes streaming. No-ops unless
// the pref is on, permission was granted, and the tab is actually hidden —
// no point interrupting someone who's already looking at the reply.
export function notifyReplyReady(preview: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (!getNotificationsPref() || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  const n = new Notification("Visiyon AI", {
    body: preview.slice(0, 140) || "Your reply is ready.",
    icon: "/favicon.ico",
  });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}
