"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listChannels, createChannel, joinChannel, listChannelMessages, postChannelMessage, streamChannel } from "@/lib/api";
import { askPrompt } from "@/components/PromptDialog";
import { Plus, Send, Hash, Lock, ArrowLeft } from "lucide-react";

interface Channel {
  id: string;
  name: string;
  description?: string;
  isPrivate: boolean;
  _count: { members: number };
}
interface Message {
  id: string;
  content: string;
  isBot: boolean;
  createdAt: string;
  user?: { id: string; name?: string; email: string } | null;
}

export default function ChannelsPage() {
  const { ready } = useRequireAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listChannels().then((r) => setChannels(r.channels));
  }, []);

  useEffect(() => {
    if (!active) return;
    listChannelMessages(active.id).then((r) => setMessages(r.messages));

    // Live updates over SSE — the token is passed as a query param since
    // EventSource can't set an Authorization header (see lib/api.ts).
    const es = streamChannel(active.id);
    es.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.message) setMessages((prev) => [...prev, data.message]);
    };
    es.onerror = () => {
      // Browser EventSource auto-reconnects; nothing to do here beyond
      // leaving it alone unless the channel changes.
    };
    return () => es.close();
  }, [active?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function handleCreate() {
    const name = await askPrompt({ title: "New channel", label: "Channel name", placeholder: "e.g. general" });
    if (!name) return;
    const { channel } = await createChannel({ name });
    setChannels((prev) => [...prev, channel]);
    setActive(channel);
  }

  async function handleSelect(ch: Channel) {
    await joinChannel(ch.id).catch(() => {});
    setActive(ch);
  }

  async function handleSend() {
    if (!draft.trim() || !active) return;
    const content = draft;
    setDraft("");
    await postChannelMessage(active.id, content);
    // No optimistic append — the message arrives back over our own SSE
    // subscription a moment later, same as it does for every other member.
  }

  if (!ready) return null;

  return (
    <div className="flex h-full bg-visiyon-bg text-visiyon-text">
      <div className={`${active ? "hidden md:flex" : "flex"} w-full md:w-64 shrink-0 border-r border-visiyon-border flex-col`}>
        <div className="px-4 pt-4">
          <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
            <ArrowLeft size={14} /> Back to chat
          </Link>
        </div>
        <div className="p-4 flex items-center justify-between">
          <h1 className="font-semibold">Channels</h1>
          <button onClick={handleCreate} className="p-1.5 rounded hover:bg-visiyon-text/10">
            <Plus size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => handleSelect(ch)}
              className={`w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-visiyon-text/5 ${active?.id === ch.id ? "bg-visiyon-text/10" : ""}`}
            >
              {ch.isPrivate ? <Lock size={14} className="text-visiyon-text-3" /> : <Hash size={14} className="text-visiyon-text-3" />}
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={`${active ? "flex" : "hidden md:flex"} flex-1 flex-col w-full min-w-0`}>
        {active ? (
          <>
            <div className="p-4 border-b border-visiyon-border flex items-center gap-2">
              <button
                onClick={() => setActive(null)}
                className="md:hidden p-1 -ml-1 text-visiyon-text-2 hover:text-visiyon-text shrink-0"
                title="Back to channels"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="min-w-0">
                <h2 className="font-semibold flex items-center gap-1.5 truncate">
                  <Hash size={16} className="text-visiyon-text-3 shrink-0" /> {active.name}
                </h2>
                {active.description && <p className="text-xs text-visiyon-text-3 mt-0.5 truncate">{active.description}</p>}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m) => (
                <div key={m.id} className="flex gap-2">
                  <div className="w-7 h-7 rounded-full bg-visiyon-accent/20 flex items-center justify-center text-xs shrink-0">
                    {m.isBot ? "🤖" : (m.user?.name || m.user?.email || "?")[0]?.toUpperCase()}
                  </div>
                  <div>
                    <div className="text-xs text-visiyon-text-3">{m.isBot ? "Assistant" : m.user?.name || m.user?.email}</div>
                    <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <div className="p-4 border-t border-visiyon-border flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                placeholder="Message #${active.name} — @assistant to ask the bot"
                className="flex-1 bg-visiyon-text/5 rounded px-3 py-2 outline-none text-sm"
              />
              <button onClick={handleSend} className="p-2 rounded-lg bg-visiyon-accent text-visiyon-bg hover:opacity-90 transition-opacity">
                <Send size={16} />
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-visiyon-text-3">Select a channel</div>
        )}
      </div>
    </div>
  );
}
