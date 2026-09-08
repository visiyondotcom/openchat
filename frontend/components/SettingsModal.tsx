"use client";

import { useEffect } from "react";
import { useChatStore } from "@/lib/store";
import { SettingsContent } from "@/components/SettingsContent";

// Floating settings panel over a blurred chat background — mounted once in
// the root layout so it can be opened from anywhere (sidebar, account menu)
// without a route change. Chat stays mounted underneath, just dimmed/blurred.
export default function SettingsModal() {
  const settingsOpen = useChatStore((s) => s.settingsOpen);
  const closeSettings = useChatStore((s) => s.closeSettings);

  // Esc closes, same as clicking the backdrop or the X.
  useEffect(() => {
    if (!settingsOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeSettings();
    }
    window.addEventListener("keydown", onKeyDown);
    // Prevent the page behind the modal from scrolling while it's open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [settingsOpen, closeSettings]);

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8">
      {/* Backdrop — blurs and dims the chat behind it, click to close */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md"
        onClick={closeSettings}
      />
      {/* Floating panel */}
      <div className="relative w-full max-w-[1400px] h-full max-h-[calc(100vh-4rem)] bg-visiyon-bg border border-visiyon-border rounded-2xl shadow-2xl overflow-hidden">
        <SettingsContent onClose={closeSettings} />
      </div>
    </div>
  );
}
