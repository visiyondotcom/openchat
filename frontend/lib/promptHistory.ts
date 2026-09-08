const KEY = "visiyon:prompt-history";
const MAX_ITEMS = 50;

export function getPromptHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function addPromptToHistory(prompt: string) {
  if (typeof window === "undefined") return;
  const trimmed = prompt.trim();
  if (!trimmed) return;
  try {
    const existing = getPromptHistory().filter((p) => p !== trimmed);
    const updated = [trimmed, ...existing].slice(0, MAX_ITEMS);
    window.localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {
    // ignore quota / serialization errors
  }
}

export function removePromptFromHistory(prompt: string) {
  if (typeof window === "undefined") return;
  try {
    const updated = getPromptHistory().filter((p) => p !== prompt);
    window.localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
}
