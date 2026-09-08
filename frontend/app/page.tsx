"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import ChatWindow from "@/components/ChatWindow";
import OnboardingModal from "@/components/OnboardingModal";
import { useChatStore } from "@/lib/store";
import { useRequireAuth } from "@/lib/useAuth";
import { getDefaultModel } from "@/lib/api";

// Root URL ("/"). This used to redirect straight to /chat (or show the
// login form for logged-out visitors); the chat UI now lives here
// directly, so ai.visiyon.com opens the app itself instead of an extra
// hop through /chat. useRequireAuth still bounces to /login when there's
// no valid session.
export default function RootPage() {
  const { ready, user } = useRequireAuth();
  const selectedModel = useChatStore((s) => s.selectedModel);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  // Sidebar's "new chat" button needs a model before one has ever been
  // selected — ask the server what's actually available instead of the
  // hardcoded "glm4:9b" that used to sit here and silently broke on any
  // deployment that hadn't pulled that exact tag.
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    getDefaultModel().then(setDefaultModel);
  }, []);
  if (!ready) return null;
  const showOnboarding = !user?.onboardingSeenAt && !onboardingDismissed;
  return (
    <div className="flex bg-visiyon-bg text-visiyon-text h-full min-h-0">
      <Sidebar model={selectedModel || defaultModel || ""} />
      <ChatWindow />
      {showOnboarding && <OnboardingModal onDone={() => setOnboardingDismissed(true)} />}
    </div>
  );
}
