// Per-user preference for the floating "Need help?" support widget.
// Deliberately client-side only (localStorage), not a backend/User field —
// this is a personal show/hide toggle, not something that needs syncing
// across devices or that an admin manages. See Settings > Profile and
// components/SupportChatWidget.tsx.
const STORAGE_KEY = "visiyon_support_widget_enabled";
const CHANGE_EVENT = "visiyon:support-widget-pref-changed";

export function getSupportWidgetEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? true : raw === "true";
}

export function setSupportWidgetEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// Lets any mounted widget re-read the preference immediately when it's
// changed elsewhere (e.g. the Settings page), instead of only picking it
// up on the next page load.
export function onSupportWidgetPrefChange(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
