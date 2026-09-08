import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PromptDialogHost } from "@/components/PromptDialog";
import BannerBar from "@/components/BannerBar";
import SupportChatWidget from "@/components/SupportChatWidget";
import SettingsModal from "@/components/SettingsModal";
import SearchModal from "@/components/SearchModal";
import { MusicPlayerProvider } from "@/lib/musicPlayer";
import GlobalPlayerBar from "@/components/GlobalPlayerBar";
import VisitorTracker from "@/components/VisitorTracker";
import CookieConsentBanner from "@/components/CookieConsentBanner";

export const metadata: Metadata = {
  metadataBase: new URL("https://ai.visiyon.com"),
  title: "Visiyon AI Studio — AI Image & Video Generator, Chat and Creative Tools",
  description:
    "Visiyon AI Studio lets you generate AI images and videos, edit photos, and chat with AI assistants — no setup, no software to install. Part of the Visiyon family.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon-120.png", sizes: "120x120", type: "image/png" },
      { url: "/apple-touch-icon-152.png", sizes: "152x152", type: "image/png" },
      { url: "/apple-touch-icon-167.png", sizes: "167x167", type: "image/png" },
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
  },
  other: {
    "msapplication-TileImage": "/mstile-150.png",
    "msapplication-TileColor": "#0a0a0a",
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Visiyon AI Studio — AI Image & Video Generator, Chat and Creative Tools",
    description:
      "Visiyon AI Studio lets you generate AI images and videos, edit photos, and chat with AI assistants — no setup, no software to install. Part of the Visiyon family.",
    url: "https://ai.visiyon.com/",
    siteName: "Visiyon AI Studio",
    images: [{ url: "/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Visiyon AI Studio — AI Image & Video Generator, Chat and Creative Tools",
    description:
      "Visiyon AI Studio lets you generate AI images and videos, edit photos, and chat with AI assistants — no setup, no software to install. Part of the Visiyon family.",
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* General Sans webfont (Fontshare, free/no signup) — used as the
            default UI font (see globals.css's html/body rule and the
            "Default" entry in SettingsContent.tsx's FONT_OPTIONS). Applies
            globally via --visiyon-font, so it's picked up by every theme
            (dark/light/midnight) automatically, not just one. */}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap"
          rel="stylesheet"
        />
        {/* Runs before paint so switching themes never flashes the wrong
            one on reload. Falls back to dark (matches the className above)
            when nothing's been chosen yet or localStorage is unavailable. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("visiyon_theme");if(t==="light"||t==="midnight"){document.documentElement.classList.remove("dark");document.documentElement.classList.add(t);}var f=localStorage.getItem("visiyon_font_family");if(f){document.documentElement.style.setProperty("--visiyon-font",f);}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-visiyon-bg text-visiyon-text antialiased h-dvh flex flex-col overflow-hidden">
        <MusicPlayerProvider>
          <BannerBar />
          <div className="flex-1 min-h-0">{children}</div>
          <PromptDialogHost />
          <SupportChatWidget />
          <SettingsModal />
          <SearchModal />
          <GlobalPlayerBar />
        </MusicPlayerProvider>
        {/* Central Visiyon visitor tracker — skipped on /admin, see component. */}
        <VisitorTracker />
        <CookieConsentBanner />
      </body>
    </html>
  );
}
