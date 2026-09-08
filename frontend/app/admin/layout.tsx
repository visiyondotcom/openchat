"use client";

import { useState } from "react";
import { Sora } from "next/font/google";
import AdminSidebar from "@/components/AdminSidebar";
import AdminTopbar from "@/components/AdminTopbar";

// Modern, technical display font for the admin dashboard only (the
// public/chat UI keeps the system font stack). Exposed as a CSS
// variable and applied via the `.admin-font` rule in globals.css so it
// only affects text inside /admin/*, not the rest of the app.
const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-admin",
  display: "swap",
});

// Shared chrome for every /admin/* page: a black Azure-portal-style top
// bar, a flat-black vertical sidebar below it on the left, and a
// scrollable content area on the right. Individual pages no longer render
// their own <Logo/> + <AdminNav/> — see components/AdminSidebar.tsx and
// components/AdminTopbar.tsx.
//
// Below the `lg` breakpoint the sidebar used to just sit at a fixed 220px,
// squeezing every admin page's content into a too-narrow column with no
// way to hide it. It now behaves like the main chat sidebar: a slide-in
// drawer on mobile, toggled via a hamburger button in AdminTopbar.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  return (
    <div className={`admin-font ${sora.variable} flex flex-col h-dvh bg-visiyon-bg text-visiyon-text overflow-hidden`}>
      <AdminTopbar onOpenSidebar={() => setMobileSidebarOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <AdminSidebar mobileOpen={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)} />
        <main className="flex-1 min-w-0 h-full overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
