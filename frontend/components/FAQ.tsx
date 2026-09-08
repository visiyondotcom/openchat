"use client";

import { useState } from "react";

const faqs = [
  {
    q: "Does this send my data anywhere?",
    a: "No. Every request stays on your server — Ollama runs the model locally, and chats are stored in your own PostgreSQL database.",
  },
  {
    q: "Which models are supported?",
    a: "Any model available through Ollama: GLM-4, Granite, Llama, Qwen, Gemma, DeepSeek, Mistral, Phi, and vision/embedding models.",
  },
  {
    q: "Do I need a GPU?",
    a: "No, but it helps. Smaller quantized models (8B–9B) run acceptably on CPU; a GPU makes responses noticeably faster.",
  },
  {
    q: "Can multiple people use one server?",
    a: "Yes — Visiyon has full user accounts, JWT auth and an admin panel for managing users and models.",
  },
];

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="py-24 border-t border-visiyon-border">
      <div className="max-w-3xl mx-auto px-6">
        <h2 className="text-[28px] md:text-[36px] tracking-[-0.02em] font-semibold mb-10 text-center">
          Frequently asked questions
        </h2>
        <div className="divide-y divide-visiyon-border border-t border-b border-visiyon-border">
          {faqs.map((f, i) => (
            <div key={f.q}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between py-5 text-left"
              >
                <span className="text-[15px] font-medium">{f.q}</span>
                <span className="text-visiyon-text-2 text-xl leading-none">{open === i ? "–" : "+"}</span>
              </button>
              {open === i && <p className="pb-5 text-[14px] text-visiyon-text-2 leading-relaxed">{f.a}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
