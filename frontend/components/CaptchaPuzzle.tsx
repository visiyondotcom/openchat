"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { RefreshCw, Check } from "lucide-react";
import { getCaptchaChallenge, CaptchaChallenge } from "@/lib/api";

// Self-hosted "slide the piece into the notch" captcha — draws a small
// generative background pattern on a <canvas>, cuts a puzzle-piece-shaped
// notch out of it at a server-chosen x position, and asks the user to
// drag a floating copy of that piece back into the hole. No third-party
// script, no API key, nothing loaded over the network except our own
// /auth/captcha/challenge JSON.
//
// The visual is intentionally simple (a few soft shapes, not a photo) —
// what matters for anti-spam purposes is the drag interaction plus the
// server-side timing/tolerance checks in verifyCaptcha, not image
// complexity.

export interface CaptchaAnswer {
  token: string;
  x: number;
  elapsedMs: number;
}

function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  // Small deterministic-looking gradient + soft blobs so every reload
  // looks a little different without needing an image asset.
  const grad = ctx.createLinearGradient(0, 0, w, h);
  const hueA = (seed * 47) % 360;
  const hueB = (hueA + 55) % 360;
  grad.addColorStop(0, `hsl(${hueA} 45% 18%)`);
  grad.addColorStop(1, `hsl(${hueB} 40% 10%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 5; i++) {
    const bx = ((seed * (i + 3) * 37) % w);
    const by = ((seed * (i + 7) * 53) % h);
    const r = 24 + ((seed * (i + 1)) % 30);
    ctx.beginPath();
    ctx.fillStyle = `hsla(${(hueA + i * 40) % 360} 60% 60% / 0.10)`;
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Draws a jigsaw-style piece outline (square with one rounded knob on the
// right edge, one rounded socket on the bottom edge) as a reusable path.
function piecePath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const knob = size * 0.22;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size * 0.4, y);
  ctx.arc(x + size * 0.5, y - knob * 0.15, knob, Math.PI, 0, true);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size, y + size * 0.4);
  ctx.arc(x + size + knob * 0.15, y + size * 0.5, knob, Math.PI * 1.5, Math.PI * 0.5, false);
  ctx.lineTo(x + size, y + size);
  ctx.lineTo(x, y + size);
  ctx.closePath();
}

export default function CaptchaPuzzle({
  onSolved,
  onReset,
}: {
  onSolved: (answer: CaptchaAnswer) => void;
  onReset?: () => void;
}) {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const pieceCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [sliderX, setSliderX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [solved, setSolved] = useState(false);
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(true);
  const startTimeRef = useRef<number>(0);

  const load = useCallback(() => {
    setLoading(true);
    setSolved(false);
    setSliderX(0);
    getCaptchaChallenge()
      .then((c) => {
        setChallenge(c);
        startTimeRef.current = Date.now();
      })
      .catch(() => setChallenge(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Paint the background (with the notch cut out at targetX) and the
  // floating piece (the part that was cut out) whenever a challenge loads.
  useEffect(() => {
    if (!challenge) return;
    const bgCanvas = bgCanvasRef.current;
    const pieceCanvas = pieceCanvasRef.current;
    if (!bgCanvas || !pieceCanvas) return;
    const { width, height, pieceSize, targetX } = challenge;
    const pieceY = height / 2 - pieceSize / 2;
    const seed = challenge.issuedAt % 1000;

    bgCanvas.width = width;
    bgCanvas.height = height;
    const bgCtx = bgCanvas.getContext("2d")!;
    drawScene(bgCtx, width, height, seed);

    // Cut the notch: draw the scene again clipped to the piece path, then
    // punch a translucent hole into the main canvas so the target is
    // visible as a dim outline.
    bgCtx.save();
    bgCtx.globalCompositeOperation = "destination-out";
    bgCtx.globalAlpha = 0.85;
    piecePath(bgCtx, targetX, pieceY, pieceSize);
    bgCtx.fill();
    bgCtx.restore();
    bgCtx.save();
    bgCtx.strokeStyle = "rgba(255,255,255,0.55)";
    bgCtx.lineWidth = 1.5;
    piecePath(bgCtx, targetX, pieceY, pieceSize);
    bgCtx.stroke();
    bgCtx.restore();

    pieceCanvas.width = pieceSize + 6;
    pieceCanvas.height = pieceSize + 6;
    const pieceCtx = pieceCanvas.getContext("2d")!;
    pieceCtx.save();
    piecePath(pieceCtx, 3, 3, pieceSize);
    pieceCtx.clip();
    // Offset so the same scene content that was cut out of the
    // background reappears, pixel-for-pixel, inside the piece.
    pieceCtx.translate(3 - targetX, 3 - pieceY);
    drawScene(pieceCtx, width, height, seed);
    pieceCtx.restore();
    pieceCtx.save();
    pieceCtx.strokeStyle = "rgba(255,255,255,0.9)";
    pieceCtx.lineWidth = 1.5;
    piecePath(pieceCtx, 3, 3, pieceSize);
    pieceCtx.stroke();
    pieceCtx.restore();
  }, [challenge]);

  function handlePointerDown(e: React.PointerEvent) {
    if (solved || !challenge) return;
    // Without this, the browser's own touch-scroll/pan gesture competes
    // with the drag on phones: the page starts panning mid-swipe, the
    // pointer effectively leaves our capture, and the piece "slips away"
    // instead of following the finger. preventDefault + touch-action:
    // none (below) tells the browser this gesture belongs to us.
    e.preventDefault();
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging || !challenge || !trackRef.current) return;
    e.preventDefault();
    const rect = trackRef.current.getBoundingClientRect();
    const maxX = rect.width - 36; // slider handle width
    const raw = e.clientX - rect.left - 18;
    const clamped = Math.max(0, Math.min(maxX, raw));
    // Map slider-track position to the puzzle canvas's own coordinate
    // space so it lines up visually regardless of the track's CSS width.
    const scale = (challenge.width - challenge.pieceSize) / maxX;
    setSliderX(Math.round(clamped * scale));
  }

  function handlePointerUp() {
    if (!dragging || !challenge) return;
    setDragging(false);
    const elapsedMs = Date.now() - startTimeRef.current;
    const distance = Math.abs(sliderX - challenge.targetX);
    if (distance <= 8) {
      setSolved(true);
      onSolved({ token: challenge.token, x: sliderX, elapsedMs });
    } else {
      setShake(true);
      setTimeout(() => setShake(false), 400);
      onReset?.();
      load();
    }
  }

  const maxTrack = challenge ? challenge.width - challenge.pieceSize : 1;

  return (
    <div className="select-none">
      <div
        className="relative rounded-lg overflow-hidden border border-visiyon-border"
        style={{ width: challenge?.width ?? 300, height: challenge?.height ?? 150 }}
      >
        {loading ? (
          <div className="w-full h-full flex items-center justify-center text-visiyon-text-3 text-[12.5px]">
            Loading puzzle…
          </div>
        ) : (
          <>
            <canvas ref={bgCanvasRef} className="absolute inset-0 w-full h-full" />
            <canvas
              ref={pieceCanvasRef}
              className={`absolute pointer-events-none transition-transform ${shake ? "animate-shake" : ""}`}
              style={{
                top: challenge ? challenge.height / 2 - challenge.pieceSize / 2 - 3 : 0,
                left: sliderX - 3,
                filter: solved ? "drop-shadow(0 0 6px rgba(120,255,180,0.8))" : "drop-shadow(0 1px 3px rgba(0,0,0,0.5))",
              }}
            />
            {solved && (
              <div className="absolute top-2 right-2 bg-emerald-500/90 text-black rounded-full p-1">
                <Check size={12} strokeWidth={3} />
              </div>
            )}
            <button
              type="button"
              onClick={load}
              title="Get a new puzzle"
              className="absolute top-2 left-2 text-white/70 hover:text-visiyon-text bg-black/40 rounded-full p-1.5"
            >
              <RefreshCw size={12} />
            </button>
          </>
        )}
      </div>

      <div
        ref={trackRef}
        className={`relative mt-2.5 h-9 rounded-full border select-none ${
          solved ? "border-emerald-500/50 bg-emerald-500/10" : "border-visiyon-border bg-black/20"
        }`}
        style={{ touchAction: "none" }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => dragging && handlePointerUp()}
        onPointerLeave={() => dragging && handlePointerUp()}
      >
        <p className="absolute inset-0 flex items-center justify-center text-[12px] text-visiyon-text-3 pointer-events-none">
          {solved ? "Verified" : "Drag the piece to fit the puzzle"}
        </p>
        <div
          onPointerDown={handlePointerDown}
          className={`absolute top-0.5 h-8 w-8 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing ${
            solved ? "bg-emerald-400" : "bg-white"
          }`}
          style={{ left: `calc((100% - 2rem) * ${(sliderX / maxTrack).toFixed(4)})`, touchAction: "none" }}
        >
          {solved ? <Check size={14} className="text-black" strokeWidth={3} /> : null}
        </div>
      </div>
    </div>
  );
}
