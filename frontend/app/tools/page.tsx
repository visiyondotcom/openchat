"use client";

import Link from "next/link";
import { useState } from "react";
import { useRequireAuth } from "@/lib/useAuth";
import UserMenu from "@/components/UserMenu";
import {
  Sparkles,
  Compass,
  FolderOpen,
  Grid3x3,
  Wand2,
  Video as VideoIcon,
  ImageIcon,
  Music,
  Clapperboard,
  UserSquare2,
  Scissors,
  Wand as WandIcon,
  Images,
  Sparkle,
  Mic2,
  Boxes,
  Type as TypeIcon,
  ImagePlus,
  Palette,
  PaintBucket,
  Maximize,
  Eraser,
  Shirt,
  UserCircle2,
  AudioLines,
  Menu,
} from "lucide-react";

// Same left-rail shape as /generate and /editor — kept as its own copy
// here too since the rail isn't a shared component across pages.
function RailIcon({
  icon,
  label,
  color,
  active,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
  active?: boolean;
  href?: string;
}) {
  const body = (
    <div
      className={`relative flex flex-col items-center gap-1 w-full py-2.5 rounded-xl transition-colors cursor-pointer ${
        active ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
      }`}
      title={label}
    >
      <div style={{ color: active ? "#fff" : color }}>{icon}</div>
      {label && (
        <span className={`text-[10px] leading-none ${active ? "text-white font-medium" : "text-visiyon-text-3"}`}>
          {label}
        </span>
      )}
    </div>
  );
  return href ? (
    <Link href={href} className="w-full">
      {body}
    </Link>
  ) : (
    body
  );
}

// ---- "All Tools" hub — the Kling-style grid every tool tile links out of.
// Tiles that map to something we've actually built (Generate's four tabs,
// the Photoshop editor, Music) are real links; everything else is an
// honest "Coming soon" tile rather than a fake button, same pattern the
// rest of the app uses (see RailIcon's disabledReason in /generate). ----

type Tile = {
  label: string;
  icon: React.ReactNode;
  href?: string;
  badge?: "HOT" | "NEW";
};

const VIDEO_TOOLS: Tile[] = [
  { label: "Text to Video", icon: <VideoIcon size={20} />, href: "/generate?modality=video" },
  { label: "Image to Video", icon: <ImagePlus size={20} />, href: "/generate?modality=video" },
  { label: "Image/Subject Reference", icon: <Images size={20} />, href: "/generate?modality=video" },
  { label: "Motion Control", icon: <UserSquare2 size={20} />, href: "/generate?modality=motion", badge: "HOT" },
  { label: "Digital Human", icon: <UserCircle2 size={20} />, href: "/generate?modality=avatar" },
  { label: "Smart Shot Segmentation", icon: <Scissors size={20} />, badge: "NEW" },
  { label: "Instruction Transformation", icon: <WandIcon size={20} /> },
  { label: "Video Reference", icon: <Clapperboard size={20} />, href: "/generate?modality=video" },
  { label: "Creative Effects", icon: <Sparkle size={20} /> },
  { label: "Lip Sync", icon: <Mic2 size={20} />, href: "/generate?modality=avatar" },
  { label: "Custom Model", icon: <Boxes size={20} /> },
];

const IMAGE_TOOLS: Tile[] = [
  { label: "Text to Image", icon: <TypeIcon size={20} />, href: "/generate?modality=image" },
  { label: "Image Reference", icon: <ImageIcon size={20} />, href: "/generate?modality=image" },
  { label: "Restyle", icon: <Palette size={20} /> },
  { label: "Inpaint", icon: <PaintBucket size={20} />, href: "/editor" },
  { label: "Image Expansion", icon: <Maximize size={20} />, href: "/editor" },
  { label: "Remove", icon: <Eraser size={20} />, href: "/editor" },
  { label: "Virtual Model", icon: <UserSquare2 size={20} /> },
  { label: "AI Outfit", icon: <Shirt size={20} /> },
];

const SOUND_TOOLS: Tile[] = [
  { label: "Text to Audio", icon: <Music size={20} />, href: "/music" },
  { label: "Video to Audio", icon: <AudioLines size={20} /> },
];

function ToolTile({ tile }: { tile: Tile }) {
  const body = (
    <div
      className={`group flex flex-col items-center gap-2 rounded-xl px-3 py-4 transition-colors ${
        tile.href ? "hover:bg-white/[0.06] cursor-pointer" : "opacity-45 cursor-not-allowed"
      }`}
    >
      <div className="relative h-11 w-11 rounded-xl bg-black/40 flex items-center justify-center text-visiyon-text-2 group-hover:text-white">
        {tile.icon}
        {tile.badge && (
          <span
            className={`absolute -top-2 -right-2 text-[8.5px] font-bold px-1 rounded ${
              tile.badge === "HOT" ? "text-orange-400" : "text-emerald-400"
            }`}
          >
            {tile.badge}
          </span>
        )}
      </div>
      <span className="text-[12px] text-center text-visiyon-text-2 leading-tight">{tile.label}</span>
      {!tile.href && <span className="text-[9.5px] text-visiyon-text-3">Coming soon</span>}
    </div>
  );
  return tile.href ? <Link href={tile.href}>{body}</Link> : body;
}

function Section({ title, tiles }: { title: string; tiles: Tile[] }) {
  return (
    <div className="space-y-3">
      <h2 className="text-[13.5px] font-semibold text-visiyon-text-1">{title}</h2>
      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-1.5">
        {tiles.map((t) => (
          <ToolTile key={t.label} tile={t} />
        ))}
      </div>
    </div>
  );
}

export default function ToolsPage() {
  const { ready } = useRequireAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  if (!ready) return null;

  return (
    <div className="h-screen w-screen bg-visiyon-bg text-visiyon-text-1 flex overflow-hidden">
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 sm:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        className={`fixed sm:static inset-y-0 left-0 z-40 w-[68px] shrink-0 h-full bg-visiyon-panel2 flex flex-col items-center py-3 gap-0.5 transition-transform duration-200 sm:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Link href="/chat" className="mb-3" onClick={() => setMobileNavOpen(false)}>
          <div className="h-8 w-8 rounded-full bg-visiyon-bg flex items-center justify-center">
            <Sparkles size={15} className="text-visiyon-accent" />
          </div>
        </Link>

        <div className="w-full px-1.5 flex flex-col gap-0.5">
          <RailIcon icon={<Compass size={18} />} label="Explore" color="#60a5fa" href="/explore" />
          <RailIcon icon={<FolderOpen size={18} />} label="Assets" color="#fbbf24" href="/assets" />
          <RailIcon icon={<Sparkles size={18} />} label="Generate" color="#f472b6" href="/generate" />
          <RailIcon icon={<Wand2 size={18} />} label="Photoshop" color="#22d3ee" href="/editor" />
          <RailIcon icon={<Clapperboard size={18} />} label="Video Edit" color="#a78bfa" href="/video-editor" />
          <RailIcon icon={<Grid3x3 size={18} />} label="All Tools" color="#94a3b8" active />
        </div>

        <div className="flex-1" />

        <div className="w-full px-1.5 flex flex-col gap-0.5 items-center">
          <UserMenu />
        </div>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-8">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="sm:hidden shrink-0 h-8 w-8 flex items-center justify-center rounded-lg hover:bg-white/5 text-visiyon-text-2"
            title="Menu"
          >
            <Menu size={18} />
          </button>
          <h1 className="text-[16px] font-semibold">All Tools</h1>
        </div>
        <Section title="Video Generation" tiles={VIDEO_TOOLS} />
        <Section title="Image Generation" tiles={IMAGE_TOOLS} />
        <Section title="Sound Generation" tiles={SOUND_TOOLS} />
      </div>
    </div>
  );
}
