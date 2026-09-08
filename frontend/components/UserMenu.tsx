"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { User, FileText, Rocket, Globe, Smartphone, ShieldCheck, Settings, LogOut } from "lucide-react";
import { logout } from "@/lib/api";
import { useRequireAuth } from "@/lib/useAuth";

// Account-avatar dropdown used on /generate (and anywhere else that wants
// the same menu). Matches the reference: Blog, Quick Start, Switch
// Language, Multi-Platform App Download, Policies and Agreements,
// Profile Settings, Sign Out. Profile Settings, Policies and Agreements,
// and Sign Out are wired to real pages/actions today — the rest are
// marked "Coming soon" rather than silently doing nothing.
export default function UserMenu() {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  // Reads the same shared cache SettingsContent writes to on avatar
  // upload/remove, so the photo shown here always matches whatever the
  // user last set on their profile — no separate copy to fall out of
  // sync.
  const { user } = useRequireAuth();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function toggleOpen() {
    if (!open && btnRef.current) {
      // The rail sits inside an overflow-hidden flex layout, so a
      // right-0-anchored absolute dropdown gets clipped off-screen to the
      // left (68px-wide rail, 256px-wide menu). Position it with fixed
      // coords computed from the button instead, so it always renders
      // next to the rail regardless of ancestor overflow/width.
      const rect = btnRef.current.getBoundingClientRect();
      setCoords({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom });
    }
    setOpen((v) => !v);
  }

  function handleLogout() {
    logout();
    router.push("/login");
  }

  const items: Array<{ icon: React.ReactNode; label: string; onClick: () => void; comingSoon?: boolean }> = [
    { icon: <FileText size={14} />, label: "Blog", onClick: () => {}, comingSoon: true },
    { icon: <Rocket size={14} />, label: "Quick Start", onClick: () => {}, comingSoon: true },
    { icon: <Globe size={14} />, label: "Switch Language", onClick: () => {}, comingSoon: true },
    { icon: <Smartphone size={14} />, label: "Multi-Platform App Download", onClick: () => {}, comingSoon: true },
    { icon: <ShieldCheck size={14} />, label: "Policies and Agreements", onClick: () => router.push("/policies") },
    { icon: <Settings size={14} />, label: "Profile Settings", onClick: () => router.push("/settings") },
  ];

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggleOpen}
        className="h-8 w-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-visiyon-text overflow-hidden"
        title="Account"
      >
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <User size={16} />
        )}
      </button>

      {open && coords && (
        <div
          ref={menuRef}
          style={{ position: "fixed", left: coords.left, bottom: coords.bottom }}
          className="w-64 rounded-xl border border-visiyon-border bg-visiyon-panel2 shadow-xl py-1.5 text-[13px] z-[100]"
        >
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => {
                it.onClick();
                if (!it.comingSoon) setOpen(false);
              }}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-2 hover:bg-white/5 text-visiyon-text-2 text-left"
            >
              <span className="flex items-center gap-2.5">
                {it.icon}
                {it.label}
              </span>
              {it.comingSoon && <span className="text-[10px] text-visiyon-text-3">Coming soon</span>}
            </button>
          ))}
          <div className="my-1.5 border-t border-visiyon-border" />
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-white/5 text-red-400 text-left"
          >
            <LogOut size={14} />
            Sign Out
          </button>
        </div>
      )}
    </>
  );
}

