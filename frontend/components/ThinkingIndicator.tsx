"use client";

import { useEffect, useState } from "react";

// Cycles "." -> ".." -> "..." -> "." forever, ~500ms per step. Kept as its
// own tiny component (not CSS-only) because animating the `content`
// property with keyframes isn't reliably supported across browsers.
function AnimatedDots() {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d % 3) + 1), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="inline-block w-4">{".".repeat(dots)}</span>;
}

export default function ThinkingIndicator({ model }: { model?: string | null }) {
  return (
    <span className="inline-flex items-baseline text-[14px]">
      <span className="visiyon-shimmer-text">{model || "Model"} thinking</span>
      <AnimatedDots />
    </span>
  );
}
