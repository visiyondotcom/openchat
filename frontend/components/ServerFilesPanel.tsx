"use client";

import { useEffect, useState } from "react";
import { X, Folder, File as FileIcon, ChevronRight, RefreshCw, Loader2, HardDrive } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import {
  browseServerFiles,
  uploadGeneratedFileToServer,
  getServerConnection,
  RemoteFileEntry,
  GENERATED_FILE_DRAG_MIME,
} from "@/lib/api";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ServerFilesPanel() {
  const { serverPanelOpen, closeServerPanel } = useChatStore(
    useShallow((s) => ({
      serverPanelOpen: s.serverPanelOpen,
      closeServerPanel: s.closeServerPanel,
    }))
  );

  const [connected, setConnected] = useState<boolean | null>(null);
  const [cwd, setCwd] = useState(".");
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // Breadcrumb segments derived from cwd ("." at root, "foo/bar" two levels deep).
  const segments = cwd === "." ? [] : cwd.split("/").filter(Boolean);

  function load(path: string) {
    setLoading(true);
    setError(null);
    browseServerFiles(path)
      .then((res) => {
        setEntries(res.entries);
        setCwd(path);
      })
      .catch((err) => setError(err.message || "Could not list directory"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!serverPanelOpen) return;
    getServerConnection()
      .then((res) => {
        setConnected(Boolean(res.connection));
        if (res.connection) load(".");
      })
      .catch(() => setConnected(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPanelOpen]);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData(GENERATED_FILE_DRAG_MIME);
    if (!raw) return;
    try {
      const { token, filename } = JSON.parse(raw) as { token: string; filename: string };
      setUploadStatus(`Uploading ${filename}…`);
      await uploadGeneratedFileToServer(token, cwd);
      setUploadStatus(`Saved ${filename} to server`);
      load(cwd);
    } catch (err: any) {
      setUploadStatus(err.message || "Upload failed");
    } finally {
      setTimeout(() => setUploadStatus(null), 3000);
    }
  }

  if (!serverPanelOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-visiyon-panel lg:static lg:z-auto lg:flex lg:flex-col lg:w-[380px] shrink-0 h-full border-l border-visiyon-border">
      <div className="h-16 flex items-center justify-between px-4 border-b border-visiyon-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <HardDrive size={16} className="text-visiyon-text-3 shrink-0" />
          <span className="text-[13.5px] font-medium truncate">Server files</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => load(cwd)} className="p-1.5 text-visiyon-text-3 hover:text-visiyon-text transition-colors" title="Refresh">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={closeServerPanel} className="p-1.5 text-visiyon-text-3 hover:text-visiyon-text transition-colors" title="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      {connected === false ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <HardDrive size={24} className="text-visiyon-text-3" />
          <p className="text-[13px] text-visiyon-text-3">
            No server connected yet. Connect one in Settings → Server to browse and save files here.
          </p>
        </div>
      ) : (
        <>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 px-4 py-2.5 text-[12.5px] text-visiyon-text-3 overflow-x-auto border-b border-visiyon-border shrink-0">
            <button onClick={() => load(".")} className="hover:text-visiyon-text transition-colors shrink-0">
              root
            </button>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1 shrink-0">
                <ChevronRight size={12} />
                <button
                  onClick={() => load(segments.slice(0, i + 1).join("/"))}
                  className="hover:text-visiyon-text transition-colors"
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>

          {/* Drop zone / listing */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (e.dataTransfer.types.includes(GENERATED_FILE_DRAG_MIME)) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex-1 overflow-y-auto transition-colors ${dragOver ? "bg-visiyon-text/[0.06]" : ""}`}
          >
            {loading ? (
              <div className="flex items-center justify-center py-10 text-visiyon-text-3">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : error ? (
              <p className="text-[12.5px] text-red-400 px-4 py-4">{error}</p>
            ) : entries.length === 0 ? (
              <p className="text-[12.5px] text-visiyon-text-3 px-4 py-6 text-center">
                Empty directory. Drag a file the AI generated in the chat here to save it.
              </p>
            ) : (
              <div className="py-1">
                {entries.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => entry.type === "dir" && load(cwd === "." ? entry.name : `${cwd}/${entry.name}`)}
                    disabled={entry.type !== "dir"}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-left transition-colors ${
                      entry.type === "dir" ? "hover:bg-visiyon-text/[0.05] cursor-pointer" : "cursor-default"
                    }`}
                  >
                    {entry.type === "dir" ? (
                      <Folder size={15} className="text-visiyon-text-3 shrink-0" />
                    ) : (
                      <FileIcon size={15} className="text-visiyon-text-3 shrink-0" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    {entry.type !== "dir" && (
                      <span className="text-[11px] text-visiyon-text-3 shrink-0">{formatSize(entry.size)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {dragOver && (
              <div className="pointer-events-none sticky bottom-0 left-0 right-0 px-4 py-3 bg-white text-black text-[12.5px] font-medium text-center">
                Drop to save here
              </div>
            )}
          </div>

          {uploadStatus && (
            <div className="px-4 py-2 text-[12px] text-visiyon-text-2 border-t border-visiyon-border shrink-0">{uploadStatus}</div>
          )}
        </>
      )}
    </div>
  );
}
