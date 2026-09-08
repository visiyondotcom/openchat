"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { useRef, useState } from "react";
import Link from "next/link";
import { streamPlayground } from "@/lib/api";
import { safeRandomUUID } from "@/lib/uuid";
import ModelSelector from "@/components/ModelSelector";
import MarkdownMessage from "@/components/MarkdownMessage";
import ThinkingIndicator from "@/components/ThinkingIndicator";
import { Square, RotateCcw, ArrowLeft, SlidersHorizontal, X } from "lucide-react";

// Same waveform send icon as the homepage chat bar (ChatWindow.tsx) — kept
// as a local copy since that one isn't exported.
function SendWaveIcon({ size = 16 }: { size?: number }) {
  const bars = [
    { x: 1.5, h: 6 },
    { x: 6.1, h: 10 },
    { x: 10.7, h: 14 },
    { x: 15.3, h: 10 },
    { x: 19.9, h: 6 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {bars.map((bar, i) => (
        <rect key={i} x={bar.x} y={12 - bar.h / 2} width="2.6" height={bar.h} rx="1.3" fill="currentColor" />
      ))}
    </svg>
  );
}

interface PMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function PlaygroundPage() {
  const { ready } = useRequireAuth();
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.9);
  const [numCtx, setNumCtx] = useState(4096);
  const [messages, setMessages] = useState<PMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    const content = input.trim();
    if (!content || streaming || !model) return;

    const history = [...messages, { id: safeRandomUUID(), role: "user" as const, content }];
    setMessages([...history, { id: safeRandomUUID(), role: "assistant" as const, content: "" }]);
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamPlayground(
        {
          model,
          systemPrompt: systemPrompt || undefined,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          temperature,
          top_p: topP,
          num_ctx: numCtx,
        },
        (token) => {
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], content: next[next.length - 1].content + token };
            return next;
          });
        },
        { signal: controller.signal }
      );
    } catch {
      /* stopped or errored */
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(false);
  }

  if (!ready) return null;

  return (
    <div className="flex h-full relative">
      {/* Backdrop — mobile only, closes the params drawer on tap */}
      {paramsOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setParamsOpen(false)} />
      )}

      {/* Left: parameter panel — nothing here is persisted, this is a scratch space.
          Fixed column on lg+; off-canvas drawer below that, toggled via the
          gear button in the chat header. */}
      <aside
        className={`w-80 shrink-0 h-full overflow-y-auto p-5 space-y-5 bg-visiyon-bg
          fixed inset-y-0 left-0 z-50 transition-transform duration-200
          lg:static lg:translate-x-0
          ${paramsOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
            <ArrowLeft size={14} /> Back to chat
          </Link>
          <button
            onClick={() => setParamsOpen(false)}
            className="lg:hidden p-1 text-visiyon-text-2 hover:text-visiyon-text"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div>
          <h1 className="text-lg font-semibold mb-1">Playground</h1>
          <p className="text-[12.5px] text-visiyon-text-3">
            Separate from your chat history — test a model with free parameters.
          </p>
        </div>

        <div>
          <label className="text-[12px] text-visiyon-text-3 block mb-1.5">Model</label>
          <ModelSelector value={model} onChange={setModel} />
        </div>

        <div>
          <label className="text-[12px] text-visiyon-text-3 block mb-1.5">System prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            placeholder="Optioneel…"
            className="w-full text-[13px] bg-visiyon-text/[0.04] rounded-lg px-3 py-2 outline-none focus:bg-visiyon-text/[0.07] resize-none text-visiyon-text placeholder-visiyon-text-3/40 transition-colors"
          />
        </div>

        <div>
          <div className="flex justify-between text-[12px] text-visiyon-text-3 mb-1.5">
            <span>Temperature</span>
            <span>{temperature.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="w-full accent-white"
          />
        </div>

        <div>
          <div className="flex justify-between text-[12px] text-visiyon-text-3 mb-1.5">
            <span>Top P</span>
            <span>{topP.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={topP}
            onChange={(e) => setTopP(Number(e.target.value))}
            className="w-full accent-white"
          />
        </div>

        <div>
          <div className="flex justify-between text-[12px] text-visiyon-text-3 mb-1.5">
            <span>Context window</span>
            <span>{numCtx.toLocaleString()}</span>
          </div>
          <input
            type="range"
            min={512}
            max={32768}
            step={512}
            value={numCtx}
            onChange={(e) => setNumCtx(Number(e.target.value))}
            className="w-full accent-white"
          />
        </div>

        <button
          onClick={reset}
          className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium py-2 rounded-xl bg-visiyon-text/[0.06] hover:bg-visiyon-text/[0.12] transition-colors"
        >
          <RotateCcw size={13} /> New session
        </button>
      </aside>

      {/* Right: conversation */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <div className="lg:hidden h-12 shrink-0 flex items-center px-4">
          <button
            onClick={() => setParamsOpen(true)}
            className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text"
          >
            <SlidersHorizontal size={15} /> Parameters
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-8">
            {messages.length === 0 && (
              <div className="text-center text-visiyon-text-2 mt-8">
                <p className="text-lg">Test a model with free parameters.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={m.id} className={`mb-6 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-[12px] px-4 py-3 text-[14.5px] ${
                    m.role === "user" ? "bg-white text-black" : "text-visiyon-text"
                  }`}
                >
                  {m.role === "assistant" ? (
                    m.content ? (
                      <MarkdownMessage content={m.content} messageId={m.id} />
                    ) : streaming && i === messages.length - 1 ? (
                      <ThinkingIndicator model={model} />
                    ) : null
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4">
          <div className="max-w-3xl mx-auto flex items-end gap-2 bg-visiyon-text/[0.04] rounded-[28px] p-2 focus-within:bg-visiyon-text/[0.07] transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={model ? "Message…" : "Choose a model first"}
              className="flex-1 bg-transparent outline-none resize-none px-2 py-2 text-[14.5px] max-h-40 text-visiyon-text placeholder-visiyon-text-3/40"
            />
            {streaming ? (
              <button
                onClick={() => {
                  abortRef.current?.abort();
                  setStreaming(false);
                }}
                className="flex items-center justify-center h-9 w-9 rounded-full bg-white text-black hover:bg-visiyon-text/80 transition-colors"
                title="Stop"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                onClick={send}
                className="flex items-center justify-center h-9 w-9 rounded-full bg-white text-black hover:bg-visiyon-text/80 transition-colors disabled:opacity-40"
                disabled={!input.trim() || !model}
                title="Send"
              >
                <SendWaveIcon size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
