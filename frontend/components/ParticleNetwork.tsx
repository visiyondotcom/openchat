"use client";

import { useEffect, useRef } from "react";

/**
 * Animated particle network — same motif/logic as the marketing site's
 * hero-canvas (see index.html), reused here as an overlay on top of the
 * login artwork so the two screens share the same "neural network" feel.
 */
export default function ParticleNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let pts: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    let frameId = 0;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      w = parent.offsetWidth;
      h = parent.offsetHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const N = Math.min(70, Math.floor(w / 16));
      pts = Array.from({ length: N }, () => ({
        x: Math.random() * w,
        y: Math.random() * h * 0.85,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: Math.random() * 1.6 + 0.6,
      }));
    }

    function frame() {
      ctx!.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h * 0.9) p.vy *= -1;
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i];
          const b = pts[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 130) {
            ctx!.strokeStyle = `rgba(255,255,255,${(1 - d / 130) * 0.18})`;
            ctx!.lineWidth = 1;
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.stroke();
          }
        }
      }
      for (const p of pts) {
        ctx!.beginPath();
        ctx!.fillStyle = "rgba(255,255,255,0.8)";
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      if (!reduceMotion) frameId = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    frame();

    return () => {
      window.removeEventListener("resize", resize);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}
