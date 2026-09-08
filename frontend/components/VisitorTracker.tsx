"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

// Central Visiyon visitor tracker — the same script every other Visiyon
// subdomain loads, so ai.visiyon.com shows up in the admin's "Subdomains"
// analytics panel too. Skipped on /admin/* since that's the internal
// dashboard, not a visitor page.
export default function VisitorTracker() {
  const pathname = usePathname();
  if (pathname?.startsWith("/admin")) return null;
  return <Script src="https://visiyon.com/track.js" strategy="afterInteractive" />;
}
