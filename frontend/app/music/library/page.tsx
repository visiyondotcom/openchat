"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/useAuth";
import { musicLibrary, musicLibraryGenres, downloadMusicTrack, LibraryTrack } from "@/lib/api";
import { useMusicPlayer, PlayerTrack } from "@/lib/musicPlayer";
import { ArrowLeft, Loader2, Download, Play, Pause, Search, Disc3, AlertTriangle } from "lucide-react";

// Same formatting as music-backend's fmtTime().
function fmt(sec: number) {
  if (!sec && sec !== 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function MusicLibraryPage() {
  const { ready } = useRequireAuth();
  const [genres, setGenres] = useState<string[]>([]);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [playError, setPlayError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const TRACKS_PER_PAGE = 10;
  const player = useMusicPlayer();

  useEffect(() => {
    musicLibraryGenres()
      .then((r) => setGenres(r.genres))
      .catch(() => setGenres([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(() => {
      musicLibrary({ genre: activeGenre || undefined, search: search.trim() || undefined })
        .then((r) => setTracks(r.tracks))
        .catch(() => setTracks([]))
        .finally(() => setLoading(false));
    }, 250); // debounce search-as-you-type
    return () => clearTimeout(handle);
  }, [activeGenre, search]);

  // A new filter/search always starts back at page 1, same as music-backend.
  useEffect(() => {
    setPage(1);
  }, [activeGenre, search]);

  const totalPages = Math.max(1, Math.ceil(tracks.length / TRACKS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pageTracks = tracks.slice((currentPage - 1) * TRACKS_PER_PAGE, currentPage * TRACKS_PER_PAGE);

  function goToPage(p: number) {
    if (p < 1 || p > totalPages) return;
    setPage(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function togglePlay(track: LibraryTrack) {
    setPlayError(null);
    if (!track.audioUrl) {
      setPlayError("This track has no audio file yet.");
      return;
    }
    // Queue the whole currently-visible (filtered/searched) list, in
    // order, so auto-advance moves through what's on screen.
    const queue: PlayerTrack[] = tracks;
    const startIndex = queue.findIndex((t) => t.id === track.id);
    player.playQueue(queue, startIndex === -1 ? 0 : startIndex);
  }

  function download(track: LibraryTrack) {
    downloadMusicTrack(track).catch((err) => setPlayError(err.message || "Download failed."));
  }

  if (!ready) return null;

  return (
    <div className="flex flex-col h-full w-full">
      <div className="h-16 flex items-center gap-3 px-4 sm:px-6 shrink-0">
        <Link href="/music" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text transition-colors">
          <ArrowLeft size={14} /> Back to music generator
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto pb-20">
        <div className="max-w-3xl mx-auto px-6 py-8 w-full">
          <div className="flex items-center gap-2.5 mb-1.5">
            <Disc3 size={20} className="text-visiyon-text" />
            <h1 className="text-lg font-semibold text-visiyon-text">Music library</h1>
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Browse, listen to, and download every track generated on this platform.
          </p>

          <div className="relative mb-4">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-visiyon-text-3" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title, style, or prompt…"
              className="w-full bg-visiyon-text/[0.04] rounded-xl pl-9 pr-4 py-2.5 text-[14px] outline-none focus:bg-visiyon-text/[0.07] text-visiyon-text placeholder-visiyon-text-3/40 transition-colors"
            />
          </div>

          {genres.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-6">
              <button
                onClick={() => setActiveGenre(null)}
                className={`text-[12.5px] px-3 py-1.5 rounded-full transition-colors ${
                  activeGenre === null ? "bg-white text-black" : "bg-visiyon-text/[0.06] text-visiyon-text-2 hover:bg-visiyon-text/10"
                }`}
              >
                All genres
              </button>
              {genres.map((g) => (
                <button
                  key={g}
                  onClick={() => setActiveGenre(g === activeGenre ? null : g)}
                  className={`text-[12.5px] px-3 py-1.5 rounded-full transition-colors capitalize ${
                    activeGenre === g ? "bg-white text-black" : "bg-visiyon-text/[0.06] text-visiyon-text-2 hover:bg-visiyon-text/10"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          )}

          {(playError || player.error) && (
            <div className="flex items-start gap-2.5 rounded-xl bg-red-400/10 px-4 py-3 mb-6 text-[13px] text-red-400">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" /> {playError || player.error}
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-[13px] text-visiyon-text-3 py-8 justify-center">
              <Loader2 size={14} className="animate-spin" /> Loading tracks…
            </div>
          )}

          {!loading && tracks.length === 0 && (
            <p className="text-[13px] text-visiyon-text-3 text-center py-12">
              No tracks found{activeGenre ? ` for "${activeGenre}"` : ""}. Generate one on the{" "}
              <Link href="/music" className="underline hover:text-visiyon-text">
                music generator
              </Link>{" "}
              page.
            </p>
          )}

          {!loading && tracks.length > 0 && (
            <>
              <div className="space-y-2">
                {pageTracks.map((t) => {
                  const isActive = player.track?.id === t.id;
                  const isPlaying = isActive && player.playing;
                  const dur = isActive && player.duration > 0 ? player.duration : t.durationSeconds || 0;
                  const pct = dur > 0 ? Math.min(100, ((isActive ? player.currentTime : 0) / dur) * 100) : 0;
                  const meta = [t.style, t.instrumental ? "Instrumental" : null].filter(Boolean).join(", ");
                  const curTime = isActive ? player.currentTime : 0;
                  return (
                    // Same track-row layout as music-backend: 52px thumb,
                    // stacked name/meta, flat-seek bar flanked by time labels.
                    <div
                      key={t.id}
                      className={`flex items-center gap-3.5 bg-visiyon-text/[0.04] rounded-2xl px-3.5 py-3 transition-colors ${
                        isPlaying ? "bg-visiyon-text/[0.07]" : ""
                      }`}
                    >
                      <button
                        onClick={() => togglePlay(t)}
                        className="group relative flex items-center justify-center h-[52px] w-[52px] rounded-[10px] overflow-hidden shrink-0 bg-black/40"
                        title={isPlaying ? "Pause" : "Play"}
                      >
                        {t.coverUrl ? (
                          <img src={t.coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                        ) : (
                          <Disc3 size={18} className="text-visiyon-text-2" />
                        )}
                        <span
                          className={`absolute inset-0 flex items-center justify-center bg-black/45 transition-opacity ${
                            isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          {isPlaying ? (
                            <Pause size={17} className="text-white" />
                          ) : (
                            <Play size={17} className="text-white ml-0.5" />
                          )}
                        </span>
                      </button>

                      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                        <p className="text-[14.5px] font-semibold text-visiyon-text truncate">{t.title}</p>
                        {meta && <p className="text-[12.5px] text-visiyon-text-3 truncate">{meta}</p>}
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-visiyon-text-3 w-8 shrink-0">{fmt(curTime)}</span>
                          <input
                            type="range"
                            min={0}
                            max={dur || 100}
                            step={0.1}
                            value={curTime}
                            onChange={(e) => isActive && player.seek(parseFloat(e.target.value))}
                            className="flex-1 h-1 cursor-pointer appearance-none rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:opacity-0 hover:[&::-webkit-slider-thumb]:opacity-100"
                            style={{
                              background: `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.14) ${pct}%)`,
                            }}
                            aria-label={`Seek ${t.title}`}
                          />
                          <span className="text-[11px] text-visiyon-text-3 w-8 shrink-0 text-right">{fmt(dur)}</span>
                        </div>
                      </div>

                      <button
                        onClick={() => download(t)}
                        className="flex items-center justify-center h-[38px] w-[38px] rounded-full bg-white/[0.06] text-visiyon-text hover:bg-white/[0.14] hover:-translate-y-px transition-all shrink-0"
                        title="Download"
                      >
                        <Download size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>

              {totalPages > 1 && (() => {
                // Same "1 … prev, current, next … last" collapsing rule as
                // music-backend's buildPagination, so long libraries don't
                // render a button for every single page.
                const pages: (number | "…")[] = [];
                for (let p = 1; p <= totalPages; p++) {
                  if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
                    pages.push(p);
                  } else if (pages[pages.length - 1] !== "…") {
                    pages.push("…");
                  }
                }
                return (
                  <div className="flex items-center justify-center gap-1.5 mt-6">
                    <button
                      onClick={() => goToPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="h-8 w-8 flex items-center justify-center rounded-full text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      ‹
                    </button>
                    {pages.map((p, i) =>
                      p === "…" ? (
                        <span key={`ellipsis-${i}`} className="h-8 w-8 flex items-center justify-center text-[13px] text-visiyon-text-3">
                          …
                        </span>
                      ) : (
                        <button
                          key={p}
                          onClick={() => goToPage(p)}
                          className={`h-8 w-8 flex items-center justify-center rounded-full text-[13px] transition-colors ${
                            p === currentPage
                              ? "bg-white text-black"
                              : "text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text"
                          }`}
                        >
                          {p}
                        </button>
                      )
                    )}
                    <button
                      onClick={() => goToPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="h-8 w-8 flex items-center justify-center rounded-full text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      ›
                    </button>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
