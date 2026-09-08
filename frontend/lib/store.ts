import { create } from "zustand";

const SIDEBAR_COLLAPSE_KEY = "visiyon:desktopSidebarCollapsed";

export interface PreviewBlocks {
  html?: string;
  css?: string;
  js?: string;
}

// Maps a fenced code block's language to the preview "slot" it fills.
// Returns null for languages the preview panel doesn't render at all.
export function normalizePreviewLang(language: string): "html" | "css" | "js" | null {
  if (language === "html") return "html";
  if (language === "css") return "css";
  if (language === "js" || language === "javascript") return "js";
  return null;
}

export function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ChatMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  content: string;
  toolName?: string | null;
  // Base64-encoded images attached to a USER message (vision uploads).
  images?: string[];
  // Documents that were attached to the chat at the moment this USER
  // message was sent — shown as a chip in the bubble, mirroring `images`,
  // once the file leaves the composer after sending.
  documents?: { id: string; filename: string; status?: string }[];
  // Thumbs up/down on an ASSISTANT message: 1 = up, -1 = down, undefined = unrated.
  rating?: 1 | -1 | null;
  // Token usage for this reply, straight from Ollama — undefined until the
  // stream finishes (or the message came from history and never recorded it).
  promptTokens?: number | null;
  completionTokens?: number | null;
  // "What the AI did and thought" — see ThinkingBlock. `reasoning` is the
  // model's own chain-of-thought (undefined for models that don't emit
  // one). `steps` is the ordered system-side activity log (RAG lookup,
  // web search, tool call, ...) taken while producing this reply.
  reasoning?: string | null;
  steps?: ThinkingStep[] | null;
  // When this message was created — used to show a "Name • date time"
  // caption under the bubble. Optional so messages loaded from history
  // (or older stored chats) that lack it don't crash the caption logic.
  createdAt?: string;
  // Which model produced this ASSISTANT message — used in the "Name • date"
  // caption instead of a generic "Visiyon" label. Undefined for USER
  // messages and for older history that predates this field.
  model?: string | null;
}

export interface ThinkingStep {
  type: string;
  label: string;
  status: "start" | "done" | "error";
  detail?: string;
  at: string;
}

interface ChatState {
  currentChatId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  // Whether an image-generation request is in flight. Lives in the store
  // (not component-local state) for the same reason as justCreatedChatId
  // above: sending the first message in a brand-new chat triggers a
  // router.push to /chat/[id], which unmounts and remounts ChatWindow.
  // A local useState would reset to false on that remount and the
  // "generating..." card would vanish mid-request even though the
  // request itself is still running.
  isGeneratingImage: boolean;
  // The prompt currently being rendered into an image, shown in the
  // generating-image status card. Cleared once the request settles.
  generatingImagePrompt: string | null;
  // Whether the composer's next message is treated as an image-gen
  // prompt (the "Generate image" toggle). Also lives in the store rather
  // than component state: toggling it on and then sending the very
  // first message of a brand-new chat triggers the same router.push
  // remount described above, which used to silently flip a local
  // useState back to false right after the first image — forcing the
  // user to reselect "Generate image" for every follow-up.
  imageMode: boolean;
  selectedModel: string | null;
  // Set right when a brand-new chat is created from the empty /chat
  // screen, before the router navigation to /chat/[id] finishes. That
  // navigation unmounts and remounts ChatWindow as a new component
  // instance, so this flag has to live in shared store state (not a
  // component-local ref) to survive the swap — the new instance's
  // mount effect reads it to skip a premature getChat() that would
  // otherwise overwrite the still-streaming placeholder message with
  // whatever's already persisted on the server (too little, too soon).
  justCreatedChatId: string | null;
  // Mobile-only: the sidebar renders as an off-canvas drawer below the
  // `lg` breakpoint. Desktop layout ignores this entirely (sidebar is
  // always visible there).
  mobileSidebarOpen: boolean;
  // Desktop-only: lets the user fully collapse the sidebar to get more
  // room for the chat, independent of the mobile off-canvas drawer above.
  desktopSidebarCollapsed: boolean;
  // Bumped whenever the sidebar's chat list may be stale (e.g. after the
  // backend auto-titles a brand-new chat from its first exchange) so the
  // sidebar knows to refetch without needing a full remount.
  chatListVersion: number;
  // Chat titles keyed by chat id, shared between the sidebar's chat list
  // and the header dropdown in ChatWindow so a rename (or a backend
  // auto-title landing after the first exchange) shows up in both places
  // immediately, instead of one of them staying stale until its own next
  // fetch/remount.
  chatTitles: Record<string, string>;
  setChatTitle: (id: string, title: string) => void;
  // Right-side live preview panel (auto-opens when the AI generates a
  // renderable html/css/js code block — see CodeBlock in MarkdownMessage).
  // Keyed per-message and merged (not just "last write wins") so a
  // response with separate html/css/js blocks for the same site renders
  // as one combined page instead of each new block silently replacing
  // the previous one (which used to make the preview go blank/wrong
  // as soon as e.g. a css block appeared after the html block).
  previewOpen: boolean;
  previewMessageId: string | null;
  previewBlocks: PreviewBlocks;
  previewFileName: string;
  openPreview: (messageId: string, language: string, code: string) => void;
  updatePreviewBlock: (slot: "html" | "css" | "js", code: string) => void;
  closePreview: () => void;
  showPreview: () => void;
  dismissPreview: () => void;
  // Right-side connected-server file browser (FileZilla-style) — toggled
  // independently of the code preview panel above; the two can't both be
  // open at once (there's only one right-hand slot), so opening either
  // closes the other.
  serverPanelOpen: boolean;
  toggleServerPanel: () => void;
  closeServerPanel: () => void;
  // Settings now opens as a floating modal over the chat (with a blurred
  // backdrop) instead of navigating to a separate page — this just tracks
  // whether it's showing, so it can be toggled from anywhere (sidebar,
  // account menu, etc.) without a route change.
  settingsOpen: boolean;
  // Optional tab to land on when the settings modal opens — e.g. the
  // sidebar's "Import memory" / "Customize for you" rows jump straight to
  // the Memory / General tab instead of always landing on the first one.
  settingsInitialTab: string | null;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  // Quick-jump chat search — floating panel over a blurred chat, opened
  // from the search icon in the sidebar header. Separate from the
  // always-visible inline sidebar search box, which filters the full list
  // in place; this one is for jumping straight to a recent chat.
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  setCurrentChatId: (id: string | null) => void;
  setMessages: (m: ChatMessage[]) => void;
  appendToLastAssistant: (token: string) => void;
  appendReasoningToLastAssistant: (token: string) => void;
  pushStepToLastAssistant: (step: ThinkingStep) => void;
  pushMessage: (m: ChatMessage) => void;
  setStreaming: (v: boolean) => void;
  setGeneratingImage: (v: boolean, prompt?: string | null) => void;
  setImageMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  setSelectedModel: (m: string) => void;
  setJustCreatedChatId: (id: string | null) => void;
  setMobileSidebarOpen: (v: boolean) => void;
  setDesktopSidebarCollapsed: (v: boolean) => void;
  setMessageRating: (id: string, rating: 1 | -1 | null) => void;
  setLastAssistantUsage: (promptTokens: number | null | undefined, completionTokens: number | null | undefined) => void;
  updateMessageId: (oldId: string, newId: string) => void;
  bumpChatListVersion: () => void;
  // Clears every piece of chat/account-bound state. Called on logout so a
  // second account signing in on the same tab never inherits the previous
  // account's in-memory chat — this store is a page-lifetime singleton and
  // survives client-side route changes (router.push), so removing the auth
  // token alone isn't enough to keep one account's messages from briefly
  // (or not-so-briefly) appearing under the next one. Sidebar layout prefs
  // (desktopSidebarCollapsed) are device-level, not account-bound, so those
  // are left alone.
  resetForLogout: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  currentChatId: null,
  messages: [],
  isStreaming: false,
  isGeneratingImage: false,
  generatingImagePrompt: null,
  imageMode: false,
  selectedModel: null,
  justCreatedChatId: null,
  mobileSidebarOpen: false,
  desktopSidebarCollapsed: false,
  chatListVersion: 0,
  chatTitles: {},
  setChatTitle: (id, title) =>
    set((s) => (s.chatTitles[id] === title ? s : { chatTitles: { ...s.chatTitles, [id]: title } })),
  previewOpen: false,
  previewMessageId: null,
  previewBlocks: {},
  previewFileName: "index.html",
  openPreview: (messageId, language, code) =>
    set((s) => {
      const slot = normalizePreviewLang(language);
      if (!slot) return {};
      // Switching to a different message's code than what's currently
      // shown starts a fresh set of blocks — otherwise leftover html/css/js
      // from an earlier, unrelated message would bleed into this one.
      const blocks: PreviewBlocks = s.previewMessageId === messageId ? { ...s.previewBlocks } : {};
      blocks[slot] = code;
      return {
        previewOpen: true,
        previewMessageId: messageId,
        previewBlocks: blocks,
        previewFileName: blocks.html ? "index.html" : blocks.css ? "style.css" : "script.js",
        serverPanelOpen: false,
      };
    }),
  // Used by the preview panel's Edit mode — hand-editing the source of an
  // already-open preview updates just that slot (html/css/js) in place,
  // without touching previewMessageId/previewFileName, so the panel stays
  // pointed at the same generated code, just with the person's edits
  // layered on top.
  updatePreviewBlock: (slot, code) =>
    set((s) => ({ previewBlocks: { ...s.previewBlocks, [slot]: code } })),
  closePreview: () => set({ previewOpen: false }),
  // Reopens the panel with whatever preview data is already staged
  // (previewBlocks/previewMessageId survive closePreview) — used by the
  // small floating "reopen preview" card above the composer.
  showPreview: () => set({ previewOpen: true }),
  // Fully clears the staged preview so the floating card disappears too,
  // as opposed to closePreview which just hides the panel but keeps the
  // data around in case the person wants to reopen it.
  dismissPreview: () => set({ previewOpen: false, previewMessageId: null, previewBlocks: {} }),
  serverPanelOpen: false,
  toggleServerPanel: () => set((s) => ({ serverPanelOpen: !s.serverPanelOpen, previewOpen: s.serverPanelOpen ? s.previewOpen : false })),
  closeServerPanel: () => set({ serverPanelOpen: false }),
  settingsOpen: false,
  settingsInitialTab: null,
  openSettings: (tab) => set({ settingsOpen: true, settingsInitialTab: tab ?? null }),
  closeSettings: () => set({ settingsOpen: false }),
  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  setCurrentChatId: (id) => set({ currentChatId: id }),
  setMessages: (m) => set({ messages: m }),
  pushMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  appendToLastAssistant: (token) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "ASSISTANT") {
        msgs[msgs.length - 1] = { ...last, content: last.content + token };
      }
      return { messages: msgs };
    }),
  appendReasoningToLastAssistant: (token) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "ASSISTANT") {
        msgs[msgs.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + token };
      }
      return { messages: msgs };
    }),
  pushStepToLastAssistant: (step) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "ASSISTANT") {
        msgs[msgs.length - 1] = { ...last, steps: [...(last.steps ?? []), step] };
      }
      return { messages: msgs };
    }),
  setMessageRating: (id, rating) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, rating } : m)) })),
  // Stamps token usage onto the last ASSISTANT bubble once the SSE stream
  // reports it (final `done` event) — the message itself was pushed as an
  // empty placeholder before any tokens were known.
  setLastAssistantUsage: (promptTokens, completionTokens) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "ASSISTANT") {
        msgs[msgs.length - 1] = { ...last, promptTokens, completionTokens };
      }
      return { messages: msgs };
    }),
  // Swaps a message's client-generated placeholder id for its real DB id
  // once the server reports it (SSE `meta` event) — without this, a
  // message sent in the current session keeps its placeholder id forever
  // and any later action addressed by id (Edit, rating) 404s against the
  // server since that id was never actually persisted.
  updateMessageId: (oldId, newId) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === oldId ? { ...m, id: newId } : m)) })),
  setStreaming: (v) => set({ isStreaming: v }),
  setGeneratingImage: (v, prompt) => set({ isGeneratingImage: v, generatingImagePrompt: v ? prompt ?? null : null }),
  setImageMode: (v) => set((s) => ({ imageMode: typeof v === "function" ? v(s.imageMode) : v })),
  setSelectedModel: (m) => set({ selectedModel: m }),
  setJustCreatedChatId: (id) => set({ justCreatedChatId: id }),
  setMobileSidebarOpen: (v) => set({ mobileSidebarOpen: v }),
  setDesktopSidebarCollapsed: (v) => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      // ignore — e.g. private browsing storage restrictions
    }
    set({ desktopSidebarCollapsed: v });
  },
  bumpChatListVersion: () => set((s) => ({ chatListVersion: s.chatListVersion + 1 })),
  resetForLogout: () =>
    set({
      currentChatId: null,
      messages: [],
      isStreaming: false,
      isGeneratingImage: false,
      generatingImagePrompt: null,
      imageMode: false,
      selectedModel: null,
      justCreatedChatId: null,
      mobileSidebarOpen: false,
      chatListVersion: 0,
      chatTitles: {},
      previewOpen: false,
      serverPanelOpen: false,
      settingsOpen: false,
      searchOpen: false,
      previewMessageId: null,
      previewBlocks: {},
    }),
}));
