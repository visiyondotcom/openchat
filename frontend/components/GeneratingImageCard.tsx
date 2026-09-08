"use client";

import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";

// Cycles through a few status lines while the request is in flight so the
// card doesn't sit static for the 10-30s an image generation call can take.
// These are deliberately vague ("Sketching", "Rendering", ...) since we
// have no real progress signal from the backend — just enough motion to
// make it obvious something is happening.
const STATUSES = [
  "Sketching it out…",
  "Blocking in shapes…",
  "Laying down color…",
  "Adding detail…",
  "Refining the image…",
];

export default function GeneratingImageCard({ prompt }: { prompt?: string | null }) {
  const [statusIdx, setStatusIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setStatusIdx((i) => (i + 1) % STATUSES.length);
    }, 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="max-w-[80%] rounded-[12px] px-4 py-3 text-[14.5px] leading-relaxed text-visiyon-text">
      <div className="flex items-center gap-3 mb-3">
        <div className="relative h-8 w-8 shrink-0 rounded-full bg-visiyon-text/[0.08] flex items-center justify-center">
          <ImageIcon size={15} className="text-visiyon-text-2" />
          <span className="absolute inset-0 rounded-full border border-white/20 animate-ping" />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] text-visiyon-text-2 transition-opacity duration-300">
            {STATUSES[statusIdx]}
          </div>
          {prompt && (
            <div className="text-[12px] text-visiyon-text-3 truncate max-w-[320px]">"{prompt}"</div>
          )}
        </div>
      </div>

      {/* Sketching skeleton: a faint canvas with a "pencil" sweeping across
          it, standing in for real generation progress. */}
      <div className="relative h-40 w-56 rounded-lg bg-visiyon-text/[0.05] border border-white/[0.08] overflow-hidden">
        <div className="absolute inset-0 grid grid-cols-6 grid-rows-4 opacity-20">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="border border-visiyon-border" />
          ))}
        </div>
        <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/15 to-transparent animate-[sweep_1.6s_ease-in-out_infinite]" />
      </div>

      <style jsx>{`
        @keyframes sweep {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(300%);
          }
        }
      `}</style>
    </div>
  );
}
