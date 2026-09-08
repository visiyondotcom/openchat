"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ChatWindow from "@/components/ChatWindow";
import { useChatStore } from "@/lib/store";
import { useRequireAuth } from "@/lib/useAuth";
import { getDefaultModel } from "@/lib/api";

export default function ChatPage() {
  const { ready } = useRequireAuth();
  const params = useParams<{ id: string }>();
  const selectedModel = useChatStore((s) => s.selectedModel);
  // Same reasoning as the root page: Sidebar's "new chat" button needs
  // *some* model before selectedModel is populated, so ask the server for
  // whatever's actually available instead of a hardcoded "glm4:9b".
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    getDefaultModel().then(setDefaultModel);
  }, []);
  if (!ready) return null;
  return (
    <div className="flex bg-visiyon-bg text-visiyon-text h-full min-h-0">
      <Sidebar activeId={params.id} model={selectedModel || defaultModel || ""} />
      <ChatWindow chatId={params.id} />
    </div>
  );
}
