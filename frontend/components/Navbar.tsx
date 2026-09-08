"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import Logo from "./Logo";

const NAV_LINKS = [
  { href: "#models", label: "Models" },
  { href: "#features", label: "Features" },
  { href: "#faq", label: "FAQ" },
  { href: "#contact", label: "Contact" },
];

// Below `md` the nav links used to just disappear with no hamburger to
// reach them at all — this restores them behind a mobile menu button so
// the landing page top bar is actually usable on a phone, not just on
// desktop widths.
export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-visiyon-bg border-b border-visiyon-border">
      <nav className="max-w-6xl mx-auto h-16 px-4 sm:px-6 flex items-center justify-between">
        <Link href="/" onClick={() => setMobileOpen(false)}>
          <Logo showText />
        </Link>
        <div className="hidden md:flex items-center gap-8 text-sm text-visiyon-text-2">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="hover:text-visiyon-text transition-colors">
              {l.label}
            </a>
          ))}
        </div>
        <div className="hidden md:flex items-center gap-3">
          <Link href="/login" className="text-sm text-visiyon-text-2 hover:text-visiyon-text transition-colors">
            Log in
          </Link>
          <Link
            href="/"
            className="inline-flex items-center justify-center text-sm font-medium px-4 py-2 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text visiyon-btn-primary transition-colors"
          >
            Start chatting
          </Link>
        </div>
        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="md:hidden p-2 -mr-2 text-visiyon-text-2 hover:text-visiyon-text transition-colors"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </nav>

      {mobileOpen && (
        <div className="md:hidden border-t border-visiyon-border bg-visiyon-bg px-4 py-4 flex flex-col gap-1">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setMobileOpen(false)}
              className="px-2 py-2.5 text-sm text-visiyon-text-2 hover:text-visiyon-text transition-colors"
            >
              {l.label}
            </a>
          ))}
          <div className="mt-2 pt-3 border-t border-visiyon-border flex flex-col gap-2">
            <Link
              href="/login"
              onClick={() => setMobileOpen(false)}
              className="px-2 py-2.5 text-sm text-visiyon-text-2 hover:text-visiyon-text transition-colors"
            >
              Log in
            </Link>
            <Link
              href="/"
              onClick={() => setMobileOpen(false)}
              className="inline-flex items-center justify-center text-sm font-medium px-4 py-2.5 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text transition-colors"
            >
              Start chatting
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
