"use client";

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { getPublicConfigCached } from "@/lib/api";
import {
  getNotificationsPref,
  setNotificationsPref,
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/notificationPref";

// Once someone dismisses this (either "Notify" or the X), don't ask again
// on every chat — that's what actually turning notifications on/off in
// Settings > Notifications is for. This is a one-time nudge.
const DISMISSED_KEY = "visiyon_notify_banner_dismissed";

/**
 * A one-time prompt, shown above the chat composer, offering to turn on
 * desktop notifications for replies (the same feature as the toggle in
 * Settings > Notifications — this is just a more visible first ask).
 * Admin-configurable: Admin > Settings > General > Features >
 * "'Enable notifications' chat banner". Hidden entirely if that flag is
 * off, if the browser doesn't support the Notification API, if the
 * preference is already on, or if permission was already decided
 * (granted/denied) or previously dismissed here.
 */
export default function NotifyBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(DISMISSED_KEY) === "1") return;
    if (getNotificationsPref()) return;
    if (getNotificationPermission() !== "default") return;

    let cancelled = false;
    getPublicConfigCached()
      .then((cfg) => {
        if (!cancelled && cfg.features.notifyBanner) setVisible(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  }

  async function handleNotify() {
    const permission = await requestNotificationPermission();
    if (permission === "granted") {
      setNotificationsPref(true);
    }
    // Whether granted or denied, the ask has now happened — don't keep
    // showing the banner either way (a "denied" answer can only be
    // reversed from the browser's own site settings, not by asking again).
    dismiss();
  }

  if (!visible) return null;

  return (
    <div className="notify-banner flex items-center justify-between gap-3 rounded-[13px] border border-visiyon-border bg-[#161616]/95 backdrop-blur-xl px-4 py-3 mb-2 shadow-[0_4px_16px_rgba(0,0,0,0.4)]">
      <span className="flex items-center gap-2 text-[13.5px] text-visiyon-text min-w-0">
        <Bell size={15} className="text-visiyon-text-3 shrink-0" />
        <span className="truncate">Want to be notified when the AI responds?</span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleNotify}
          className="text-[12.5px] font-medium px-3 py-1.5 rounded-full bg-white text-black hover:bg-white/90 transition-colors"
        >
          Notify
        </button>
        <button
          onClick={dismiss}
          className="p-1 rounded-full text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/10 transition-colors"
          title="Dismiss"
        >
          <X size={15} />
        </button>
      </span>
    </div>
  );
}
