"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

// Full-screen embed of the OpenCut video editor (opencut.app). OpenCut is a
// separate hosted app with no public "import by URL" API, so a generated
// video can't be piped in automatically — the "Send to Video Edit" button
// on /generate downloads the clip first, then lands here so the user can
// drag that download straight into OpenCut's Assets panel.
export default function VideoEditorPage() {
  return (
    <div className="h-screen w-screen flex flex-col bg-visiyon-bg">
      <header className="shrink-0 h-11 flex items-center gap-3 px-3 border-b border-visiyon-border bg-visiyon-panel2">
        <Link href="/generate" className="text-visiyon-text-2 hover:text-visiyon-text transition-colors" title="Back">
          <ArrowLeft size={16} />
        </Link>
        <span className="text-[12.5px] text-visiyon-text-2">Video Editor</span>
        <div className="flex-1" />
        <a
          href="https://opencut.app/projects"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[12px] text-visiyon-text-3 hover:text-visiyon-text-2"
          title="Open in a new tab"
        >
          <ExternalLink size={12} />
          Open in new tab
        </a>
      </header>
      <iframe
        src="https://opencut.app/projects"
        title="OpenCut video editor"
        className="flex-1 w-full border-0"
        allow="camera; microphone; clipboard-write; fullscreen"
      />
    </div>
  );
}
