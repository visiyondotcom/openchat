"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// A track shape the player understands. Both the generator page's
// MusicTrack and the library's LibraryTrack satisfy this.
export interface PlayerTrack {
  id: string;
  title: string;
  audioUrl: string;
  coverUrl?: string;
  durationSeconds?: number;
}

interface MusicPlayerState {
  queue: PlayerTrack[];
  index: number;
  track: PlayerTrack | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
  // Start playing `queue` at `startIndex`. Passing the same track that's
  // already loaded just toggles play/pause instead of restarting it.
  playQueue: (queue: PlayerTrack[], startIndex: number) => void;
  toggle: () => void;
  seek: (time: number) => void;
  next: () => void;
  prev: () => void;
  close: () => void;
}

const MusicPlayerContext = createContext<MusicPlayerState | null>(null);

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Which track id is actually loaded into the <audio> element, so that
  // toggling play/pause on the same track doesn't reset it back to 0.
  const loadedIdRef = useRef<string | null>(null);
  // Always-current queue/index for use inside the onended handler, which
  // closes over stale state otherwise.
  const queueRef = useRef(queue);
  const indexRef = useRef(index);
  queueRef.current = queue;
  indexRef.current = index;

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration || 0);
    const onEnded = () => {
      const q = queueRef.current;
      const i = indexRef.current;
      if (i < q.length - 1) {
        loadedIdRef.current = null;
        setIndex(i + 1);
      } else {
        setPlaying(false);
      }
    };
    const onError = () => {
      setError("Couldn't play this track — the audio file may be unavailable.");
      setPlaying(false);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
    };
  }, []);

  // Load whichever track `index` points at whenever it changes, then play
  // if we're supposed to be playing.
  useEffect(() => {
    const audio = audioRef.current;
    const track = queue[index];
    if (!audio || !track) return;

    if (loadedIdRef.current !== track.id) {
      loadedIdRef.current = track.id;
      setError(null);
      setCurrentTime(0);
      setDuration(track.durationSeconds || 0);
      audio.src = track.audioUrl;
    }

    if (playing) {
      audio.play().catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't play this track.");
        setPlaying(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, index]);

  // Play/pause without reloading the source.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !queue[index]) return;
    if (playing) {
      audio.play().catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't play this track.");
        setPlaying(false);
      });
    } else {
      audio.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const playQueue = useCallback(
    (newQueue: PlayerTrack[], startIndex: number) => {
      const target = newQueue[startIndex];
      if (!target) return;
      const sameTrack = queueRef.current[indexRef.current]?.id === target.id;
      setQueue(newQueue);
      if (sameTrack) {
        setPlaying((p) => !p);
      } else {
        setIndex(startIndex);
        setError(null);
        setPlaying(true);
      }
    },
    []
  );

  const toggle = useCallback(() => {
    if (!queueRef.current[indexRef.current]) return;
    setPlaying((p) => !p);
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  const next = useCallback(() => {
    const q = queueRef.current;
    const i = indexRef.current;
    if (i < q.length - 1) {
      loadedIdRef.current = null;
      setIndex(i + 1);
      setPlaying(true);
    }
  }, []);

  const prev = useCallback(() => {
    const i = indexRef.current;
    if (i > 0) {
      loadedIdRef.current = null;
      setIndex(i - 1);
      setPlaying(true);
    }
  }, []);

  const close = useCallback(() => {
    audioRef.current?.pause();
    loadedIdRef.current = null;
    setQueue([]);
    setIndex(0);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  const track = queue[index] || null;

  return (
    <MusicPlayerContext.Provider
      value={{ queue, index, track, playing, currentTime, duration, error, playQueue, toggle, seek, next, prev, close }}
    >
      {children}
    </MusicPlayerContext.Provider>
  );
}

export function useMusicPlayer() {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) throw new Error("useMusicPlayer must be used within a MusicPlayerProvider");
  return ctx;
}
