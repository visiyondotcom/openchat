"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

// Lightweight, self-hosted consent banner for general GDPR disclosure —
// same pattern used across the other Visiyon subdomains. ai.visiyon.com
// has no privacy page of its own, so this links to the central one.
// Skipped on /admin/* (internal dashboard, not a visitor page).
const CONSENT_KEY = "visiyon_cookie_consent";

export default function CookieConsentBanner() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const existing = localStorage.getItem(CONSENT_KEY);
      setVisible(!existing);
    } catch {
      setVisible(true);
    }
  }, []);

  if (pathname?.startsWith("/admin") || !visible) return null;

  function choose(status: "accepted" | "rejected") {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({ status, at: new Date().toISOString() }));
    } catch {
      // ignore — banner just reappears next visit
    }
    setVisible(false);
  }

  return (
    <div className="fixed left-0 right-0 bottom-0 z-[9998] bg-visiyon-bg px-5 py-4 flex flex-wrap items-center justify-between gap-3.5 shadow-[0_-8px_30px_rgba(0,0,0,0.5)]">
      <div className="flex-1 min-w-[240px] text-[13.5px] leading-relaxed text-visiyon-text/70">
        We use cookies for essential site functionality and, where you consent, for personalisation and analytics. See our{" "}
        <a href="https://visiyon.com/privacy.html#cookies" className="text-visiyon-text underline">
          Cookie Policy
        </a>
        .
      </div>
      <div className="flex gap-2.5 flex-shrink-0">
        <button
          onClick={() => choose("rejected")}
          className="text-[13px] px-4 py-2 rounded-[2px] border border-white/15 text-visiyon-text hover:bg-white/5 transition-colors"
        >
          Reject non-essential
        </button>
        <button
          onClick={() => choose("accepted")}
          className="text-[13px] px-4 py-2 rounded-[2px] bg-visiyon-text text-visiyon-bg font-medium hover:opacity-90 transition-opacity"
        >
          Accept all
        </button>
      </div>
    </div>
  );
}
