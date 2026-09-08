"use client";

import { useEffect, useRef, useState } from "react";

// Claude-style "generating" mark shown next to the assistant's name in the
// chat list — two 4-point sparkles (one main, one small companion), drawn
// in currentColor so it always matches the theme's text colour.
//
// - Idle (`active` false): fully static, no motion.
// - Generating (`active` true): both sparkles breathe/twinkle on their own
//   independent, randomized timing (duration, delay, rotation direction),
//   while the whole icon continuously spins — speeding up and slowing
//   down within each rotation, and alternating direction (clockwise, then
//   counter-clockwise) every rotation. Timing is re-rolled fresh every
//   time a new generation starts, so the motion never looks identical
//   twice.
function randomSeed() {
  const dir = Math.random() > 0.5 ? 1 : -1;
  return {
    d1: 1.1 + Math.random() * 0.7, // main sparkle duration: 1.1–1.8s
    de1: Math.random() * 0.4, // main sparkle delay: 0–0.4s
    d2: 0.8 + Math.random() * 0.9, // minor sparkle duration: 0.8–1.7s
    de2: Math.random() * 0.6, // minor sparkle delay: 0–0.6s
    rot1: dir * (6 + Math.random() * 6), // 6–12deg, random direction
    rot2: -dir * (8 + Math.random() * 10), // opposite direction, 8–18deg
    // Continuous whole-icon spin: one rotation per cycle, alternating
    // clockwise/counter-clockwise every cycle (via animation-direction:
    // alternate in CSS) with a fast→slow→fast pace built into the
    // keyframes. Duration/delay are randomized per instance so several
    // sparkle icons on screen at once don't spin in lockstep.
    spinDur: 3.5 + Math.random() * 2.5, // 3.5–6s per full rotation
    spinDelay: Math.random() * 2, // 0–2s before the first rotation starts
  };
}

export default function SparkleAvatarIcon({
  size = 16,
  active = false,
  className = "",
}: {
  size?: number;
  active?: boolean;
  className?: string;
}) {
  const [seed, setSeed] = useState(randomSeed);
  const wasActive = useRef(active);

  useEffect(() => {
    // Roll a fresh animation pattern every time a new generation begins
    // (idle → active transition), not on every re-render while active.
    if (active && !wasActive.current) {
      setSeed(randomSeed());
    }
    wasActive.current = active;
  }, [active]);

  const style = {
    width: size,
    height: size,
    color: "currentColor",
    "--visiyon-spark-d1": `${seed.d1.toFixed(2)}s`,
    "--visiyon-spark-de1": `${seed.de1.toFixed(2)}s`,
    "--visiyon-spark-d2": `${seed.d2.toFixed(2)}s`,
    "--visiyon-spark-de2": `${seed.de2.toFixed(2)}s`,
    "--visiyon-spark-rot1": `${seed.rot1.toFixed(0)}deg`,
    "--visiyon-spark-rot2": `${seed.rot2.toFixed(0)}deg`,
    "--visiyon-spark-spin-d": `${seed.spinDur.toFixed(2)}s`,
    "--visiyon-spark-spin-delay": `${seed.spinDelay.toFixed(2)}s`,
  } as React.CSSProperties;

  return (
    <span
      className={`visiyon-sparkle-icon ${active ? "visiyon-sparkle-icon--active" : ""} ${className}`}
      style={style}
      role="img"
      aria-label={active ? "Jean, generating" : "Jean"}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
        <path
          className="visiyon-sparkle-mark visiyon-sparkle-mark--main"
          d="M12 2c0 4.5 1 7 2.5 8.5S19.5 12.9 21 13.5c-1.5.6-5 1-6.5 2.5S12 20.5 12 22c0-1.5-1-4.5-2.5-6S3.5 14.1 2 13.5c1.5-.6 5.5-1 7-2.5S12 6.5 12 2Z"
          fill="currentColor"
        />
        <path
          className="visiyon-sparkle-mark visiyon-sparkle-mark--minor"
          d="M18.4 2c0 1.7.32 2.72.94 3.34S21 6.3 22.7 6.3c-1.7 0-2.72.32-3.34.94S18.4 8.9 18.4 10.6c0-1.7-.32-2.72-.94-3.34S15.8 6.3 14.1 6.3c1.7 0 2.72-.32 3.34-.94S18.4 3.7 18.4 2Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
