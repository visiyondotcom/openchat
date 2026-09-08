"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

export default function Hero() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0,
      h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function resize() {
      const parent = canvas!.parentElement!;
      w = parent.offsetWidth;
      h = parent.offsetHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener("resize", resize);
    resize();

    const N = Math.min(70, Math.floor(w / 16));
    const pts = Array.from({ length: N }, () => ({
      x: Math.random() * w,
      y: Math.random() * h * 0.85,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      r: Math.random() * 1.6 + 0.6,
    }));

    let raf = 0;
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
          const a = pts[i],
            b = pts[j];
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
      if (!reduceMotion) raf = requestAnimationFrame(frame);
    }
    frame();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="relative pt-[180px] pb-[120px] overflow-hidden">
      <div
        className="absolute -top-[200px] left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full pointer-events-none blur-[10px]"
        style={{
          background:
            "radial-gradient(circle, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.03) 35%, transparent 70%)",
        }}
      />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full opacity-55 pointer-events-none" />
      <div className="relative z-10 max-w-6xl mx-auto px-6 text-center">
        <span className="inline-flex items-center gap-2 text-[13px] text-visiyon-text-2 border border-visiyon-border rounded-full px-3.5 py-1.5 mb-7">
          <span className="w-1.5 h-1.5 rounded-full bg-white" /> Self-hosted. Your models, your data.
        </span>
        <h1 className="text-[40px] md:text-[76px] leading-[1.04] tracking-[-0.03em] font-semibold max-w-4xl mx-auto mb-6">
          One assistant, <span className="text-white/70">every open model.</span>
        </h1>
        <p className="text-base md:text-[19px] text-visiyon-text-2 max-w-xl mx-auto mb-10 leading-relaxed">
          Visiyon AI runs entirely on your own server with Ollama — GLM-4, Granite,
          Llama, Qwen and more, in one fast, private conversation.
        </p>
        <div className="flex gap-3.5 justify-center flex-wrap">
          <Link
            href="/"
            className="inline-flex items-center justify-center text-[15px] font-medium px-6 py-3 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text transition-colors"
          >
            Start chatting
          </Link>
          <a
            href="#features"
            className="inline-flex items-center justify-center text-[15px] font-medium px-6 py-3 rounded-full text-visiyon-text border border-visiyon-border hover:bg-white hover:text-black hover:border-visiyon-text transition-colors"
          >
            See what it can do
          </a>
        </div>
      </div>
    </section>
  );
}
