"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// /chat now redirects to "/" — the chat UI moved to the root URL so
// ai.visiyon.com opens the app directly. Kept as a redirect (rather than
// deleted) so old bookmarks/links to /chat still land in the right place.
export default function ChatRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}
