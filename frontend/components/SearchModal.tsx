"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X, MessageSquare } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { listChats } from "@/lib/api";

interface ChatResult {
  id: string;
  title: string;
}

// Quick-jump "Recent chats" search — a floating panel over a blurred chat,
// opened from the search icon in the sidebar header. Separate from the
// always-visible inline sidebar search box (which filters the full list in
// place); this one is for jumping straight to a chat, ChatGPT-cmd-k style.
export default function SearchModal() {
  const searchOpen = useChatStore((s) => s.searchOpen);
  const closeSearch = useChatStore((s) => s.closeSearch);
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!searchOpen) return;
    setQuery("");
    setResults([]);
    listChats().then(setResults).catch(() => setResults([]));
    requestAnimationFrame(() => inputRef.current?.focus());

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeSearch();
    }
    window.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [searchOpen, closeSearch]);

  useEffect(() => {
    if (!searchOpen) return;
    setLoading(true);
    const t = setTimeout(() => {
      listChats(query || undefined)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query, searchOpen]);

  if (!searchOpen) return null;

  function openChat(id: string) {
    closeSearch();
    router.push(`/chat/${id}`);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 sm:pt-32 px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={closeSearch} />
      <div className="relative w-full max-w-lg bg-visiyon-bg border border-visiyon-border rounded-2xl shadow-2xl overflow-hidden max-h-[70vh] flex flex-col">
        <div className="flex items-center gap-2.5 px-4 h-14 shrink-0 border-b border-visiyon-border">
          <Search size={16} className="text-visiyon-text-3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            autoComplete="off"
            name="quick-search-chats"
            className="flex-1 min-w-0 bg-transparent outline-none text-[14px] placeholder:text-visiyon-text-3"
          />
          <button onClick={closeSearch} className="text-visiyon-text-3 hover:text-visiyon-text shrink-0" aria-label="Close search">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 py-2">
          {results.length > 0 && (
            <div className="px-4 pb-1 text-[11px] uppercase tracking-wide text-visiyon-text-3">
              {query ? "Results" : "Recent chats"}
            </div>
          )}
          {results.map((c) => (
            <button
              key={c.id}
              onClick={() => openChat(c.id)}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13.5px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
            >
              <MessageSquare size={15} className="shrink-0 text-visiyon-text-3" />
              <span className="truncate">{c.title}</span>
            </button>
          ))}
          {!loading && results.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-visiyon-text-3">No chats found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
