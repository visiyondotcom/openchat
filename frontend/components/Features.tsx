const features = [
  { icon: "⌕", title: "Streaming chat", desc: "Token-by-token responses with stop, regenerate and continue." },
  { icon: "▤", title: "Markdown & code", desc: "Syntax-highlighted code blocks with one-click copy." },
  { icon: "◎", title: "Mermaid & LaTeX", desc: "Diagrams and math render inline as the model writes them." },
  { icon: "▧", title: "Multi-chat", desc: "Search, rename, pin and organize conversations into folders." },
];

export default function Features() {
  return (
    <section id="features" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-xl mb-14">
          <div className="text-[13px] font-semibold tracking-widest uppercase text-visiyon-text mb-3">Capabilities</div>
          <h2 className="text-[28px] md:text-[40px] tracking-[-0.02em] leading-tight font-semibold mb-3">
            Everything in one thread.
          </h2>
          <p className="text-visiyon-text-2 text-base leading-relaxed">
            No switching apps. Every model you install becomes available instantly.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-visiyon-border border border-visiyon-border rounded-[20px] overflow-hidden">
          {features.map((f) => (
            <div key={f.title} className="bg-visiyon-bg p-8 min-h-[190px] flex flex-col gap-3.5">
              <div className="w-[34px] h-[34px] rounded-[9px] bg-visiyon-text/[0.06] flex items-center justify-center text-base">
                {f.icon}
              </div>
              <h4 className="text-[15.5px] font-semibold">{f.title}</h4>
              <p className="text-[13.5px] text-visiyon-text-2 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
