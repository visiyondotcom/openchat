"use client";

import { SettingsContent } from "@/components/SettingsContent";

// Standalone route — used for direct links/refreshes/bookmarks, and as a
// fallback if JS hasn't hydrated the modal yet. The real day-to-day entry
// point is the "Settings" item in the sidebar's account menu, which opens
// SettingsContent inside SettingsModal (a floating panel over the chat)
// instead of navigating here. No onClose passed, so this shows the full
// "Back to chat" link instead of an X.
export default function SettingsPage() {
  return <SettingsContent />;
}
