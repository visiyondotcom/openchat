const models = [
  { name: "GLM-4 9B", tag: "General purpose" },
  { name: "Granite 4.1 8B", tag: "General purpose" },
  { name: "Llama", tag: "Meta" },
  { name: "Qwen", tag: "Alibaba" },
  { name: "Gemma", tag: "Google" },
  { name: "DeepSeek", tag: "Reasoning" },
  { name: "Mistral", tag: "General purpose" },
  { name: "Phi", tag: "Microsoft" },
];

export default function Models() {
  return (
    <section id="models" className="py-24 border-t border-visiyon-border">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-xl mb-14">
          <div className="text-[13px] font-semibold tracking-widest uppercase text-visiyon-text mb-3">Models</div>
          <h2 className="text-[28px] md:text-[40px] tracking-[-0.02em] leading-tight font-semibold mb-3">
            Bring any Ollama model.
          </h2>
          <p className="text-visiyon-text-2 text-base leading-relaxed">
            Visiyon detects every model you&apos;ve pulled into Ollama automatically —
            including vision and embedding models — no config required.
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {models.map((m) => (
            <div
              key={m.name}
              className="border border-visiyon-border rounded-2xl p-5 hover:border-visiyon-text transition-colors"
            >
              <div className="text-[15px] font-medium mb-1">{m.name}</div>
              <div className="text-[12.5px] text-visiyon-text-3">{m.tag}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
