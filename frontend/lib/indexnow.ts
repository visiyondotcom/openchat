// IndexNow lets a site push "this URL changed" straight to search engines
// (Bing, Yandex, Seznam, Naver — and anything on their shared network)
// instead of waiting for them to crawl it on their own schedule.
//
// Verification works via a key file: whatever key we submit with, a file
// named "<key>.txt" containing that same key must be reachable at the
// site root. That file lives at public/<INDEXNOW_KEY>.txt — keep the two
// in sync if the key is ever rotated.

export const INDEXNOW_KEY = "53656c4bfb62797cdeae5edf84f31fc9";
export const INDEXNOW_HOST = "ai.visiyon.com";
const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;

// Single shared endpoint — any engine on the IndexNow network picks this
// up, so there's no need to ping Bing/Yandex separately.
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Notify IndexNow that one or more URLs changed (published, updated, or
 * removed). Call this right after the change is saved — e.g. from an
 * admin "publish" action — not on every page view.
 *
 * Fails silently (logs a warning) since a missed ping should never break
 * the action that triggered it; search engines will still find the page
 * on their next regular crawl either way.
 */
export async function submitToIndexNow(urls: string | string[]): Promise<boolean> {
  const urlList = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (urlList.length === 0) return false;

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: INDEXNOW_HOST,
        key: INDEXNOW_KEY,
        keyLocation: INDEXNOW_KEY_LOCATION,
        urlList,
      }),
    });
    // IndexNow returns 200 (or 202 for a first-time key) on success.
    if (!res.ok) {
      console.warn(`IndexNow submit failed: ${res.status} ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("IndexNow submit error:", err);
    return false;
  }
}
