"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/useAuth";
import { musicGenConfig, startMusicGeneration, checkMusicGeneration, downloadMusicTrack, MusicTrack } from "@/lib/api";
import { safeRandomUUID } from "@/lib/uuid";
import { useMusicPlayer, PlayerTrack } from "@/lib/musicPlayer";
import { ArrowLeft, Music, Loader2, Download, Play, Pause, AlertTriangle } from "lucide-react";

function fmt(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface Generation {
  id: string;
  prompt: string;
  status: "pending" | "complete" | "failed";
  tracks?: MusicTrack[];
  error?: string;
  instrumental?: boolean;
  style?: string;
}

// Real iOS-style toggle switch — a plain checkbox reads as a form field,
// not an on/off control, which is what "Instrumental" / "Custom mode"
// actually are.
function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label
      className="flex items-center gap-2 text-[13px] text-visiyon-text-2 select-none cursor-pointer"
      onClick={(e) => {
        if (disabled) return;
        e.preventDefault();
        onChange(!checked);
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        tabIndex={-1}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
          checked ? "bg-visiyon-accent" : "bg-visiyon-text/20"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
            checked ? "translate-x-4.5 bg-visiyon-bg" : "translate-x-1 bg-visiyon-text"
          }`}
          style={{ transform: checked ? "translateX(18px)" : "translateX(4px)" }}
        />
      </button>
      {label}
    </label>
  );
}

// How often to poll the backend for a running generation's result.
// Suno-style generations typically take 20s-2min.
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export default function MusicPage() {
  const { ready } = useRequireAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [title, setTitle] = useState("");
  const [style, setStyle] = useState("");
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [busy, setBusy] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const player = useMusicPlayer();

  useEffect(() => {
    musicGenConfig()
      .then((c) => setEnabled(c.enabled))
      .catch(() => setEnabled(false));
    return () => {
      Object.values(pollTimers.current).forEach(clearTimeout);
    };
  }, []);

  function pollTask(genId: string, taskId: string, startedAt: number) {
    checkMusicGeneration(taskId)
      .then((res) => {
        if (res.status === "pending") {
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            setGenerations((prev) =>
              prev.map((g) => (g.id === genId ? { ...g, status: "failed", error: "Timed out waiting for the track." } : g))
            );
            return;
          }
          pollTimers.current[genId] = setTimeout(() => pollTask(genId, taskId, startedAt), POLL_INTERVAL_MS);
          return;
        }
        setGenerations((prev) =>
          prev.map((g) =>
            g.id === genId
              ? { ...g, status: res.status, tracks: res.tracks, error: res.error }
              : g
          )
        );
      })
      .catch((err) => {
        setGenerations((prev) =>
          prev.map((g) =>
            g.id === genId ? { ...g, status: "failed", error: err instanceof Error ? err.message : String(err) } : g
          )
        );
      });
  }

  async function generate() {
    const trimmed = prompt.trim();
    const promptRequired = !(customMode && instrumental);
    if ((promptRequired && !trimmed) || busy) return;
    setBusy(true);
    const genId = safeRandomUUID();
    setGenerations((prev) => [
      { id: genId, prompt: trimmed, status: "pending", instrumental, style: customMode ? style.trim() : undefined },
      ...prev,
    ]);
    setPrompt("");
    try {
      const { taskId } = await startMusicGeneration(trimmed, {
        instrumental,
        customMode,
        title: customMode ? title.trim() || undefined : undefined,
        style: customMode ? style.trim() || undefined : undefined,
      });
      pollTask(genId, taskId, Date.now());
    } catch (err) {
      setGenerations((prev) =>
        prev.map((g) =>
          g.id === genId ? { ...g, status: "failed", error: err instanceof Error ? err.message : String(err) } : g
        )
      );
    } finally {
      setBusy(false);
    }
  }

  // Flat, in-order list of every playable track across all generations —
  // this is the queue the global player auto-advances through.
  function allTracks(): PlayerTrack[] {
    return generations
      .filter((g) => g.status === "complete" && g.tracks && g.tracks.length > 0)
      .flatMap((g) => g.tracks as PlayerTrack[]);
  }

  function togglePlay(track: MusicTrack) {
    setPlayError(null);
    if (!track.audioUrl) {
      setPlayError("This track has no audio file yet.");
      return;
    }
    const queue = allTracks();
    const startIndex = queue.findIndex((t) => t.id === track.id);
    player.playQueue(queue, startIndex === -1 ? 0 : startIndex);
  }

  function download(track: MusicTrack) {
    downloadMusicTrack(track).catch((err) => setPlayError(err.message || "Download failed."));
  }

  if (!ready) return null;

  return (
    <div className="flex flex-col h-full w-full">
      <div className="h-16 flex items-center justify-between gap-3 px-4 sm:px-6 shrink-0">
        <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text transition-colors">
          <ArrowLeft size={14} /> Back to chat
        </Link>
        <Link href="/music/library" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text transition-colors">
          Browse library
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto pb-20">
        <div className="max-w-2xl mx-auto px-6 py-8 w-full">
          <div className="flex items-center gap-2.5 mb-1.5">
            <Music size={20} className="text-visiyon-text" />
            <h1 className="text-lg font-semibold text-visiyon-text">Music generator</h1>
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Describe a song and generate original, AI-made tracks.
          </p>

          {(playError || player.error) && (
            <div className="flex items-start gap-2.5 rounded-xl bg-red-400/10 px-4 py-3 mb-6 text-[13px] text-red-400">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" /> {playError || player.error}
            </div>
          )}

          {enabled === false && (
            <div className="flex items-start gap-2.5 rounded-xl bg-visiyon-text/[0.06] px-4 py-3 mb-6 text-[13px] text-visiyon-text-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                Music generation isn't configured on this server yet. Set{" "}
                <code className="bg-visiyon-text/10 px-1 py-0.5 rounded">MUSIC_GEN_URL</code>,{" "}
                <code className="bg-visiyon-text/10 px-1 py-0.5 rounded">MUSIC_GEN_API_KEY</code>, and{" "}
                <code className="bg-visiyon-text/10 px-1 py-0.5 rounded">MUSIC_GEN_CALLBACK_URL</code> (a Suno-compatible
                provider, e.g. kie.ai) in the backend environment to enable this page.
              </span>
            </div>
          )}

          <div className="space-y-3 mb-8">
            <div className="flex items-center justify-end gap-5">
              <Toggle
                checked={instrumental}
                onChange={setInstrumental}
                disabled={enabled === false}
                label="Instrumental (no vocals)"
              />
              <Toggle
                checked={customMode}
                onChange={setCustomMode}
                disabled={enabled === false}
                label="Custom mode"
              />
            </div>

            {customMode && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title (e.g. Night Drive)"
                  disabled={enabled === false}
                  maxLength={80}
                  className="w-full bg-visiyon-text/[0.04] rounded-xl px-4 py-2.5 text-[14px] outline-none focus:bg-visiyon-text/[0.07] text-visiyon-text placeholder-visiyon-text-3/40 transition-colors disabled:opacity-50"
                />
                <input
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  placeholder="Style / genre (e.g. synthwave, upbeat, 120bpm)"
                  disabled={enabled === false}
                  maxLength={200}
                  className="w-full bg-visiyon-text/[0.04] rounded-xl px-4 py-2.5 text-[14px] outline-none focus:bg-visiyon-text/[0.07] text-visiyon-text placeholder-visiyon-text-3/40 transition-colors disabled:opacity-50"
                />
              </div>
            )}

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  generate();
                }
              }}
              rows={3}
              maxLength={2000}
              placeholder={
                customMode
                  ? "Lyrics (or leave blank and enable Instrumental above)"
                  : "e.g. Upbeat synthwave track about driving at night, energetic, 120 bpm"
              }
              disabled={enabled === false}
              className="w-full bg-visiyon-text/[0.04] rounded-xl px-4 py-3 text-[14px] outline-none focus:bg-visiyon-text/[0.07] resize-none text-visiyon-text placeholder-visiyon-text-3/40 transition-colors disabled:opacity-50"
            />
            <div className="flex items-center justify-between">
              <span className={`text-[11.5px] tabular-nums ${prompt.length >= 2000 ? "text-red-400" : "text-visiyon-text-3"}`}>
                {prompt.length}/2000
              </span>
              {(() => {
                // In custom mode, blank lyrics are only valid when
                // Instrumental is also on (the textarea's own placeholder
                // says as much: "leave blank and enable Instrumental
                // above"). Outside custom mode, prompt is the free-form
                // description and is always required. Previously this
                // only checked `!prompt.trim()`, so the button stayed
                // disabled (no pointer cursor, greyed out) even in the
                // one case where blank lyrics are supposed to be fine.
                const promptRequired = !(customMode && instrumental);
                const isDisabled = (promptRequired && !prompt.trim()) || busy || enabled === false;
                return (
                  <button
                    onClick={generate}
                    disabled={isDisabled}
                    className="flex items-center gap-1.5 text-[13.5px] font-medium px-4 py-2 rounded-xl bg-visiyon-accent text-visiyon-bg hover:opacity-85 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Music size={14} />}
                    Generate
                  </button>
                );
              })()}
            </div>
          </div>

          <div className="space-y-4">
            {generations.length === 0 && enabled !== false && (
              <p className="text-[13px] text-visiyon-text-3 text-center py-8">
                Your generated tracks will show up here.
              </p>
            )}
            {generations.map((g) => (
              <div key={g.id} className="rounded-xl bg-visiyon-text/[0.04] p-4">
                <p className="text-[13px] text-visiyon-text-2 mb-2.5 line-clamp-2">{g.prompt || "(Instrumental — no lyrics)"}</p>
                {g.status === "pending" && (
                  <div className="flex items-center gap-2 text-[12.5px] text-visiyon-text-3">
                    <Loader2 size={13} className="animate-spin" /> Generating… this can take a minute or two.
                  </div>
                )}
                {g.status === "failed" && (
                  <div className="flex items-center gap-2 text-[12.5px] text-red-400">
                    <AlertTriangle size={13} /> {g.error || "Generation failed."}
                  </div>
                )}
                {g.status === "complete" && g.tracks && g.tracks.length > 0 && (
                  <div className="flex flex-col gap-2.5">
                    {g.tracks.map((t) => {
                      const isActive = player.track?.id === t.id;
                      const isPlaying = isActive && player.playing;
                      const dur = isActive && player.duration > 0 ? player.duration : t.durationSeconds || 0;
                      const cur = isActive ? player.currentTime : 0;
                      const meta = [g.style, g.instrumental ? "Instrumental" : null].filter(Boolean).join(", ");
                      return (
                        <div key={t.id} className="flex items-center gap-3.5 rounded-2xl bg-visiyon-text/[0.04] p-3.5">
                          {/* 48x48 thumbnail — click toggles play, same as music-backend's track-thumb-wrap */}
                          <button
                            onClick={() => togglePlay(t)}
                            className="group relative h-12 w-12 rounded-lg overflow-hidden shrink-0 bg-visiyon-text/10"
                            title={isPlaying ? "Pause" : "Play"}
                          >
                            {t.coverUrl ? (
                              <img src={t.coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                            ) : (
                              <span className="absolute inset-0 flex items-center justify-center">
                                <Music size={16} className="text-visiyon-text-2" />
                              </span>
                            )}
                            <span
                              className={`absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity ${
                                isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                              }`}
                            >
                              {isPlaying ? (
                                <Pause size={18} className="text-white" />
                              ) : (
                                <Play size={18} className="text-white ml-0.5" />
                              )}
                            </span>
                          </button>

                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] font-semibold text-visiyon-text truncate">{t.title}</p>
                            {meta && (
                              <p className="text-[12.5px] text-visiyon-text-3 truncate">{meta}</p>
                            )}
                            {/* Flat seek bar with inline time labels — mirrors music-backend's flat-seek-wrap */}
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10.5px] text-visiyon-text-3 shrink-0 w-7">{fmt(cur)}</span>
                              <input
                                type="range"
                                min={0}
                                max={dur || 100}
                                step={0.1}
                                value={cur}
                                disabled={!isActive || dur <= 0}
                                onChange={(e) => player.seek(parseFloat(e.target.value))}
                                className="flex-1 h-[3px] cursor-pointer appearance-none rounded-full bg-visiyon-text/15 accent-visiyon-accent disabled:cursor-default [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-visiyon-text"
                                style={{
                                  background: `linear-gradient(to right, var(--visiyon-text, #fff) ${dur > 0 ? (cur / dur) * 100 : 0}%, rgba(255,255,255,0.15) ${dur > 0 ? (cur / dur) * 100 : 0}%)`,
                                }}
                                aria-label={`Seek ${t.title}`}
                              />
                              <span className="text-[10.5px] text-visiyon-text-3 shrink-0 w-7 text-right">{fmt(dur)}</span>
                            </div>
                          </div>

                          <button
                            onClick={() => download(t)}
                            className="flex items-center justify-center h-8 w-8 rounded-full text-visiyon-text-3 hover:text-visiyon-text transition-colors shrink-0"
                            title="Download"
                          >
                            <Download size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
