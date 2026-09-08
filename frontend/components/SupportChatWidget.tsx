"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LifeBuoy, Loader2, Send, X } from "lucide-react";
import { getMe, streamSupportChat } from "@/lib/api";
import { getSupportWidgetEnabled, onSupportWidgetPrefChange } from "@/lib/supportWidgetPref";

type Msg = { role: "user" | "assistant"; content: string };

// Floating "Need help?" widget, mounted once in the root layout so it's
// available on every page. Answers questions about how to use the
// platform itself (not general chat) — see backend routes/support.ts and
// lib/support-knowledge.ts. Runs on this deployment's own local Ollama, no
// external API, so it works out of the box on any install.
export default function SupportChatWidget() {
  const pathname = usePathname();
  const [loggedIn, setLoggedIn] = useState(false);
  const [widgetEnabled, setWidgetEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getMe()
      .then(() => setLoggedIn(true))
      .catch(() => setLoggedIn(false));
  }, []);

  useEffect(() => {
    setWidgetEnabled(getSupportWidgetEnabled());
    return onSupportWidgetPrefChange(() => setWidgetEnabled(getSupportWidgetEnabled()));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setInput("");
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setSending(true);
    try {
      let acc = "";
      await streamSupportChat(next, (token) => {
        acc += token;
        setMessages([...next, { role: "assistant", content: acc }]);
      });
    } catch (err: any) {
      const msg = err?.message || "";
      setError(
        msg.includes("No local model")
          ? "No AI model is installed on this server yet — an admin needs to pull one first (Admin → Models)."
          : msg || "Something went wrong — please try again."
      );
      setMessages(next);
    } finally {
      setSending(false);
    }
  }

  // Not signed in: nothing to help with yet (support needs an auth'd
  // request, same as the rest of the app), so stay hidden rather than show
  // a widget that will just error. Also hidden if the user turned it off
  // themselves in Settings > Profile.
  // Hidden inside the Studio code editor — it's a full-screen, densely
  // packed workspace (file tree, editor, preview, publish bar), and the
  // floating bubble sat directly on top of the subdomain/Publish controls
  // in the bottom-right corner with nowhere clear to put it.
  if (pathname?.startsWith("/studio")) return null;
  if (!loggedIn || !widgetEnabled) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open && (
        <div className="mb-3 w-[340px] h-[440px] flex flex-col bg-visiyon-bg border border-visiyon-border rounded-[10px] shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-visiyon-border shrink-0">
            <div className="flex items-center gap-2 text-[13.5px] font-medium">
              <LifeBuoy size={15} className="text-visiyon-accent" />
              Platform support
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-[12.5px] text-visiyon-text-3">
                Ask anything about using Visiyon — where a setting lives, what a feature does,
                or why something isn't showing up.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`text-[13px] leading-relaxed whitespace-pre-wrap rounded-[8px] px-3 py-2 max-w-[85%] ${
                  m.role === "user"
                    ? "bg-white text-black ml-auto"
                    : "bg-visiyon-text/[0.05] text-visiyon-text"
                }`}
              >
                {m.content || (sending && i === messages.length - 1 ? "…" : "")}
              </div>
            ))}
            {error && <p className="text-[12px] text-red-400">{error}</p>}
          </div>

          <div className="flex items-center gap-2 px-3 py-2.5 border-t border-visiyon-border shrink-0">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask a question…"
              disabled={sending}
              className="flex-1 text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-2.5 py-1.5 outline-none focus:border-visiyon-text disabled:opacity-50"
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="p-2 rounded-[6px] bg-white text-black hover:bg-visiyon-text/90 disabled:opacity-40"
              title="Send"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[13px] px-4 py-3 rounded-full bg-visiyon-text text-visiyon-bg shadow-lg hover:bg-visiyon-text/85"
        title="Need help?"
      >
        <LifeBuoy size={16} />
        {!open && "Need help?"}
      </button>
    </div>
  );
}
