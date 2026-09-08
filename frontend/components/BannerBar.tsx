"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getPublicConfig, PublicBanner } from "@/lib/api";
import { Info, AlertTriangle, AlertCircle, CheckCircle2, X } from "lucide-react";

const STYLES: Record<PublicBanner["type"], { wrap: string; icon: ReactNode }> = {
  info: { wrap: "bg-visiyon-bg text-visiyon-text", icon: <Info size={14} /> },
  warning: { wrap: "bg-visiyon-bg text-visiyon-text", icon: <AlertTriangle size={14} /> },
  error: { wrap: "bg-visiyon-bg text-visiyon-text", icon: <AlertCircle size={14} /> },
  success: { wrap: "bg-visiyon-bg text-visiyon-text", icon: <CheckCircle2 size={14} /> },
};

const DISMISSED_KEY = "visiyon_dismissed_banners";

export default function BannerBar() {
  const [banners, setBanners] = useState<PublicBanner[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    getPublicConfig()
      .then((cfg) => setBanners(cfg.banners ?? []))
      .catch(() => setBanners([]));
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      setDismissed(raw ? JSON.parse(raw) : []);
    } catch {
      setDismissed([]);
    }
  }, []);

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = [...prev, id];
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable — banner will just reappear next visit
      }
      return next;
    });
  }

  const visible = banners.filter((b) => b.enabled && b.content?.trim() && !dismissed.includes(b.id));
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 px-3 pt-3">
      {visible.map((b) => {
        const style = STYLES[b.type] ?? STYLES.info;
        return (
          <div
            key={b.id}
            className={`flex items-center justify-center gap-2 rounded-[2px] px-3 py-2 text-[13px] text-center mx-auto w-fit whitespace-nowrap ${style.wrap}`}
          >
            {style.icon}
            <span>{b.content}</span>
            <button onClick={() => dismiss(b.id)} className="opacity-70 hover:opacity-100 transition-opacity" title="Dismiss">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
