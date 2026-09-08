"use client";

import { useState } from "react";
import Link from "next/link";

const SCRIPT = [
  { role: "user", text: "Explain the CAP theorem in one sentence." },
  {
    role: "assistant",
    text: "A distributed system can only guarantee two of Consistency, Availability, and Partition tolerance at once, never all three simultaneously.",
  },
];

export default function InteractiveDemo() {
  const [visible, setVisible] = useState(1);

  return (
    <section className="py-24 border-t border-visiyon-border">
      <div className="max-w-3xl mx-auto px-6">
        <div className="text-center mb-10">
          <div className="text-[13px] font-semibold tracking-widest uppercase text-visiyon-text mb-3">Preview</div>
          <h2 className="text-[28px] md:text-[36px] tracking-[-0.02em] font-semibold">See it in action</h2>
        </div>
        <div className="border border-visiyon-border rounded-2xl bg-visiyon-panel p-6">
          {SCRIPT.slice(0, visible).map((m, i) => (
            <div key={i} className={`mb-4 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[14.5px] leading-relaxed ${
                  m.role === "user" ? "bg-white text-black" : "bg-visiyon-text/[0.06] text-visiyon-text"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          <div className="flex gap-3 mt-6">
            {visible < SCRIPT.length ? (
              <button
                onClick={() => setVisible((v) => v + 1)}
                className="text-sm font-medium px-4 py-2 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text transition-colors"
              >
                Continue demo
              </button>
            ) : (
              <Link
                href="/"
                className="text-sm font-medium px-4 py-2 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text transition-colors"
              >
                Try it for real
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
