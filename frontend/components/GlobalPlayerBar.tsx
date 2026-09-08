"use client";

import { useEffect, useRef, useState } from "react";
import { useMusicPlayer } from "@/lib/musicPlayer";
import { Play, Pause, SkipBack, SkipForward, X, Music, AlertTriangle, GripHorizontal } from "lucide-react";

function fmt(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const POS_KEY = "visiyon_player_pos";

function clamp(x: number, y: number, w: number, h: number) {
  if (typeof window === "undefined") return { x, y };
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

export default function GlobalPlayerBar() {
  const { track, queue, index, playing, currentTime, duration, error, toggle, seek, next, prev, close } = useMusicPlayer();
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  // Free-floating position — draggable anywhere on screen instead of a
  // fixed bottom bar (which used to sit on top of the chat input). Persisted
  // per-browser so it stays where the user left it between chats/reloads.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Measured from the actual rendered widget (responsive width on small
  // screens — see the className below) rather than a hardcoded size, so
  // clamping to the viewport is accurate on phones too.
  const widgetRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 320, h: 84 });

  const measure = () => {
    if (widgetRef.current) {
      const r = widgetRef.current.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
    }
    return sizeRef.current;
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Default width guess before first paint — real size is measured and
    // re-clamped right after mount via the effect below.
    const fallbackW = Math.min(320, window.innerWidth - 24);
    const stored = localStorage.getItem(POS_KEY);
    let initial: { x: number; y: number };
    try {
      const parsed = stored ? JSON.parse(stored) : null;
      initial = parsed && typeof parsed.x === "number" && typeof parsed.y === "number" ? parsed : {
        x: window.innerWidth - fallbackW - 16,
        y: window.innerHeight - 84 - 16,
      };
    } catch {
      initial = { x: window.innerWidth - fallbackW - 16, y: window.innerHeight - 84 - 16 };
    }
    setPos(clamp(initial.x, initial.y, fallbackW, 84));
  }, []);

  // Re-clamp against the real measured size once the widget has rendered
  // (and whenever the track changes, since content width can shift).
  useEffect(() => {
    if (!pos) return;
    const { w, h } = measure();
    const next = clamp(pos.x, pos.y, w, h);
    if (next.x !== pos.x || next.y !== pos.y) setPos(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  useEffect(() => {
    const onMove = (clientX: number, clientY: number) => {
      if (!dragRef.current) return;
      const { startX, startY, origX, origY } = dragRef.current;
      const { w, h } = sizeRef.current;
      const next = clamp(origX + (clientX - startX), origY + (clientY - startY), w, h);
      setPos(next);
    };
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (!dragRef.current) return;
      e.preventDefault(); // stop the page from scrolling while dragging
      if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
    };
    const stopDrag = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(false);
        setPos((p) => {
          if (p && typeof window !== "undefined") localStorage.setItem(POS_KEY, JSON.stringify(p));
          return p;
        });
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopDrag);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", stopDrag);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopDrag);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", stopDrag);
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      const { w, h } = measure();
      setPos((p) => (p ? clamp(p.x, p.y, w, h) : p));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = (clientX: number, clientY: number) => {
    if (!pos) return;
    measure();
    dragRef.current = { startX: clientX, startY: clientY, origX: pos.x, origY: pos.y };
    setDragging(true);
  };

  if (!track || !pos) return null;

  const shownTime = scrubTime ?? currentTime;
  const pct = duration > 0 ? Math.min(100, (shownTime / duration) * 100) : 0;

  return (
    <div
      ref={widgetRef}
      className={`fixed z-40 w-[min(320px,calc(100vw-24px))] rounded-2xl border border-visiyon-text/10 bg-visiyon-bg/95 backdrop-blur-md shadow-2xl select-none ${
        dragging ? "cursor-grabbing" : ""
      }`}
      style={{ left: pos.x, top: pos.y }}
    >
      {/* Drag handle — grab anywhere on this row to move the player.
          A bit taller on touch devices so it's easy to grab with a
          finger, not just a mouse pointer. */}
      <div
        className="flex items-center justify-center gap-1 py-2.5 sm:pt-1.5 sm:pb-0.5 cursor-grab active:cursor-grabbing text-visiyon-text-3 touch-none"
        onMouseDown={(e) => {
          e.preventDefault();
          startDrag(e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if (e.touches[0]) startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }}
      >
        <GripHorizontal size={16} />
      </div>

      {error && (
        <div className="flex items-center gap-1.5 px-4 py-1 text-[11.5px] text-red-400">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {/* Seek bar */}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={shownTime}
        onChange={(e) => setScrubTime(parseFloat(e.target.value))}
        onMouseUp={(e) => {
          seek(parseFloat((e.target as HTMLInputElement).value));
          setScrubTime(null);
        }}
        onTouchEnd={(e) => {
          seek(parseFloat((e.target as HTMLInputElement).value));
          setScrubTime(null);
        }}
        className="w-full h-1 accent-visiyon-accent cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-visiyon-text/10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-visiyon-accent [&::-webkit-slider-thumb]:-mt-1"
        style={{
          background: `linear-gradient(to right, var(--visiyon-accent, #fff) ${pct}%, rgba(255,255,255,0.1) ${pct}%)`,
        }}
        aria-label="Seek"
      />

      <div className="flex items-center gap-3 px-4 py-1.5">
        <div className="h-7 w-7 rounded-lg overflow-hidden shrink-0 bg-visiyon-text/10 flex items-center justify-center">
          {track.coverUrl ? (
            <img src={track.coverUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Music size={12} className="text-visiyon-text-2" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-visiyon-text truncate leading-tight">{track.title}</p>
          <p className="text-[10.5px] text-visiyon-text-3 tabular-nums leading-tight">
            {fmt(shownTime)} / {fmt(duration)}
            {queue.length > 1 && (
              <span>
                {" "}
                · Track {index + 1}/{queue.length}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={prev}
            disabled={index <= 0}
            className="flex items-center justify-center h-7 w-7 rounded-full text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Previous track"
          >
            <SkipBack size={13} />
          </button>
          <button
            onClick={toggle}
            className="flex items-center justify-center h-7 w-7 rounded-full bg-visiyon-accent text-visiyon-bg hover:opacity-85 transition-opacity"
            title={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
          </button>
          <button
            onClick={next}
            disabled={index >= queue.length - 1}
            className="flex items-center justify-center h-7 w-7 rounded-full text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next track"
          >
            <SkipForward size={13} />
          </button>
          <button
            onClick={close}
            className="flex items-center justify-center h-7 w-7 rounded-full text-visiyon-text-3 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors ml-1"
            title="Close player"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
