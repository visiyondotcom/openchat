"use client";

// Photorealistic AI-face avatar. Renders the reference photo (full-bleed,
// object-fit: cover) with real-time reactive CSS effects layered on top —
// glow that brightens with audio level, a scanline sweep,
// brightness/scale pulse while speaking or generating, a subtle
// gaze-driven pan/tilt, a blinking-eyes overlay, and an audio-reactive
// mouth overlay that approximates lip movement.
import { useEffect, useMemo, useRef, type RefObject } from "react";

export type AvatarExpression = "neutral" | "smile";
export type AvatarTrigger = { type: "nod" | "shake" | "wink"; nonce: number };

const FACE_IMAGE_SRC = "/avatar/ai-face.png";
// Show the whole reference photo — no cropping. The image is letterboxed
// (object-fit: contain) inside the square avatar box instead of being
// zoomed/cropped to fill it, so nothing is cut off.
const FACE_OBJECT_POSITION = "50% 50%";
const FACE_BASE_SCALE = 1.0;
// Native photo is 1536x1024 (3:2 landscape). Used to work out where the
// mouth sits once the image is letterboxed inside a square box, so the
// lip-sync overlay lines up with the actual mouth in the photo.
const FACE_IMAGE_ASPECT = 1536 / 1024;
// Mouth center as a fraction of the *photo itself* (measured on the
// source image): ~50% across, ~70% down.
const MOUTH_X_IN_IMAGE = 0.5;
const MOUTH_Y_IN_IMAGE = 0.7;
const MOUTH_WIDTH_IN_IMAGE = 0.075;
// Eye centers, measured the same way (cropped + grid-overlaid the actual
// photo to read off coordinates) — ~36.5% down, symmetric left/right of
// center at ~39.5%/60.5% across.
const EYE_Y_IN_IMAGE = 0.365;
const EYE_L_X_IN_IMAGE = 0.395;
const EYE_R_X_IN_IMAGE = 0.605;
const EYE_WIDTH_IN_IMAGE = 0.042;

type FloatingParticle = {
  x: number;
  y: number;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
};

function buildParticles(count: number): FloatingParticle[] {
  return Array.from({ length: count }, () => ({
    x: 8 + Math.random() * 84,
    y: 15 + Math.random() * 75,
    size: 1.5 + Math.random() * 3,
    duration: 4 + Math.random() * 5,
    delay: -Math.random() * 8,
    opacity: 0.35 + Math.random() * 0.5,
  }));
}

// ---- Small prompt-bar icon --------------------------------------------
// At icon sizes (<32px) a photo has no legible detail, so this stays a
// crisp brain+circuit "AI head" line glyph, matching the rest of the
// prompt-bar icon set via currentColor. A thin ring pulses while the
// model is speaking/generating.
function AIFaceIcon({ size, active, className }: { size: number; active: boolean; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={active ? "AI avatar, active" : "AI avatar"}
    >
      {active && (
        <circle cx="12" cy="12.3" r="10.4" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.35">
          <animate attributeName="r" values="9.6;10.7;9.6" dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0.1;0.5" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}
      <path
        d="M9.4 2.6c-3.55 0-6.05 2.75-6.05 6.15 0 1.7.55 2.95.55 4.35 0 1.05-.5 1.55-1.15 1.95-.35.2-.35.75.05.9.85.3 1.7.3 1.7.3s-.1.85.35 1.15c.4.25 1.1.1 1.1.1s.05.9 1.05.9c.75 0 1.55-.55 2.35-1.55.65-.8 1.1-1.85 1.85-2.7.55-.6 1.35-1 1.9-1.65.85-1 1.35-2.35 1.35-3.75 0-3.4-2.5-6.15-5.05-6.15Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M6.1 5.9c.55-.9 1.55-1.4 1.55-1.4M5.1 7.7c.2-.55.55-1 .55-1M5.3 9.7c-.35-.25-.55-.75-.5-1.2M6.9 11.2c-.6 0-1.15-.45-1.25-1M8.35 6.35c-.5.2-.9.6-1.05 1.05M8.9 8.5c-.55.05-1.05-.15-1.35-.55"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.65"
        strokeLinecap="round"
      />
      <path
        d="M9.9 3.9v3M12 3.4v4.5M9.9 12.4v2.7M12 12.9v3.1M14.4 8.1h1.6l1-1M14.6 10.5h2l1.15 1.15M9.5 10.3l-1.15 1.15h-1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.9" cy="3.9" r="0.55" fill="currentColor" />
      <circle cx="16.5" cy="7.1" r="0.55" fill="currentColor" />
      <circle cx="17.6" cy="11.65" r="0.55" fill="currentColor" />
      <circle cx="6.75" cy="11.45" r="0.55" fill="currentColor" />
      <rect x="10.3" y="9" width="3.4" height="2.6" rx="0.3" fill="none" stroke="currentColor" strokeWidth="0.7" />
    </svg>
  );
}

export function AIFaceAvatar({
  audioRef,
  isSpeaking,
  isGenerating = false,
  gazeX = 0,
  gazeY = 0,
  expression = "neutral",
  trigger,
  size = 96,
  className = "",
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  isSpeaking: boolean;
  isGenerating?: boolean;
  gazeX?: number;
  gazeY?: number;
  expression?: AvatarExpression;
  trigger?: AvatarTrigger;
  size?: number;
  className?: string;
}) {
  void expression; // a static photo can't reshape into a smile — kept in
  // the prop signature so callers (ChatWindow) don't need to change.

  const particles = useMemo(() => buildParticles(size >= 200 ? 34 : 18), [size >= 200]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const scanRef = useRef<HTMLDivElement | null>(null);
  const mouthRef = useRef<HTMLDivElement | null>(null);
  const eyeLRef = useRef<HTMLDivElement | null>(null);
  const eyeRRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // Base screen position of the mouth/eyes as a % of the wrapper box,
  // recomputed whenever the wrapper resizes. Needed because the wrapper
  // now fills whatever space the parent gives it instead of always
  // matching the photo's own 3:2 ratio — so object-fit: cover crops the
  // photo by a different amount depending on the container's shape, and
  // the fixed MOUTH_*_IN_IMAGE / EYE_*_IN_IMAGE fractions alone no longer
  // land on the actual mouth/eyes once that crop isn't 1:1 with the
  // source image.
  const coverBaseRef = useRef({
    mouth: { x: MOUTH_X_IN_IMAGE * 100, y: MOUTH_Y_IN_IMAGE * 100 },
    eyeL: { x: EYE_L_X_IN_IMAGE * 100, y: EYE_Y_IN_IMAGE * 100 },
    eyeR: { x: EYE_R_X_IN_IMAGE * 100, y: EYE_Y_IN_IMAGE * 100 },
  });

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const wiredElementRef = useRef<HTMLAudioElement | null>(null);
  const levelRef = useRef(0);

  const gazeTargetRef = useRef({ x: gazeX, y: gazeY });
  gazeTargetRef.current = { x: gazeX, y: gazeY };
  const gazeSmoothRef = useRef({ x: 0, y: 0 });

  const isSpeakingRef = useRef(isSpeaking);
  isSpeakingRef.current = isSpeaking;
  const isGeneratingRef = useRef(isGenerating);
  isGeneratingRef.current = isGenerating;

  function ensureWired() {
    const el = audioRef.current;
    if (!el || wiredElementRef.current === el) return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = audioCtxRef.current ?? new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      sourceRef.current = source;
      wiredElementRef.current = el;
    } catch {
      // No Web Audio support, or element already wired — falls back to a
      // synthetic idle pulse below.
    }
  }

  // Gesture triggers — brief transform pulses layered on top of the
  // continuous rAF-driven idle animation. A literal one-eye "wink" isn't
  // possible on a flat photo, so it's approximated as a quick blink-like
  // brightness dip instead of pretending to animate just one eye.
  useEffect(() => {
    if (!trigger) return;
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (trigger.type === "nod" && wrap) {
      wrap.animate(
        [{ transform: "translateY(0px)" }, { transform: "translateY(8px)" }, { transform: "translateY(0px)" }],
        { duration: 480, easing: "ease-in-out" }
      );
    } else if (trigger.type === "shake" && wrap) {
      wrap.animate(
        [
          { transform: "rotate(0deg)" },
          { transform: "rotate(-4deg)" },
          { transform: "rotate(4deg)" },
          { transform: "rotate(0deg)" },
        ],
        { duration: 480, easing: "ease-in-out" }
      );
    } else if (trigger.type === "wink" && img) {
      img.animate([{ filter: "brightness(1)" }, { filter: "brightness(0.35)" }, { filter: "brightness(1)" }], {
        duration: 220,
        easing: "ease-in-out",
      });
    }
  }, [trigger?.nonce]);

  // Natural blinking — both eyes together, on a randomized interval
  // (roughly every 2.5-6s, like a real person) rather than a fixed CSS
  // loop, so it doesn't look like a metronome. Runs continuously whether
  // idle, speaking, or generating.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function scheduleBlink() {
      const delay = 2500 + Math.random() * 3500;
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        const closeOpen: Keyframe[] = [
          { transform: "translate(-50%, -50%) scaleY(1)", opacity: 1 },
          { transform: "translate(-50%, -50%) scaleY(0.05)", opacity: 1 },
          { transform: "translate(-50%, -50%) scaleY(1)", opacity: 1 },
        ];
        const opts: KeyframeAnimationOptions = { duration: 180, easing: "ease-in-out" };
        eyeLRef.current?.animate(closeOpen, opts);
        eyeRRef.current?.animate(closeOpen, opts);
        scheduleBlink();
      }, delay);
    }
    scheduleBlink();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  // Recompute where the mouth/eyes actually land once the photo is
  // cropped by object-fit: cover to fill this container. Standard cover
  // math: the image is scaled up until it fully covers the box on
  // whichever axis needs it least, then centered and the overflow on the
  // other axis is what gets cropped off both edges.
  useEffect(() => {
    function recompute() {
      const el = wrapRef.current;
      if (!el) return;
      const containerW = el.clientWidth;
      const containerH = el.clientHeight;
      if (!containerW || !containerH) return;
      // Work in the image's own unit square (width = its aspect ratio,
      // height = 1) — only the ratio between the two axes matters here.
      const imgW = FACE_IMAGE_ASPECT;
      const imgH = 1;
      const scale = Math.max(containerW / imgW, containerH / imgH);
      const dispW = imgW * scale;
      const dispH = imgH * scale;
      const offsetX = (dispW - containerW) / 2;
      const offsetY = (dispH - containerH) / 2;
      const toPct = (fx: number, fy: number) => ({
        x: ((fx * dispW - offsetX) / containerW) * 100,
        y: ((fy * dispH - offsetY) / containerH) * 100,
      });
      coverBaseRef.current = {
        mouth: toPct(MOUTH_X_IN_IMAGE, MOUTH_Y_IN_IMAGE),
        eyeL: toPct(EYE_L_X_IN_IMAGE, EYE_Y_IN_IMAGE),
        eyeR: toPct(EYE_R_X_IN_IMAGE, EYE_Y_IN_IMAGE),
      };
      // Mouth position itself isn't touched every rAF tick (only its
      // transform is), so apply the corrected base position right away.
      if (mouthRef.current) {
        mouthRef.current.style.left = `${coverBaseRef.current.mouth.x}%`;
        mouthRef.current.style.top = `${coverBaseRef.current.mouth.y}%`;
      }
    }
    recompute();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const startTime = performance.now();

    function tick(t: number) {
      ensureWired();
      const analyser = analyserRef.current;
      let audioLevel = 0;
      if (isSpeakingRef.current && analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        audioLevel = Math.min(1, Math.sqrt(sumSquares / data.length) * 4.5);
      } else if (isSpeakingRef.current) {
        audioLevel = 0.3 + 0.25 * Math.abs(Math.sin(t / 160));
      }
      const genLevel = isGeneratingRef.current ? 0.3 + 0.2 * Math.abs(Math.sin(t / 260)) : 0;
      const level = Math.max(audioLevel, genLevel);
      levelRef.current += (level - levelRef.current) * 0.15;

      const gt = gazeTargetRef.current;
      const gs = gazeSmoothRef.current;
      gs.x += (gt.x - gs.x) * 0.05;
      gs.y += (gt.y - gs.y) * 0.05;

      const elapsed = (t - startTime) / 1000;
      const breathe = Math.sin(elapsed * 0.5) * 0.028 + Math.sin(elapsed * 0.23) * 0.012;
      const talk = levelRef.current;

      const scale = FACE_BASE_SCALE * (1 + breathe + talk * 0.015);
      const panX = gs.x * 3.5 + Math.sin(elapsed * 0.31) * 2.2;
      const panY = gs.y * 2.5 + Math.sin(elapsed * 0.24 + 1.1) * 1.4;
      if (stageRef.current) {
        // Full image + mouth overlay move together, so the lip-sync stays
        // glued to the mouth through the idle pan/breathe motion.
        stageRef.current.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
      }
      if (imgRef.current) {
        imgRef.current.style.filter = `brightness(${1 + talk * 0.28}) contrast(${1.05 + talk * 0.1}) saturate(1.15)`;
      }
      if (mouthRef.current) {
        // Simple audio-reactive "mouth open" pseudo lip-sync: a talking
        // mouth doesn't just get taller, it also narrows slightly and
        // has a bit of jitter so it doesn't look like a metronome.
        const jitter = isSpeakingRef.current ? Math.sin(t / 55) * 0.12 + Math.sin(t / 97) * 0.08 : 0;
        const openness = Math.max(0, talk + jitter * talk);
        const heightScale = 1 + openness * 7.5;
        const widthScale = 1 - openness * 0.16;
        mouthRef.current.style.transform = `translate(-50%, -50%) scaleY(${heightScale}) scaleX(${widthScale})`;
        mouthRef.current.style.opacity = String(Math.min(0.85, openness * 1.8));
      }
      // Eyes track the same smoothed gaze target as the photo pan, plus a
      // slower independent micro-drift so they don't look perfectly
      // locked to the head tilt — small, sub-pixel-scale shifts, since
      // real eyes move far less than a head turn.
      const eyeShiftX = gs.x * 1.1 + Math.sin(elapsed * 0.17) * 0.35;
      const eyeShiftY = gs.y * 0.9 + Math.sin(elapsed * 0.13 + 0.6) * 0.25;
      const { eyeL, eyeR } = coverBaseRef.current;
      if (eyeLRef.current) {
        eyeLRef.current.style.left = `${(eyeL.x + eyeShiftX).toFixed(3)}%`;
        eyeLRef.current.style.top = `${(eyeL.y + eyeShiftY).toFixed(3)}%`;
      }
      if (eyeRRef.current) {
        eyeRRef.current.style.left = `${(eyeR.x + eyeShiftX).toFixed(3)}%`;
        eyeRRef.current.style.top = `${(eyeR.y + eyeShiftY).toFixed(3)}%`;
      }
      if (wrapRef.current) {
        wrapRef.current.style.setProperty("--tilt", `${gs.x * 2}deg`);
      }
      if (glowRef.current) {
        const spread = 14 + talk * 34;
        const alpha = 0.35 + talk * 0.45;
        glowRef.current.style.boxShadow = `0 0 ${spread}px ${spread * 0.6}px rgba(125,211,252,${alpha})`;
        glowRef.current.style.opacity = String(0.55 + talk * 0.45);
      }
      if (scanRef.current) {
        const pos = ((elapsed * 40) % 130) - 15;
        scanRef.current.style.transform = `translateY(${pos}%)`;
        scanRef.current.style.opacity = String(0.12 + talk * 0.18);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
    };
  }, []);

  if (size < 32) {
    return <AIFaceIcon size={size} active={isSpeaking || isGenerating} className={className} />;
  }

  // Fill the entire space the parent gives this component — no fixed
  // aspect-ratio box, no letterboxing. The parent (the panel to the right
  // of the chat) controls the actual footprint; this element just stretches
  // to 100%/100% of it. The photo itself is object-fit: cover inside that
  // box, so it always fills edge-to-edge with no black bars — the tradeoff
  // being that a container whose ratio doesn't match the photo's 3:2 will
  // crop some of the image rather than show bars. `size` still only
  // matters as the small-icon threshold below.
  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        borderRadius: 24,
        overflow: "hidden",
        transform: "rotate(var(--tilt, 0deg))",
        background: "transparent",
      }}
      className={className}
      role="img"
      aria-label={isSpeaking ? "AI avatar, speaking" : isGenerating ? "AI avatar, thinking" : "AI avatar, idle"}
    >
      {/* Ambient cyan glow behind/around the face, pulses with audio level */}
      <div
        ref={glowRef}
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 24,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* Stage holds the full photo + mouth overlay together, so the idle
          pan/breathe transform moves them as one unit and the mouth stays
          glued to the lips instead of drifting off.

          The wrapper fills whatever space the parent gives it (see the
          ResizeObserver-driven cover-crop correction above), and
          object-fit: cover fills that box edge-to-edge with no crop
          artifacts or letterboxing beyond the crop cover itself implies. */}
      <div
        ref={stageRef}
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "center",
          zIndex: 1,
          overflow: "hidden",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={FACE_IMAGE_SRC}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: FACE_OBJECT_POSITION,
            transform: `scale(${FACE_BASE_SCALE})`,
            filter: "brightness(1) contrast(1.05) saturate(1.15)",
          }}
        />

        {/* Audio-reactive mouth overlay — a soft dark ellipse positioned
            over the photo's actual mouth (position corrected for the
            container's object-fit: cover crop — see coverBaseRef above).
            Stretches open with the live audio level, giving the static
            photo a simple, always-on lip-sync effect while it talks. */}
        <div
          ref={mouthRef}
          style={{
            position: "absolute",
            left: `${MOUTH_X_IN_IMAGE * 100}%`,
            top: `${MOUTH_Y_IN_IMAGE * 100}%`,
            width: `${MOUTH_WIDTH_IN_IMAGE * 100}%`,
            height: "1.6%",
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: "radial-gradient(closest-side, rgba(15,8,10,0.85), rgba(15,8,10,0.35) 70%, transparent 100%)",
            mixBlendMode: "multiply",
            transformOrigin: "center",
            pointerEvents: "none",
          }}
        />

        {/* Eyes — small dark ellipses over the photo's actual eyes,
            positioned/animated from the rAF loop (gaze micro-drift) and
            the blink loop above (periodic quick close). Base position is
            corrected for the container's object-fit: cover crop (see the
            ResizeObserver effect that fills coverBaseRef), so they stay
            on the real eyes regardless of the wrapper's aspect ratio. */}
        <div
          ref={eyeLRef}
          style={{
            position: "absolute",
            left: `${EYE_L_X_IN_IMAGE * 100}%`,
            top: `${EYE_Y_IN_IMAGE * 100}%`,
            width: `${EYE_WIDTH_IN_IMAGE * 100}%`,
            height: `${(EYE_WIDTH_IN_IMAGE * FACE_IMAGE_ASPECT * 0.55).toFixed(3)}%`,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: "radial-gradient(closest-side, rgba(10,6,8,0.7), transparent 100%)",
            mixBlendMode: "multiply",
            pointerEvents: "none",
          }}
        />
        <div
          ref={eyeRRef}
          style={{
            position: "absolute",
            left: `${EYE_R_X_IN_IMAGE * 100}%`,
            top: `${EYE_Y_IN_IMAGE * 100}%`,
            width: `${EYE_WIDTH_IN_IMAGE * 100}%`,
            height: `${(EYE_WIDTH_IN_IMAGE * FACE_IMAGE_ASPECT * 0.55).toFixed(3)}%`,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: "radial-gradient(closest-side, rgba(10,6,8,0.7), transparent 100%)",
            mixBlendMode: "multiply",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* Subtle moving scan-line sweep for the hologram feel */}
      <div
        ref={scanRef}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: "40%",
          top: 0,
          background: "linear-gradient(180deg, transparent, rgba(125,211,252,0.5), transparent)",
          zIndex: 2,
          pointerEvents: "none",
          opacity: 0.12,
        }}
      />

      {/* Floating dust particles — always animating, independent of audio,
          so the avatar visibly moves even when idle. */}
      {particles.map((p, i) => (
        <span
          key={i}
          className="visiyon-avatar-particle"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            zIndex: 3,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
            ["--particle-opacity" as string]: p.opacity,
            boxShadow: `0 0 ${p.size * 2}px rgba(125,211,252,0.9)`,
          }}
        />
      ))}

      {/* Grid overlay removed per user request — was causing visible grid lines over the avatar */}
    </div>
  );
}


export type AvatarDirectives = {
  gaze?: { x: number; y: number };
  expression?: AvatarExpression;
  gesture?: "nod" | "shake" | "wink";
};

const GAZE_PATTERNS: { re: RegExp; x: number; y: number }[] = [
  { re: /\b(kijk(t)?\s*(naar\s*)?links|look(s)?\s*left)\b/i, x: -1, y: 0 },
  { re: /\b(kijk(t)?\s*(naar\s*)?rechts|look(s)?\s*right)\b/i, x: 1, y: 0 },
  { re: /\b(kijk(t)?\s*(naar\s*)?(boven|omhoog)|look(s)?\s*up)\b/i, x: 0, y: -1 },
  { re: /\b(kijk(t)?\s*(naar\s*)?(beneden|omlaag)|look(s)?\s*down)\b/i, x: 0, y: 1 },
  { re: /\b(kijk(t)?\s*(recht\s*vooruit|voor\s*zich)|look(s)?\s*(straight|forward|center|ahead))\b/i, x: 0, y: 0 },
];

const EXPRESSION_PATTERNS: { re: RegExp; expression: AvatarExpression }[] = [
  { re: /\b(glimlach(t)?|lach(t)?|smile(s)?)\b/i, expression: "smile" },
  { re: /\b(serieus|ernstig|neutraal|neutral\s*face)\b/i, expression: "neutral" },
];

const GESTURE_PATTERNS: { re: RegExp; gesture: "nod" | "shake" | "wink" }[] = [
  { re: /\b(knik(t)?|nod(s)?)\b/i, gesture: "nod" },
  { re: /\b(schud(t)?\s*(met\s*)?(je\s*|zijn\s*)?hoofd|shake(s)?\s*(his|your|the)?\s*head)\b/i, gesture: "shake" },
  { re: /\b(knipoog(t)?|wink(s)?)\b/i, gesture: "wink" },
];

export function parseAvatarDirectives(text: string): AvatarDirectives {
  const result: AvatarDirectives = {};
  for (const p of GAZE_PATTERNS) {
    if (p.re.test(text)) {
      result.gaze = { x: p.x, y: p.y };
      break;
    }
  }
  for (const p of EXPRESSION_PATTERNS) {
    if (p.re.test(text)) {
      result.expression = p.expression;
      break;
    }
  }
  for (const p of GESTURE_PATTERNS) {
    if (p.re.test(text)) {
      result.gesture = p.gesture;
      break;
    }
  }
  return result;
}
