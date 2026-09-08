"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSharedChat } from "@/lib/api";
import MarkdownMessage from "@/components/MarkdownMessage";
import Logo from "@/components/Logo";

interface SharedMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: string;
}

export default function SharedChatPage() {
  const params = useParams<{ shareId: string }>();
  const [chat, setChat] = useState<{ id: string; title: string; model: string; messages: SharedMessage[] } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSharedChat(params.shareId)
      .then((data) => setChat(data.chat))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [params.shareId]);

  if (error) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="text-center">
          <Logo />
          <p className="text-visiyon-text-2 mt-4">{error}</p>
        </div>
      </div>
    );
  }

  if (!chat) {
    return <div className="min-h-full flex items-center justify-center text-visiyon-text-3">Loading…</div>;
  }

  return (
    <div className="min-h-full">
      <div className="h-16 border-b border-visiyon-border flex items-center px-6">
        <Logo />
      </div>
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">{chat.title}</h1>
          <p className="text-[12.5px] text-visiyon-text-3 mt-1">
            Shared conversation · {chat.model} · read-only
          </p>
        </div>
        {chat.messages
          .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
          .map((m) => (
          <div key={m.id} className={`mb-6 flex ${m.role === "USER" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-[14.5px] ${
                m.role === "USER" ? "bg-white text-black" : "bg-visiyon-text/[0.05] text-visiyon-text"
              }`}
            >
              {m.role === "ASSISTANT" ? <MarkdownMessage content={m.content} messageId={m.id} /> : m.content}
            </div>
          </div>
        ))}
        <p className="text-center text-[11.5px] text-visiyon-text-3 mt-10">
          This is a public, read-only view. Replying requires an account.
        </p>
      </div>
    </div>
  );
}
