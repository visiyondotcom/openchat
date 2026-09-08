"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Logo from "./Logo";
import { askPrompt, askConfirm } from "./PromptDialog";
import { useChatStore, readStoredSidebarCollapsed } from "@/lib/store";
import { useRequireAuth } from "@/lib/useAuth";
import { useShallow } from "zustand/react/shallow";
import {
  listChats,
  createChat,
  pinChat,
  archiveChat,
  deleteChat,
  renameChat,
  logout,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveChatToFolder,
  getMe,
  getPublicConfigCached,
  listStudioProjects,
  Folder,
  PublicFeatureFlags,
  StudioProject,
} from "@/lib/api";
import {
  Pin,
  Trash2,
  Pencil,
  Plus,
  Search,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Settings,
  X,
  Hash,
  StickyNote,
  Bot,
  Swords,
  Code2,
  PanelLeftClose,
  LogOut,
  ShieldCheck,
  Music,
  Archive,
  ArchiveRestore,
  Users,
  Brain,
  Sparkles,
  ArrowUpRight,
  SlidersHorizontal,
  MoreVertical,
  ExternalLink,
  EyeOff,
  Layers,
  FolderOpen,
  Check,
} from "lucide-react";

interface ChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  folderId?: string | null;
  _count?: { messages: number };
}

// Unread tracking is purely local (no backend/schema change): for each
// chat we remember how many messages it had the last time this browser
// actually viewed it. A badge shows when the chat's current message count
// (from listChats' _count.messages, already returned by the backend) is
// higher than that — which happens whenever a message landed in a chat the
// user *isn't* currently looking at: an Automation posting in the
// background, another tab/device, or a streamed reply that finished after
// the user navigated away mid-generation.
const READ_COUNTS_KEY = "visiyon_chat_read_counts";

function readReadCounts(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(READ_COUNTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function markChatRead(chatId: string, count: number) {
  if (typeof window === "undefined") return;
  const map = readReadCounts();
  if (map[chatId] === count) return;
  map[chatId] = count;
  window.localStorage.setItem(READ_COUNTS_KEY, JSON.stringify(map));
}

// "Mark as unread" from the row menu: sets the seen-count one below the
// chat's actual message count so exactly one unread badge shows, same as
// if a new message had just landed while the chat wasn't open.
function markChatUnread(chatId: string, currentCount: number) {
  if (typeof window === "undefined") return;
  const map = readReadCounts();
  map[chatId] = Math.max(0, currentCount - 1);
  window.localStorage.setItem(READ_COUNTS_KEY, JSON.stringify(map));
}

function unreadCount(chat: ChatSummary): number {
  const total = chat._count?.messages ?? 0;
  const seen = readReadCounts()[chat.id] ?? total;
  return Math.max(0, total - seen);
}

// Shared easing logic behind the sidebar's per-row generation indicator.
// There's no real token budget to measure against, so this eases toward
// ~92% while active; once generation finishes it jumps to 100% and stays
// visible for a moment (fading out) instead of vanishing the instant
// streaming stops, so the "done" state is actually seen.
function useSidebarGenerationPct(active: boolean) {
  const [pct, setPct] = useState(4);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) return;
    setPct(4);
    setVisible(true);
    const id = setInterval(() => {
      setPct((p) => Math.min(92, p + (92 - p) * 0.06 + 0.4));
    }, 180);
    return () => clearInterval(id);
  }, [active]);

  // On the active -> done transition: snap to 100%, hold it fully visible
  // for a moment so "done" is actually seen, then fade out.
  const prevActiveRef = useRef(active);
  const [done, setDone] = useState(false);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (wasActive && !active) {
      setPct(100);
      setDone(true);
      setFading(false);
      const fadeStartId = setTimeout(() => setFading(true), 1000);
      const hideId = setTimeout(() => setVisible(false), 1500);
      return () => {
        clearTimeout(fadeStartId);
        clearTimeout(hideId);
      };
    }
    if (active) {
      setDone(false);
      setFading(false);
    }
  }, [active]);

  return { pct: Math.round(pct), visible, done, fading };
}

// ---- SidebarGenerationProgress -----------------------------------------
// Thin bottom-edge progress line on the active chat's sidebar row, shown
// while that chat is generating.
function SidebarGenerationProgress({ active }: { active: boolean }) {
  const { pct: clamped, visible, done, fading } = useSidebarGenerationPct(active);

  if (!visible) return null;

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute -bottom-1.5 left-2 right-2 h-[2px] rounded-full bg-white/[0.06] overflow-hidden transition-opacity duration-500 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-out ${
          done ? "bg-emerald-400" : "bg-gradient-to-r from-emerald-500/30 to-emerald-400/90"
        }`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

// ---- SidebarGenerationRing ----------------------------------------------
// Small ring + percentage badge shown inline next to the chat title while
// generating — takes the place of the old plain spinner icon there, so the
// title row shows actual progress instead of an indeterminate loader.
function SidebarGenerationRing({ active }: { active: boolean }) {
  const { pct: clamped, visible } = useSidebarGenerationPct(active);
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - clamped / 100);

  if (!visible) return null;

  return (
    <span className="relative inline-block h-[14px] w-[14px] shrink-0" title={`${clamped}%`}>
      <svg viewBox="0 0 18 18" className="h-[14px] w-[14px] -rotate-90">
        <circle cx="9" cy="9" r={r} fill="rgba(15,20,18,0.6)" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="rgb(52,211,153)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-200 ease-out"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[5px] font-medium text-emerald-300">
        {clamped}
      </span>
    </span>
  );
}

export default function Sidebar({ activeId, model }: { activeId?: string; model: string }) {
  const { mobileSidebarOpen, setMobileSidebarOpen, desktopSidebarCollapsed, setDesktopSidebarCollapsed, chatListVersion, isStreaming, isGeneratingImage, openSettings, openSearch, setChatTitle } = useChatStore(
    useShallow((s) => ({
      mobileSidebarOpen: s.mobileSidebarOpen,
      setMobileSidebarOpen: s.setMobileSidebarOpen,
      desktopSidebarCollapsed: s.desktopSidebarCollapsed,
      setDesktopSidebarCollapsed: s.setDesktopSidebarCollapsed,
      chatListVersion: s.chatListVersion,
      isStreaming: s.isStreaming,
      isGeneratingImage: s.isGeneratingImage,
      openSettings: s.openSettings,
      openSearch: s.openSearch,
      setChatTitle: s.setChatTitle,
    }))
  );
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Archived chats aren't in the regular list at all (backend only
  // returns them when asked with ?archived=true) — before this there was
  // nowhere in the UI to see them again once archived, so they were
  // effectively lost. This loads them on demand when the section below
  // is expanded.
  const [showArchived, setShowArchived] = useState(false);
  const [archivedChats, setArchivedChats] = useState<ChatSummary[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The "⋯" context menu on each chat row (screenshot-matched: Open in new
  // tab / Pin / Mark as unread / Rename / Add to project / Move to group /
  // Delete). Only one open at a time. "submenu" tracks whether the
  // Add-to-project or Move-to-group flyout is showing within that menu.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuSubmenu, setMenuSubmenu] = useState<"project" | "group" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // "Group by" control next to "Chats and tasks" — None shows one flat,
  // most-recent-first list; Folder keeps the existing folder sections.
  const [groupBy, setGroupBy] = useState<"none" | "folder">("folder");
  const [groupByOpen, setGroupByOpen] = useState(false);
  const groupByRef = useRef<HTMLDivElement>(null);
  // Read from the shared auth cache instead of fetching+storing a private
  // copy — that private copy never saw a profile-photo change made
  // elsewhere in the app (e.g. /settings) until a full page reload.
  const { user: me } = useRequireAuth();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // Drag-to-resize (desktop only): width is persisted per-browser like the
  // theme/collapsed state, clamped to a sane range so the sidebar can't be
  // dragged so narrow that labels clip or so wide it eats the chat area.
  const SIDEBAR_MIN_WIDTH = 220;
  const SIDEBAR_MAX_WIDTH = 420;
  const SIDEBAR_DEFAULT_WIDTH = 288;
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const stored = Number(localStorage.getItem("visiyon:sidebarWidth"));
    if (stored && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH) {
      setSidebarWidth(stored);
    }
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    function onMouseMove(e: MouseEvent) {
      if (!resizeStartRef.current) return;
      const delta = e.clientX - resizeStartRef.current.startX;
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, resizeStartRef.current.startWidth + delta)
      );
      setSidebarWidth(next);
    }
    function onMouseUp() {
      setIsResizing(false);
      resizeStartRef.current = null;
      setSidebarWidth((w) => {
        localStorage.setItem("visiyon:sidebarWidth", String(w));
        return w;
      });
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    // A "fixed inset-0" click-catcher doesn't work here: the <aside> below
    // has a transform (translate-x, for the mobile slide-in animation),
    // and any transform on an ancestor makes it the containing block for
    // fixed-position descendants — so that overlay would only cover the
    // sidebar's own box, not the full page, and clicks in the main chat
    // area would never close this menu. A real document listener has no
    // such containing-block issue.
    function onMouseDown(e: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!openMenuId) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
        setMenuSubmenu(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openMenuId]);

  useEffect(() => {
    if (!groupByOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (groupByRef.current && !groupByRef.current.contains(e.target as Node)) {
        setGroupByOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [groupByOpen]);
  // Admin-controlled — Admin > Settings > General > "Sidebar &
  // navigation". Defaults to all-true so the sidebar looks unchanged
  // while the request for public-config is still in flight.
  const [features, setFeatures] = useState<PublicFeatureFlags>({
    playground: true,
    studio: true,
    arena: true,
    music: false,
    generate: false,
    channels: true,
    notes: true,
    automations: true,
    upgradeButton: true,
    documentUpload: true,
    imageUpload: true,
    toolsMenu: true,
    cameraCapture: true,
    screenShare: true,
    greetingLogo: true,
    aiFaceAvatar: true,
    notifyBanner: true,
    chatControlsButton: true,
    apiKeysTab: true,
  });
  const router = useRouter();

  // Projects the user owns or was invited to collaborate on (Studio).
  // Fetched once up front so the sidebar can show shared-with-you
  // projects without the user having to open Studio first.
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);

  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setFeatures(c.features))
      .catch(() => {});
    listStudioProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
  }, []);

  async function refresh(q?: string) {
    try {
      const list = await listChats(q);
      setChats(list);
      // Keep the shared title map current so the header dropdown (which
      // reads from the store) reflects any title change picked up here —
      // e.g. the backend auto-titling a brand-new chat from its first
      // exchange — without needing its own separate fetch.
      for (const c of list) setChatTitle(c.id, c.title);
    } catch {
      /* not logged in yet — leave empty */
    }
  }

  async function refreshFolders() {
    try {
      setFolders(await listFolders());
    } catch {
      /* not logged in yet */
    }
  }

  async function refreshArchived() {
    setArchivedLoading(true);
    try {
      setArchivedChats(await listChats(undefined, true));
    } catch {
      /* not logged in yet */
    } finally {
      setArchivedLoading(false);
    }
  }

  async function toggleArchived() {
    const next = !showArchived;
    setShowArchived(next);
    if (next) refreshArchived();
  }

  async function handleUnarchive(chatId: string) {
    await archiveChat(chatId, false);
    refreshArchived();
    refresh(query || undefined);
  }

  useEffect(() => {
    refresh();
    refreshFolders();
    if (readStoredSidebarCollapsed()) setDesktopSidebarCollapsed(true);
  }, []);

  // Whenever the list refreshes, immediately mark the chat currently open
  // in the main pane as read at its latest message count — otherwise its
  // own new messages (the ones the user is actively watching stream in)
  // would incorrectly show up as "unread" the next time this chat drops
  // out of view.
  useEffect(() => {
    if (!activeId) return;
    const active = chats.find((c) => c.id === activeId);
    if (active) markChatRead(active.id, active._count?.messages ?? 0);
  }, [activeId, chats]);

  useEffect(() => {
    if (chatListVersion > 0) refresh(query || undefined);
    if (chatListVersion > 0 && showArchived) refreshArchived();
  }, [chatListVersion]);

  // Light polling so a message that lands in the background (an Automation
  // posting to a chat that isn't open, another tab/device) shows its unread
  // badge without requiring the user to trigger a refresh themselves.
  useEffect(() => {
    const t = setInterval(() => refresh(query || undefined), 15000);
    return () => clearInterval(t);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => refresh(query || undefined), 250);
    return () => clearTimeout(t);
  }, [query]);

  async function handleNewChat() {
    const chat = await createChat(model);
    router.push(`/chat/${chat.id}`);
    setMobileSidebarOpen(false);
    refresh();
  }

  async function handleNewFolder() {
    const name = await askPrompt({ title: "New folder", label: "Folder name", placeholder: "e.g. Work" });
    if (!name) return;
    await createFolder(name);
    refreshFolders();
  }

  function toggleCollapsed(folderId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  async function handleMove(chatId: string, folderId: string | null) {
    await moveChatToFolder(chatId, folderId);
    refresh(query || undefined);
    refreshFolders();
  }

  function renderChatRow(c: ChatSummary) {
    const unread = c.id === activeId ? 0 : unreadCount(c);
    return (
      <div
        key={c.id}
        className={`group relative flex items-center justify-between rounded-xl px-3 py-2 text-[13.5px] cursor-pointer ${
          c.id === activeId ? "bg-visiyon-text/[0.08]" : "hover:bg-visiyon-text/[0.04]"
        }`}
      >
        {c.id === activeId && <SidebarGenerationProgress active={isStreaming || isGeneratingImage} />}
        <Link href={`/chat/${c.id}`} className="truncate flex-1 flex items-center gap-1.5" onClick={() => setMobileSidebarOpen(false)}>
          {c.pinned && <Pin size={11} className="inline -mt-0.5 shrink-0" />}
          {unread > 0 && (
            <span className="relative shrink-0 flex h-2 w-2" title="New message">
              <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          )}
          <span className="truncate">{c.title}</span>
          {c.id === activeId && (isStreaming || isGeneratingImage) && (
            <SidebarGenerationRing active={isStreaming || isGeneratingImage} />
          )}
        </Link>
        <div className="relative flex items-center gap-1.5 text-visiyon-text-3 shrink-0">
          <button
            onClick={(e) => {
              e.preventDefault();
              setOpenMenuId(openMenuId === c.id ? null : c.id);
              setMenuSubmenu(null);
            }}
            title="More"
            className={`cursor-pointer flex items-center justify-center h-6 w-6 rounded-md hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors ${
              openMenuId === c.id ? "bg-visiyon-text/10 text-visiyon-text" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <MoreVertical size={14} />
          </button>

          {openMenuId === c.id && (
            <div
              ref={menuRef}
              className="absolute top-full right-0 mt-1 w-56 bg-visiyon-panel border border-visiyon-border rounded-2xl overflow-hidden z-40 visiyon-elevated-lg py-1.5"
            >
              {menuSubmenu === null && (
                <>
                  <button
                    onClick={() => {
                      window.open(`/chat/${c.id}`, "_blank");
                      setOpenMenuId(null);
                    }}
                    className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <ExternalLink size={15} /> Open in new tab
                    </span>
                  </button>
                  <button
                    onClick={async () => {
                      await pinChat(c.id, !c.pinned);
                      refresh(query || undefined);
                      setOpenMenuId(null);
                    }}
                    className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <Pin size={15} /> {c.pinned ? "Unpin" : "Pin"}
                    </span>
                    <span className="text-[11.5px] text-visiyon-text-3">P</span>
                  </button>
                  <button
                    onClick={() => {
                      markChatUnread(c.id, c._count?.messages ?? 0);
                      refresh(query || undefined);
                      setOpenMenuId(null);
                    }}
                    className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <EyeOff size={15} /> Mark as unread
                    </span>
                    <span className="text-[11.5px] text-visiyon-text-3">U</span>
                  </button>
                  <button
                    onClick={async () => {
                      const title = await askPrompt({ title: "Rename chat", label: "Title", defaultValue: c.title });
                      setOpenMenuId(null);
                      if (title) {
                        setChatTitle(c.id, title);
                        await renameChat(c.id, title);
                        refresh(query || undefined);
                      }
                    }}
                    className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <Pencil size={15} /> Rename
                    </span>
                    <span className="text-[11.5px] text-visiyon-text-3">R</span>
                  </button>
                  {features.studio && (
                    <button
                      onClick={() => setMenuSubmenu("project")}
                      className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                    >
                      <span className="flex items-center gap-2.5">
                        <Layers size={15} /> Add to project
                      </span>
                      <ChevronRight size={14} className="text-visiyon-text-3" />
                    </button>
                  )}
                  <button
                    onClick={() => setMenuSubmenu("group")}
                    className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <FolderOpen size={15} /> Move to group
                    </span>
                    <ChevronRight size={14} className="text-visiyon-text-3" />
                  </button>
                  <div className="my-1 border-t border-visiyon-border" />
                  <button
                    onClick={async () => {
                      setOpenMenuId(null);
                      if (await askConfirm({ title: "Delete this chat?", confirmLabel: "Delete", danger: true })) {
                        await deleteChat(c.id);
                        if (c.id === activeId) router.push("/");
                        refresh(query || undefined);
                      }
                    }}
                    className="cursor-pointer w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-[13px] text-red-500 hover:bg-red-500/[0.08] transition-colors"
                  >
                    <span className="flex items-center gap-2.5">
                      <Trash2 size={15} /> Delete
                    </span>
                    <span className="text-[11.5px] text-red-500/60">D</span>
                  </button>
                </>
              )}

              {menuSubmenu === "group" && (
                <>
                  <button
                    onClick={() => setMenuSubmenu(null)}
                    className="cursor-pointer w-full flex items-center gap-1.5 px-3.5 py-2 text-[12.5px] text-visiyon-text-3 hover:text-visiyon-text transition-colors"
                  >
                    <ChevronRight size={13} className="rotate-180" /> Back
                  </button>
                  <button
                    onClick={() => {
                      handleMove(c.id, null);
                      setOpenMenuId(null);
                      setMenuSubmenu(null);
                    }}
                    className="cursor-pointer w-full text-left px-3.5 py-2 text-[13px] hover:bg-visiyon-text/[0.06] text-visiyon-text-2"
                  >
                    No group
                  </button>
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        handleMove(c.id, f.id);
                        setOpenMenuId(null);
                        setMenuSubmenu(null);
                      }}
                      className="cursor-pointer w-full text-left px-3.5 py-2 text-[13px] hover:bg-visiyon-text/[0.06] truncate"
                    >
                      {f.name}
                    </button>
                  ))}
                </>
              )}

              {menuSubmenu === "project" && (
                <>
                  <button
                    onClick={() => setMenuSubmenu(null)}
                    className="cursor-pointer w-full flex items-center gap-1.5 px-3.5 py-2 text-[12.5px] text-visiyon-text-3 hover:text-visiyon-text transition-colors"
                  >
                    <ChevronRight size={13} className="rotate-180" /> Back
                  </button>
                  {projects.length === 0 ? (
                    <p className="px-3.5 py-2 text-[12.5px] text-visiyon-text-3">No projects yet</p>
                  ) : (
                    projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          // Chat↔project linking isn't wired up on the
                          // backend yet — this just closes the menu for
                          // now so the UI doesn't dead-end.
                          setOpenMenuId(null);
                          setMenuSubmenu(null);
                        }}
                        className="cursor-pointer w-full text-left px-3.5 py-2 text-[13px] hover:bg-visiyon-text/[0.06] truncate"
                      >
                        {p.name}
                      </button>
                    ))
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const unfoldered = chats.filter((c) => !c.folderId);

  return (
    <>
      {/* Backdrop — mobile only, closes the drawer on tap */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <aside
        style={{ width: sidebarWidth }}
        className={`shrink-0 h-full flex flex-col bg-visiyon-panel border-r border-visiyon-border visiyon-elevated-sm
          fixed inset-y-0 left-0 z-50
          ${isResizing ? "" : "transition-all duration-200"}
          lg:sticky lg:top-0 lg:translate-x-0
          ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"}
          ${desktopSidebarCollapsed ? "lg:!w-0 lg:opacity-0 lg:pointer-events-none lg:overflow-hidden" : ""}`}
      >
        {/* Drag-to-resize handle — a thin invisible hit-zone straddling the
            right edge (wider than the visible border so it's actually
            grabbable), only shown/active on desktop where the sidebar is
            docked rather than a mobile slide-in overlay. */}
        {!desktopSidebarCollapsed && (
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              resizeStartRef.current = { startX: e.clientX, startWidth: sidebarWidth };
              setIsResizing(true);
            }}
            onDoubleClick={() => {
              setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
              localStorage.setItem("visiyon:sidebarWidth", String(SIDEBAR_DEFAULT_WIDTH));
            }}
            title="Drag to resize"
            className="hidden lg:block absolute top-0 right-[-3px] w-1.5 h-full cursor-col-resize z-10 group"
          >
            <div
              className={`w-px h-full mx-auto transition-colors ${
                isResizing ? "bg-visiyon-text/40" : "bg-transparent group-hover:bg-visiyon-text/25"
              }`}
            />
          </div>
        )}
        <div className="p-4 flex items-center justify-between">
          <Link href="/">
            <Logo size={18} showText />
          </Link>
          <div className="flex items-center gap-1">
            <button
              onClick={openSearch}
              className="text-visiyon-text-2 hover:text-visiyon-text p-1"
              title="Search chats"
            >
              <Search size={18} />
            </button>
            <button
              onClick={() => setDesktopSidebarCollapsed(true)}
              className="hidden lg:block text-visiyon-text-2 hover:text-visiyon-text p-1"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
            <button
              onClick={() => setMobileSidebarOpen(false)}
              className="lg:hidden text-visiyon-text-2 hover:text-visiyon-text p-1"
              title="Close menu"
            >
              <X size={18} />
            </button>
          </div>
        </div>

      <div className="px-3">
        <button
          onClick={handleNewChat}
          className="w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-visiyon-text/[0.06] hover:bg-visiyon-text/10 transition-colors"
        >
          <Plus size={16} /> New chat
        </button>
        {features.playground && (
          <Link
            href="/playground"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <FlaskConical size={16} /> Playground
          </Link>
        )}
        {features.channels && (
          <Link
            href="/channels"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Hash size={16} /> Channels
          </Link>
        )}
        {features.notes && (
          <Link
            href="/notes"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <StickyNote size={16} /> Notes
          </Link>
        )}
        {features.studio && (
          <div className="mt-0.5">
            <div className="flex items-center rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors">
              <Link
                href="/studio"
                className="flex-1 flex items-center gap-2 text-sm font-medium px-3 py-1.5 min-w-0"
              >
                <Code2 size={16} /> Projects
              </Link>
              {projects.length > 0 && (
                <button
                  onClick={() => setProjectsOpen((v) => !v)}
                  className="px-2 py-1.5 shrink-0"
                  title={projectsOpen ? "Collapse projects" : "Expand projects"}
                >
                  {projectsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              )}
            </div>
            {projectsOpen && (
              <div className="mt-0.5 ml-2 pl-3 border-l border-visiyon-border space-y-0.5">
                {projects.map((p) => (
                  <Link
                    key={p.id}
                    href={`/studio?project=${p.id}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
                  >
                    <span className="truncate">{p.name}</span>
                    {p.role !== "OWNER" ? (
                      <span title="Shared with you" className="shrink-0 opacity-70 flex">
                        <Users size={12} />
                      </span>
                    ) : p.members.length > 0 ? (
                      <span className="text-[11px] opacity-70 shrink-0">{p.members.length}</span>
                    ) : null}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
        {features.automations && (
          <Link
            href="/automations"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Bot size={16} /> Automations
          </Link>
        )}
        {features.arena && (
          <Link
            href="/arena"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Swords size={16} /> Arena
          </Link>
        )}
        {features.music && (
          <Link
            href="/music"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Music size={16} /> Music
          </Link>
        )}
        {features.generate && (
          <Link
            href="/generate"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Sparkles size={16} /> Generate
          </Link>
        )}
      </div>

      <div className="px-3 mt-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-visiyon-border text-visiyon-text-2">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            autoComplete="off"
            name="sidebar-chat-search"
            className="bg-transparent outline-none text-[13px] w-full placeholder:text-visiyon-text-3"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto mt-3 px-3 pb-4">
        <div className="flex items-center justify-between px-1 mb-1">
          <button className="flex items-center gap-1 text-[13px] font-medium text-visiyon-text hover:text-visiyon-text/80 transition-colors">
            Chats and tasks <ChevronDown size={14} className="text-visiyon-text-3" />
          </button>
          <div className="flex items-center gap-2.5 text-visiyon-text-3">
            <button
              onClick={() => window.open("/", "_blank")}
              title="Open in new view"
              className="cursor-pointer hover:text-visiyon-text transition-colors"
            >
              <ArrowUpRight size={14} />
            </button>
            <div className="relative" ref={groupByRef}>
              <button
                onClick={() => setGroupByOpen((v) => !v)}
                title="Sort / group"
                className={`cursor-pointer transition-colors ${groupByOpen ? "text-visiyon-text" : "hover:text-visiyon-text"}`}
              >
                <SlidersHorizontal size={14} />
              </button>
              {groupByOpen && (
                <div className="absolute top-full right-0 mt-1.5 w-44 bg-visiyon-panel border border-visiyon-border rounded-xl overflow-hidden z-40 visiyon-elevated-lg py-1">
                  <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-visiyon-text-3">Group by</div>
                  {(["none", "folder"] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => {
                        setGroupBy(opt);
                        setGroupByOpen(false);
                      }}
                      className="cursor-pointer w-full flex items-center justify-between gap-2 px-3 py-2 text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                    >
                      <span>{opt === "none" ? "None" : "Folder"}</span>
                      {groupBy === opt && <Check size={14} className="text-visiyon-text" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-0.5 mb-3">
          <button
            onClick={() => openSettings("memory")}
            className="cursor-pointer w-full flex items-center justify-between gap-2 px-1.5 py-1.5 rounded-lg text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.04] hover:text-visiyon-text transition-colors"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Brain size={15} className="shrink-0" />
              <span className="truncate">Import memory</span>
            </span>
            <span className="shrink-0 text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-sky-500/15 text-sky-400">
              Try
            </span>
          </button>
          <button
            onClick={() => openSettings("general")}
            className="cursor-pointer w-full flex items-center justify-between gap-2 px-1.5 py-1.5 rounded-lg text-[13px] text-visiyon-text-2 hover:bg-visiyon-text/[0.04] hover:text-visiyon-text transition-colors"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Sparkles size={15} className="shrink-0" />
              <span className="truncate">Customize for you</span>
            </span>
            <span className="shrink-0 text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-sky-500/15 text-sky-400">
              Try
            </span>
          </button>
        </div>

        {groupBy === "folder" ? (
          <>
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-[11px] uppercase tracking-wide text-visiyon-text-3">Folders</span>
              <button onClick={handleNewFolder} title="New folder" className="cursor-pointer text-visiyon-text-3 hover:text-visiyon-text">
                <FolderPlus size={13} />
              </button>
            </div>

            <div className="space-y-1 mb-3">
              {folders.map((f) => {
                const isCollapsed = collapsed.has(f.id);
                const folderChats = chats.filter((c) => c.folderId === f.id);
                return (
                  <div key={f.id}>
                    <div className="group flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-visiyon-text/[0.04]">
                      <button
                        onClick={() => toggleCollapsed(f.id)}
                        className="cursor-pointer flex items-center gap-1.5 flex-1 min-w-0 text-[13px] text-visiyon-text-2"
                      >
                        {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <span className="truncate">{f.name}</span>
                        <span className="text-[11px] text-visiyon-text-3">{f._count?.chats ?? folderChats.length}</span>
                      </button>
                      <div className="hidden group-hover:flex items-center gap-1.5 text-visiyon-text-3 shrink-0">
                        <button
                          onClick={async () => {
                            const name = await askPrompt({ title: "Rename folder", label: "Name", defaultValue: f.name });
                            if (name) {
                              await renameFolder(f.id, name);
                              refreshFolders();
                            }
                          }}
                          title="Rename folder"
                          className="cursor-pointer"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={async () => {
                            if (
                              await askConfirm({
                                title: `Delete folder "${f.name}"? Chats inside will be kept, just unfiled.`,
                                confirmLabel: "Delete",
                                danger: true,
                              })
                            ) {
                              await deleteFolder(f.id);
                              refreshFolders();
                              refresh(query || undefined);
                            }
                          }}
                          title="Delete folder"
                          className="cursor-pointer"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                    {!isCollapsed && (
                      <div className="pl-3 space-y-1">
                        {folderChats.length === 0 ? (
                          <p className="text-[11.5px] text-visiyon-text-3 px-3 py-1">Empty</p>
                        ) : (
                          folderChats.map(renderChatRow)
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="space-y-1">
              {unfoldered.map(renderChatRow)}
            </div>
          </>
        ) : (
          <div className="space-y-1 mb-3">
            {chats.length === 0 ? (
              <p className="text-[11.5px] text-visiyon-text-3 px-3 py-1">No chats yet</p>
            ) : (
              chats.map(renderChatRow)
            )}
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-visiyon-border">
          <button
            onClick={toggleArchived}
            className="w-full flex items-center gap-1.5 px-1 py-1 text-[11px] uppercase tracking-wide text-visiyon-text-3 hover:text-visiyon-text-2"
          >
            {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Archive size={12} />
            Archived
          </button>
          {showArchived && (
            <div className="space-y-1 mt-1">
              {archivedLoading ? (
                <p className="text-[11.5px] text-visiyon-text-3 px-3 py-1">Loading…</p>
              ) : archivedChats.length === 0 ? (
                <p className="text-[11.5px] text-visiyon-text-3 px-3 py-1">No archived chats</p>
              ) : (
                archivedChats.map((c) => (
                  <div
                    key={c.id}
                    className="group flex items-center justify-between rounded-xl px-3 py-2 text-[13.5px] opacity-70 hover:opacity-100 hover:bg-visiyon-text/[0.04]"
                  >
                    <Link href={`/chat/${c.id}`} className="truncate flex-1" onClick={() => setMobileSidebarOpen(false)}>
                      <span className="truncate">{c.title}</span>
                    </Link>
                    <div className="hidden group-hover:flex items-center gap-1.5 text-visiyon-text-3 shrink-0">
                      <button onClick={() => handleUnarchive(c.id)} title="Unarchive">
                        <ArchiveRestore size={13} />
                      </button>
                      <button
                        onClick={async () => {
                          if (await askConfirm({ title: "Delete this chat?", confirmLabel: "Delete", danger: true })) {
                            await deleteChat(c.id);
                            refreshArchived();
                          }
                        }}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="relative p-3 border-t border-visiyon-border" ref={accountMenuRef}>
        <button
          onClick={() => setAccountMenuOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-visiyon-text/[0.06] transition-colors"
        >
          {/* This is the logged-in user's own avatar, so "online" is simply
              true — they're actively using the app right now. */}
          <span className="relative shrink-0">
            {me?.avatarUrl ? (
              <img
                src={me.avatarUrl}
                alt=""
                className="w-7 h-7 rounded-full object-cover"
              />
            ) : (
              <span className="w-7 h-7 rounded-full bg-visiyon-accent text-visiyon-bg text-[12px] font-semibold flex items-center justify-center">
                {(me?.name || me?.email || "?").charAt(0).toUpperCase()}
              </span>
            )}
            {/* Solid + pulsing green "online" dot — restored, this is the
                intended look, not a bug. */}
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5" title="Online">
              <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-75" />
              <span className="absolute inset-0 rounded-full bg-emerald-500 ring-2 ring-visiyon-bg" />
            </span>
          </span>
          {!desktopSidebarCollapsed && (
            <span className="text-left overflow-hidden">
              <span className="block text-[13px] text-visiyon-text truncate">{me?.name || me?.email || "Account"}</span>
            </span>
          )}
        </button>

        {accountMenuOpen && (
          <div className="absolute bottom-full left-3 mb-1 w-60 bg-visiyon-panel border border-visiyon-border rounded-xl overflow-hidden z-30 py-1 visiyon-elevated-lg">
              <div className="px-3 py-2.5 border-b border-visiyon-border">
                <p className="text-[13px] text-visiyon-text truncate">{me?.name || me?.email || "Account"}</p>
                <p className="text-[11.5px] text-visiyon-text-3 truncate">{me?.email}</p>
              </div>
              <button
                onClick={() => {
                  setAccountMenuOpen(false);
                  openSettings();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
              >
                <Settings size={15} /> Settings
              </button>
              {me?.role === "ADMIN" && (
                <Link
                  href="/admin"
                  onClick={() => setAccountMenuOpen(false)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                >
                  <ShieldCheck size={15} /> Admin
                </Link>
              )}
              <div className="border-t border-visiyon-border my-1" />
              <button
                onClick={() => {
                  logout();
                  // Full reload, not router.push: chat state (and any other
                  // in-memory React/module state) is a page-lifetime
                  // singleton, so only a hard navigation guarantees nothing
                  // from this account survives into the next login on the
                  // same tab.
                  window.location.href = "/login";
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
              >
                <LogOut size={15} /> Log out
              </button>
            </div>
        )}
      </div>
    </aside>
    </>
  );
}
