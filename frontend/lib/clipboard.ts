// navigator.clipboard only exists in "secure contexts" (https, or
// localhost). Accessed over plain http on a real host/IP — which is
// exactly how this app is reached during setup, e.g. http://<server-ip>:8090
// — `navigator.clipboard` is `undefined`, so calling `.writeText` directly
// throws "Cannot read properties of undefined". This wraps every copy
// action with a fallback so it degrades gracefully instead of crashing
// the page.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy fallback below
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
