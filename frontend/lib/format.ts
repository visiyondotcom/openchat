// Formats a rolling-window quota reset timestamp as a short relative
// string ("in 42 min", "in 3h 10m") for display in the chat limit modal
// and the Settings "Usage" widget. The quota window frees up budget
// gradually as old events age out (see backend lib/quota.ts,
// QUOTA_WINDOW_HOURS) rather than resetting all at once at a fixed clock
// time, so there's no single "resets at midnight" string to show anymore.
// Formats a message's createdAt timestamp as a short "date time" string
// for the small caption shown under each chat bubble, e.g. "Jul 27, 14:32".
// Falls back to just the time for messages from today.
export function formatMessageTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

// Full absolute date+time, always including the year, for the hover
// tooltip on a message's relative timestamp ("6 minutes ago" -> hover ->
// "Aug 26, 2026, 9:27 AM") — unlike formatMessageTimestamp above, this
// never shortens to time-only for "today" since the whole point of the
// tooltip is to show the precise, unambiguous moment.
export function formatFullTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Formats a message's createdAt timestamp as a short relative string
// ("just now", "1 minute ago", "5 minutes ago", "2 hours ago") for the
// hover-only caption shown under a chat bubble. Falls back to
// formatMessageTimestamp's date/time string once it's more than a day old.
export function formatRelativeAgo(createdAt: string): string {
  const date = new Date(createdAt);
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return diffHr === 1 ? "1 hour ago" : `${diffHr} hours ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
  return formatMessageTimestamp(createdAt);
}

export function formatResetRelative(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "shortly";
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) return `in ${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
}
