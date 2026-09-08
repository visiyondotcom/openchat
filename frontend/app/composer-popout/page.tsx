"use client";

// Standalone window opened by the "pop out composer" button in ChatWindow.
// It has no chat state of its own — it's a remote control: it types locally,
// then broadcasts "send"/"typing"/"stop" events over a BroadcastChannel to
// the main window, which owns the actual chat, streaming, and history. This
// keeps a single source of truth instead of trying to sync two copies of
// the conversation across windows.

import { useEffect, useRef, useState } from "react";
import { Send, Square, ArrowLeftFromLine } from "lucide-react";

export default function ComposerPopoutPage() {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const chatKey = params.get("chatId") || "new";
    const channel = new BroadcastChannel(`visiyon-composer-${chatKey}`);
    channelRef.current = channel;

    channel.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === "state") {
        setStreaming(!!msg.streaming);
        setConnected(true);
      } else if (msg?.type === "closed") {
        // Main window's chat/tab went away — nothing left to send to.
        setConnected(false);
      }
    };

    // Announce presence so the main window knows a popout is attached and
    // starts pushing state updates (streaming on/off) back to it.
    channel.postMessage({ type: "hello" });
    const helloTimer = setTimeout(() => setConnected(true), 400);

    document.title = "Visiyon — Composer";
    textareaRef.current?.focus();

    return () => {
      clearTimeout(helloTimer);
      channel.postMessage({ type: "bye" });
      channel.close();
    };
  }, []);

  function submit() {
    const text = input.trim();
    if (!text || streaming) return;
    channelRef.current?.postMessage({ type: "send", text });
    setInput("");
  }

  function stop() {
    channelRef.current?.postMessage({ type: "stop" });
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0d0d0d] text-white/90 font-sans p-3 gap-2">
      <div className="flex items-center justify-between text-[11px] text-white/40 px-1">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-white/20"}`} />
          {connected ? "Connected to chat" : "Waiting for chat window…"}
        </span>
        <span className="flex items-center gap-1 opacity-60">
          <ArrowLeftFromLine size={11} /> sends to the main window
        </span>
      </div>
      <div className="flex-1 flex flex-col gap-2 min-h-0">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask anything"
          spellCheck={false}
          className="flex-1 w-full resize-none bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-[14px] outline-none focus:border-white/25 placeholder:text-white/30"
        />
        <div className="flex items-center justify-end gap-2">
          {streaming ? (
            <button
              onClick={stop}
              className="flex items-center gap-1.5 h-9 px-4 rounded-xl text-[13px] font-medium bg-white/10 hover:bg-white/15 transition-colors"
            >
              <Square size={13} /> Stop
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!input.trim()}
              className="flex items-center gap-1.5 h-9 px-4 rounded-xl text-[13px] font-medium bg-white text-black disabled:opacity-30 hover:bg-white/85 transition-colors"
            >
              <Send size={13} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
