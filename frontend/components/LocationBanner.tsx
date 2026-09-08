"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

// Stored as plain JSON in localStorage (not sent anywhere on its own) so
// other parts of the app — e.g. a future "attach my location" toggle on
// the composer — can read it without asking the browser again.
export const LOCATION_STORAGE_KEY = "visiyon_user_location";
const DISMISS_KEY = "visiyon_location_banner_dismissed";

export function readStoredLocation(): { lat: number; lon: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LOCATION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function LocationBanner() {
  const [dismissed, setDismissed] = useState(true);
  const [status, setStatus] = useState<"idle" | "requesting" | "denied">("idle");

  useEffect(() => {
    try {
      const alreadyDismissed = localStorage.getItem(DISMISS_KEY) === "1";
      const alreadyShared = Boolean(readStoredLocation());
      setDismissed(alreadyDismissed || alreadyShared);
    } catch {
      setDismissed(false);
    }
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore — banner may reappear next visit, not critical
    }
  }

  function enable() {
    if (!navigator.geolocation) {
      setStatus("denied");
      return;
    }
    setStatus("requesting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        try {
          localStorage.setItem(
            LOCATION_STORAGE_KEY,
            JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude })
          );
        } catch {
          // ignore — worst case the AI just won't have location this session
        }
        dismiss();
      },
      () => setStatus("denied"),
      { timeout: 10000 }
    );
  }

  if (dismissed) return null;

  return (
    <div className="max-w-3xl mx-auto mb-4 flex items-center justify-center gap-2 text-[13px] text-visiyon-text-2">
      <span>
        {status === "denied"
          ? "Couldn't get your location — you can allow it in your browser settings and try again."
          : "Share your location so the AI knows where you are?"}
      </span>
      <button
        onClick={enable}
        disabled={status === "requesting"}
        className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-white text-black hover:bg-visiyon-text/85 transition-colors disabled:opacity-50"
      >
        {status === "requesting" ? "Requesting…" : "Enable"}
      </button>
      <button onClick={dismiss} className="text-visiyon-text-3 hover:text-visiyon-text transition-colors" title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
