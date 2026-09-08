"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/useAuth";
import { myGenerationHistory, MediaGeneration } from "@/lib/api";
import { X, Image as ImageIcon, Video as VideoIcon, Loader2, AlertTriangle, Download } from "lucide-react";

type Filter = "all" | "image" | "video";

// The download attribute on <a> is ignored by browsers for cross-origin
// URLs (which resultUrls always are — they point at the CDN, not this
// origin) — so a plain <a download href={cdnUrl}> just navigates instead
// of downloading, and target="_blank" makes that look like "opens a new
// tab". Fetching the file ourselves and downloading the resulting blob
// (which IS same-origin, being a local object URL) sidesteps that entirely.
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

export default function AssetsPage() {
  const { ready } = useRequireAuth();

  const [rows, setRows] = useState<MediaGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [openItem, setOpenItem] = useState<MediaGeneration | null>(null);

  useEffect(() => {
    myGenerationHistory()
      .then(setRows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (filter === "image") return r.modality === "IMAGE";
        if (filter === "video") return r.modality === "VIDEO";
        return true;
      }),
    [rows, filter]
  );

  if (!ready) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-visiyon-bg text-visiyon-text">
      <header className="flex items-center gap-3 px-5 h-14 shrink-0 overflow-x-auto no-scrollbar">
        <Link href="/generate" className="text-visiyon-text-2 hover:text-visiyon-text transition-colors">
          <X size={18} />
        </Link>
        <h1 className="text-[15px] font-medium">Assets</h1>
        <div className="ml-4 flex items-center gap-1 rounded-full bg-visiyon-panel2 p-1">
          {([
            ["all", "All"],
            ["image", "Images"],
            ["video", "Videos"],
          ] as [Filter, string][]).map(([key, label]) => (
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

      <main className="flex-1 min-h-0 overflow-y-auto px-5 pb-10">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-visiyon-text-3">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-visiyon-text-3 text-[13px] py-24">
            {rows.length === 0 ? (
              <>
                Nothing here yet.{" "}
                <Link href="/generate" className="text-visiyon-text underline">
                  Generate something
                </Link>{" "}
                to see it show up here.
              </>
            ) : (
              "No results for this filter."
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {filtered.map((g) => (
              <button
                key={g.taskId}
                onClick={() => setOpenItem(g)}
                className="aspect-square rounded-lg overflow-hidden bg-visiyon-panel2 relative flex items-center justify-center hover:brightness-110 transition"
              >
                {g.status === "PENDING" && <Loader2 size={16} className="animate-spin text-visiyon-text-3" />}
                {g.status === "FAILED" && <AlertTriangle size={16} className="text-red-400" />}
                {g.status === "COMPLETE" && g.resultUrls?.[0] && (
                  g.modality === "IMAGE" ? (
                    <img src={g.resultUrls[0]} alt={g.prompt} className="w-full h-full object-cover" />
                  ) : (
                    <video src={g.resultUrls[0]} className="w-full h-full object-cover" muted />
                  )
                )}
                <span className="absolute bottom-1.5 left-1.5 h-5 w-5 rounded bg-black/60 flex items-center justify-center">
                  {g.modality === "IMAGE" ? <ImageIcon size={11} className="text-white" /> : <VideoIcon size={11} className="text-white" />}
                </span>
              </button>
            ))}
          </div>
        )}
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
              <div className="flex items-center gap-2 px-4 py-3">
                <div className="flex-1" />
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
