"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/useAuth";
import { exploreFeed, likeGeneration, ExploreFeedItem } from "@/lib/api";
import { X, Heart, Image as ImageIcon, Video as VideoIcon, Loader2, RefreshCcw, Compass, Download } from "lucide-react";

type Filter = "all" | "image" | "video";

// Same fix as /assets: the download attribute is ignored on cross-origin
// <a> links (resultUrls point at the CDN, not this origin), so a plain
// <a download href={cdnUrl}> just navigates — and with target="_blank"
// that looked like it was "opening a new tab" instead of downloading.
// Fetching the file and downloading the resulting (same-origin) blob URL
// sidesteps that.
async function downloadAsset(url: string, modality: "IMAGE" | "VIDEO") {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const nameFromUrl = url.split("/").pop()?.split("?")[0];
    const filename = nameFromUrl && nameFromUrl.includes(".") ? nameFromUrl : `asset.${modality === "IMAGE" ? "png" : "mp4"}`;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch {
    // CORS or network failure — fall back to the old behavior rather than
    // silently doing nothing.
    window.open(url, "_blank");
  }
}

export default function ExplorePage() {
  const { ready } = useRequireAuth();
  const router = useRouter();

  const [items, setItems] = useState<ExploreFeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [likedIds, setLikedIds] = useState<Record<string, true>>({});
  const [likingIds, setLikingIds] = useState<Record<string, true>>({});
  const [openItem, setOpenItem] = useState<ExploreFeedItem | null>(null);

  useEffect(() => {
    if (!ready) return;
    exploreFeed()
      .then((r) => {
        setItems(r.items);
        setNextCursor(r.nextCursor);
        // Seed liked state from the server instead of starting every
        // reload as "not liked" — the backend now tracks likes per
        // account, so this is what makes the heart correctly show as
        // already-liked after a refresh instead of letting you like the
        // same post again.
        const liked: Record<string, true> = {};
        r.items.forEach((it) => {
          if (it.likedByMe) liked[it.taskId] = true;
        });
        setLikedIds(liked);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ready]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await exploreFeed(nextCursor);
      setItems((prev) => [...prev, ...r.items]);
      setNextCursor(r.nextCursor);
      setLikedIds((prev) => {
        const copy = { ...prev };
        r.items.forEach((it) => {
          if (it.likedByMe) copy[it.taskId] = true;
        });
        return copy;
      });
    } catch {
      // silently stop paginating on error — user can retry via scroll
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggleLike(item: ExploreFeedItem) {
    // Guard against double-clicks / rapid re-clicks firing a second
    // request before the first one's response updates state.
    if (likingIds[item.taskId]) return;
    setLikingIds((prev) => ({ ...prev, [item.taskId]: true }));
    const nextLiked = !likedIds[item.taskId];
    setLikedIds((prev) => {
      const copy = { ...prev };
      if (nextLiked) copy[item.taskId] = true;
      else delete copy[item.taskId];
      return copy;
    });
    setItems((prev) =>
      prev.map((x) => (x.taskId === item.taskId ? { ...x, likeCount: x.likeCount + (nextLiked ? 1 : -1) } : x))
    );
    try {
      const res = await likeGeneration(item.taskId, nextLiked);
      // Trust the server's count rather than our optimistic guess — if a
      // duplicate click already got no-op'd server-side, this corrects
      // the displayed number back to what's actually stored.
      setItems((prev) => prev.map((x) => (x.taskId === item.taskId ? { ...x, likeCount: res.likeCount } : x)));
    } catch {
      setLikedIds((prev) => {
        const copy = { ...prev };
        if (nextLiked) delete copy[item.taskId];
        else copy[item.taskId] = true;
        return copy;
      });
      setItems((prev) =>
        prev.map((x) => (x.taskId === item.taskId ? { ...x, likeCount: x.likeCount - (nextLiked ? 1 : -1) } : x))
      );
    } finally {
      setLikingIds((prev) => {
        const copy = { ...prev };
        delete copy[item.taskId];
        return copy;
      });
    }
  }

  function recreate(item: ExploreFeedItem) {
    // Previously omitted the modality, so a recreated VIDEO landed on the
    // Generate page's default Image tab with a video model key set behind
    // the scenes — mismatched, and pressing Generate would silently run
    // image generation instead of video. Pass modality too so /generate's
    // existing deep-link handling puts you on the right tab with the
    // right model actually selected.
    const qs = new URLSearchParams({
      prompt: item.prompt,
      modelKey: item.modelKey,
      modality: item.modality === "VIDEO" ? "video" : "image",
    });
    router.push(`/generate?${qs.toString()}`);
  }

  const filtered = useMemo(
    () =>
      items.filter((it) => {
        if (filter === "image") return it.modality === "IMAGE";
        if (filter === "video") return it.modality === "VIDEO";
        return true;
      }),
    [items, filter]
  );

  if (!ready) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-visiyon-bg text-visiyon-text">
      {/* Same header shape as /assets: X back, title, pill filter — kept
          consistent with the rest of the app rather than a bespoke layout. */}
      <header className="flex items-center gap-3 px-5 h-14 shrink-0 border-b border-visiyon-border overflow-x-auto no-scrollbar">
        <Link href="/generate" className="text-visiyon-text-2 hover:text-visiyon-text transition-colors">
          <X size={18} />
        </Link>
        <h1 className="text-[15px] font-medium">Explore</h1>
        <div className="ml-4 flex items-center gap-1 rounded-full bg-visiyon-panel2 border border-visiyon-border p-1">
          {(
            [
              ["all", "All"],
              ["image", "Images"],
              ["video", "Videos"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${
                filter === key ? "bg-visiyon-accent text-visiyon-bg" : "text-visiyon-text-3 hover:text-visiyon-text-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-5 py-6">
        <div className="max-w-[1400px] mx-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-visiyon-text-3">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="mx-auto max-w-sm mt-10 rounded-xl border border-visiyon-border bg-visiyon-panel2 px-6 py-10 text-center">
            <div className="mx-auto mb-3 h-10 w-10 rounded-full border border-visiyon-border flex items-center justify-center text-visiyon-text-3">
              <Compass size={18} />
            </div>
            <p className="text-[13px] text-visiyon-text-2">
              {items.length === 0 ? (
                <>
                  Nothing published yet — be the first from{" "}
                  <Link href="/generate" className="text-visiyon-accent underline underline-offset-2">
                    Generate
                  </Link>
                  .
                </>
              ) : (
                "No results for this filter."
              )}
            </p>
          </div>
        ) : (
          <>
            <div className="columns-2 sm:columns-3 lg:columns-4 xl:columns-5 gap-3 [column-fill:_balance]">
              {filtered.map((item) => (
                <div
                  key={item.id}
                  onClick={() => setOpenItem(item)}
                  className="mb-3 break-inside-avoid rounded-xl overflow-hidden bg-visiyon-panel2 border border-visiyon-border group relative cursor-pointer"
                >
                  {item.modality === "IMAGE" ? (
                    <img src={item.resultUrls?.[0] || ""} alt={item.prompt} className="w-full h-auto block" />
                  ) : (
                    <video
                      src={item.resultUrls?.[0] || ""}
                      className="w-full h-auto block"
                      muted
                      loop
                      autoPlay
                      playsInline
                    />
                  )}

                  <span className="absolute top-2 left-2 h-5 w-5 rounded bg-black/60 border border-white/10 flex items-center justify-center">
                    {item.modality === "IMAGE" ? (
                      <ImageIcon size={11} className="text-white" />
                    ) : (
                      <VideoIcon size={11} className="text-white" />
                    )}
                  </span>

                  <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/85 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-2">
                    <p className="text-[11.5px] text-white/90 line-clamp-2">{item.prompt}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-white/70 truncate">{item.user.name || "Anonymous"}</span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleLike(item);
                          }}
                          disabled={!!likingIds[item.taskId]}
                          className={`flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-white/15 disabled:opacity-60 ${
                            likedIds[item.taskId] ? "text-pink-400 bg-white/10" : "text-white/85 hover:bg-white/10"
                          }`}
                          title="Like"
                        >
                          <Heart size={13} fill={likedIds[item.taskId] ? "currentColor" : "none"} />
                          {item.likeCount}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            recreate(item);
                          }}
                          className="flex items-center gap-1 text-[11.5px] bg-white text-black rounded-md px-2 py-1 border border-white/15"
                          title="Recreate this generation"
                        >
                          <RefreshCcw size={12} />
                          Recreate
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {nextCursor && (
              <div className="flex justify-center py-6">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="text-[12.5px] px-4 py-2 rounded-lg bg-visiyon-panel2 border border-visiyon-border hover:brightness-110 disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
        </div>
      </main>

      {openItem && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 sm:p-8"
          onClick={() => setOpenItem(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl overflow-hidden border border-visiyon-border bg-visiyon-panel2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex-1 min-h-0 bg-black flex items-center justify-center">
              <button
                onClick={() => setOpenItem(null)}
                className="absolute top-3 right-3 h-8 w-8 flex items-center justify-center rounded-lg bg-black/60 border border-white/15 text-white hover:bg-black/80 z-10"
              >
                <X size={14} />
              </button>
              {openItem.resultUrls?.[0] &&
                (openItem.modality === "IMAGE" ? (
                  <img
                    src={openItem.resultUrls[0]}
                    alt={openItem.prompt}
                    className="max-h-[65vh] max-w-full w-auto h-auto object-contain"
                  />
                ) : (
                  <video
                    src={openItem.resultUrls[0]}
                    controls
                    autoPlay
                    className="max-h-[65vh] max-w-full w-auto h-auto object-contain"
                  />
                ))}
            </div>

            <div className="shrink-0 border-t border-visiyon-border">
              <div className="flex items-center gap-2 px-4 py-3 flex-wrap">
                <span className="text-[12px] text-visiyon-text-3 truncate">{openItem.user.name || "Anonymous"}</span>
                <div className="flex-1" />
                <button
                  onClick={() => toggleLike(openItem)}
                  disabled={!!likingIds[openItem.taskId]}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-visiyon-border text-[12.5px] disabled:opacity-60 ${
                    likedIds[openItem.taskId] ? "text-pink-400 bg-white/10" : "hover:brightness-110 bg-visiyon-panel"
                  }`}
                >
                  <Heart size={13} fill={likedIds[openItem.taskId] ? "currentColor" : "none"} />
                  {items.find((x) => x.taskId === openItem.taskId)?.likeCount ?? openItem.likeCount}
                </button>
                <button
                  onClick={() => recreate(openItem)}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white text-black text-[12.5px]"
                >
                  <RefreshCcw size={13} /> Recreate
                </button>
                {openItem.resultUrls?.[0] && (
                  <button
                    onClick={() => downloadAsset(openItem.resultUrls![0], openItem.modality)}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-visiyon-border bg-visiyon-panel text-[12.5px] hover:brightness-110"
                  >
                    <Download size={13} /> Download
                  </button>
                )}
              </div>
              <p className="px-4 pb-4 text-[12.5px] leading-relaxed text-visiyon-text-2 max-h-24 overflow-y-auto whitespace-pre-line">
                {openItem.prompt}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
