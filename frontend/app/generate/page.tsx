"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/useAuth";
import {
  generateConfig,
  startImageGeneration,
  startVideoGeneration,
  startUpscale,
  checkMediaGeneration,
  myGenerationHistory,
  deleteGeneration,
  listMediaElements,
  saveMediaElement,
  deleteMediaElement,
  MediaModel,
  MediaGeneration,
  MediaElement,
} from "@/lib/api";
import { safeRandomUUID } from "@/lib/uuid";
import {
  Compass,
  FolderOpen,
  Sparkles,
  Grid3x3,
  Film,
  Clapperboard,
  Terminal,
  Image as ImageIcon,
  Video as VideoIcon,
  Upload,
  X,
  ChevronDown,
  Check,
  Loader2,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  Send,
  Download,
  MoreHorizontal,
  Star,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Wand2,
  Menu,
} from "lucide-react";
import BuyCreditsModal from "@/components/BuyCreditsModal";
import { notifyReplyReady } from "@/lib/notificationPref";
import { getTodayUsage, TodayUsage, improvePrompt, describeImage, uploadMedia, getDefaultModel, publishGeneration, getCreditsBalance, API_URL } from "@/lib/api";
import UserMenu from "@/components/UserMenu";
import NotificationBell from "@/components/NotificationBell";
import { Droplet } from "lucide-react";

type Modality = "image" | "video" | "motion" | "avatar";

interface LocalGeneration {
  id: string;
  modality: Modality;
  modelKey: string;
  prompt: string;
  status: "PENDING" | "COMPLETE" | "FAILED";
  resultUrls?: string[];
  error?: string;
  isPublic?: boolean;
  likeCount?: number;
}

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const DURATIONS = [5, 10, 15];
const MOTION_MODEL_KEYS = ["kling-3-0-motion", "kling-2-6-motion"];
const AVATAR_MODEL_KEYS = ["kling-ai-avatar", "kling-ai-avatar-pro"];

// Used everywhere a model list needs to be narrowed to the current tab —
// Motion Control and Avatar each have their own fixed model set, image/video
// just filter MEDIA_MODELS by modality.
function filterModelsForModality(models: MediaModel[], modality: Modality): MediaModel[] {
  if (modality === "motion") return models.filter((m) => MOTION_MODEL_KEYS.includes(m.key));
  if (modality === "avatar") return models.filter((m) => AVATAR_MODEL_KEYS.includes(m.key));
  return models.filter((m) => m.modality === modality);
}

// ---- Left icon rail: every tool gets its own accent color, same idea as
// the reference screenshot (Omni glows green, Generate is the active
// white pill, etc). Kept as plain <a>/<button> — most of these are
// placeholders into other parts of the app / future pages. ----
// ---- Left icon rail. Every entry is either a real link/action, or
// explicitly disabled with a "not built yet" tooltip — nothing here is
// clickable-but-does-nothing. ----
function RailIcon({
  icon,
  label,
  color,
  active,
  href,
  disabledReason,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
  active?: boolean;
  href?: string;
  disabledReason?: string;
  onClick?: () => void;
}) {
  const disabled = Boolean(disabledReason);
  const body = (
    <div
      className={`relative flex flex-col items-center gap-1 w-full py-2.5 rounded-xl transition-colors ${
        disabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer"
      } ${active ? "bg-white/[0.08]" : disabled ? "" : "hover:bg-white/[0.05]"}`}
      title={disabledReason || label}
    >
      <div style={{ color: active ? "#fff" : color }}>{icon}</div>
      {label && (
        <span className={`text-[10px] leading-none ${active ? "text-white font-medium" : "text-visiyon-text-3"}`}>
          {label}
        </span>
      )}
    </div>
  );
  if (disabled) return body;
  if (onClick) {
    return (
      <button onClick={onClick} className="w-full">
        {body}
      </button>
    );
  }
  return href ? (
    <Link href={href} className="w-full">
      {body}
    </Link>
  ) : (
    body
  );
}

export default function GeneratePage() {
  return (
    <Suspense fallback={null}>
      <GeneratePageInner />
    </Suspense>
  );
}

function GeneratePageInner() {
  const { ready, user } = useRequireAuth();
  const searchParams = useSearchParams();

  const [modality, setModality] = useState<Modality>("image");
  const [models, setModels] = useState<MediaModel[]>([]);
  const [modelKey, setModelKey] = useState<string>("");
  // Prompt improver — same "/prompts/improve" endpoint used in chat's
  // composer, reused here to rewrite the draft in the textarea in place.
  const [isImprovingPrompt, setIsImprovingPrompt] = useState(false);
  // Which chat model to use for the improver. This now shares the same
  // getDefaultModel() helper used everywhere else in the app (chat's own
  // composer, sidebar "new chat"), which prefers a meta-model ("Jean") over
  // an arbitrary raw Ollama tag — a plain listModels()[0] pick landed on a
  // broken/incompatible model here before and errored with a 400.
  const [chatModel, setChatModel] = useState<string | null>(null);
  useEffect(() => {
    getDefaultModel().then(setChatModel);
  }, []);
  const handleImprovePrompt = async () => {
    const draft = prompt.trim();
    if (!draft || isImprovingPrompt) return;
    if (!chatModel) {
      setErrorMsg("No chat model is available right now, so the prompt can't be improved.");
      return;
    }
    setIsImprovingPrompt(true);
    setErrorMsg(null);
    try {
      const { improved } = await improvePrompt(draft, chatModel);
      if (improved) setPrompt(improved);
    } catch (err) {
      // Surface the failure instead of silently leaving the button spinning
      // and then doing nothing — that looked like the click didn't register.
      setErrorMsg(
        err instanceof Error && err.message
          ? `Improve prompt failed: ${err.message}`
          : "Improve prompt failed. Please try again."
      );
    } finally {
      setIsImprovingPrompt(false);
    }
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // Mobile-only: the icon rail (Explore/Assets/Photoshop/etc.) becomes a
  // slide-in drawer behind a hamburger button below the sm breakpoint,
  // instead of the always-visible desktop column.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The control panel's pixel width (from the desktop drag-to-resize
  // handle) only makes sense at sm+ — below that it should just be 100%
  // width and stack above the preview instead of sitting beside it.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [panelWidth, setPanelWidth] = useState(320);
  const resizing = useRef(false);
  // Pointer Events + setPointerCapture instead of window-level mousemove/
  // touchmove listeners. Capturing the pointer on the handle itself means
  // every subsequent move/up for that pointer id is delivered straight to
  // this element — even once the cursor leaves it, crosses other elements,
  // or the drag turns into a fast flick — which is exactly the class of
  // case where separate window "mousemove"/"touchmove" listeners can miss
  // events or end up racing each other. One handler set covers mouse,
  // touch and pen. No React state during the drag itself — width is
  // written straight onto the DOM node, and only committed to state (and
  // localStorage) on pointer-up.
  const panelElRef = useRef<HTMLDivElement | null>(null);
  const panelLatestWidth = useRef(panelWidth);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  // Restore saved panel width/open state on mount (client-only — localStorage
  // isn't available during SSR, so this can't be the useState initializer).
  useEffect(() => {
    const savedWidth = Number(localStorage.getItem("visiyon:generatePanelWidth"));
    if (savedWidth >= 240 && savedWidth <= 520) setPanelWidth(savedWidth);
    const savedOpen = localStorage.getItem("visiyon:generatePanelOpen");
    if (savedOpen !== null) setPanelOpen(savedOpen === "1");
  }, []);

  useEffect(() => {
    localStorage.setItem("visiyon:generatePanelOpen", panelOpen ? "1" : "0");
  }, [panelOpen]);

  function onPanelResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizing.current = true;
    panelLatestWidth.current = panelWidth;
    setIsResizingPanel(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  function onPanelResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizing.current) return;
    const next = Math.min(520, Math.max(240, e.clientX - 68)); // 68 = icon rail width
    panelLatestWidth.current = next;
    if (panelElRef.current) panelElRef.current.style.width = `${next}px`;
  }
  function onPanelResizeUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizing.current) return;
    setPanelWidth(panelLatestWidth.current);
    localStorage.setItem("visiyon:generatePanelWidth", String(panelLatestWidth.current));
    resizing.current = false;
    setIsResizingPanel(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Height (px) of the big preview stage above the results grid. As more
  // generations land, the grid only grows — without this it can take a
  // lot of scrolling to see past the stage to the newest thumbnails, with
  // no way to reclaim that space. Drag the handle between them instead.
  const [stageHeight, setStageHeight] = useState(360);
  const resizingStage = useRef(false);
  const stageResizeStart = useRef<{ y: number; height: number } | null>(null);
  const stageHeightRef = useRef(stageHeight); // latest committed value, for reading at drag-start
  const stageRafId = useRef<number | null>(null);
  const stageLatestY = useRef<number | null>(null);
  // Pointer Events + setPointerCapture — same reasoning as the panel-width
  // handle above. No React state during the drag; height is written
  // straight onto the DOM node (rAF-batched) and only committed to state
  // (and localStorage) on pointer-up.
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const stageLatestHeight = useRef(stageHeight);
  const mainRef = useRef<HTMLElement | null>(null);
  // While actively dragging the stage-resize handle, the results grid below
  // it becomes pointer-events:none and its thumbnails temporarily
  // non-draggable. Those thumbnails carry draggable="true" (for the
  // drag-into-video-editor feature) and the mouse inevitably passes over
  // them on the way down — if the browser interprets that as the start of
  // a native HTML5 drag, the OS-level drag-and-drop takes over the pointer
  // entirely and our own pointermove stops arriving, which froze the
  // resize after a single jump instead of tracking the cursor live.
  const [isResizingStage, setIsResizingStage] = useState(false);
  // Elements we forced draggable="false" on for the duration of a resize —
  // NOT "everything currently draggable=false", since that also matches
  // video thumbnails which are legitimately non-draggable all the time.
  // Restoring by querying for [draggable='false'] indiscriminately would
  // flip those back to "true" too and never get corrected again.
  const forcedNonDraggable = useRef<HTMLElement[]>([]);
  useEffect(() => {
    stageHeightRef.current = stageHeight;
  }, [stageHeight]);
  useEffect(() => {
    const saved = Number(localStorage.getItem("visiyon:generateStageHeight"));
    if (saved >= 160 && saved <= 900) setStageHeight(saved);
  }, []);

  function applyStageResize() {
    stageRafId.current = null;
    const y = stageLatestY.current;
    if (y == null || !stageResizeStart.current) return;
    const { y: startY, height } = stageResizeStart.current;
    // The handle tracks the cursor 1:1: drag down (y increases) moves the
    // boundary down with it, growing the stage; drag up shrinks it. It was
    // previously inverted (height - delta), which shrank on a downward
    // drag — visually the handle jumped the opposite way from the mouse.
    const next = Math.min(900, Math.max(160, height + (y - startY)));
    stageLatestHeight.current = next;
    if (stageElRef.current) stageElRef.current.style.height = `${next}px`;
  }
  // Window-level listeners instead of element-bound onPointerMove/onPointerUp
  // + setPointerCapture: capture *should* keep routing move/up events to the
  // 12px handle for the whole gesture, but if it drops for any reason
  // (browser quirk, the handle re-rendering, whatever), every subsequent
  // move is silently lost and dragging looks like it does nothing past
  // that point. Listening on window instead means we don't depend on the
  // handle continuing to be the hit-test target at all — move/up fire
  // regardless of what's under the cursor.
  function startStageResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    resizingStage.current = true;
    setIsResizingStage(true);
    // Also flip this synchronously (not just via the isResizingStage
    // state, which only reaches the DOM on the next render) so the grid's
    // thumbnails can't grab the gesture on the way down.
    if (assetsRef.current) {
      assetsRef.current.style.pointerEvents = "none";
      forcedNonDraggable.current = Array.from(
        assetsRef.current.querySelectorAll<HTMLElement>("[draggable='true']")
      );
      forcedNonDraggable.current.forEach((el) => el.setAttribute("draggable", "false"));
    }
    stageResizeStart.current = { y: e.clientY, height: stageHeightRef.current };
    stageLatestHeight.current = stageHeightRef.current;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (!resizingStage.current || !stageResizeStart.current) return;
      stageLatestY.current = ev.clientY;
      if (stageRafId.current == null) stageRafId.current = requestAnimationFrame(applyStageResize);
    };
    const onUp = () => {
      if (!resizingStage.current) return;
      setStageHeight(stageLatestHeight.current);
      localStorage.setItem("visiyon:generateStageHeight", String(stageLatestHeight.current));
      resizingStage.current = false;
      setIsResizingStage(false);
      if (assetsRef.current) {
        assetsRef.current.style.pointerEvents = "";
      }
      forcedNonDraggable.current.forEach((el) => el.setAttribute("draggable", "true"));
      forcedNonDraggable.current = [];
      stageResizeStart.current = null;
      stageLatestY.current = null;
      if (stageRafId.current != null) {
        cancelAnimationFrame(stageRafId.current);
        stageRafId.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  const [nativeAudio, setNativeAudio] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [refImages, setRefImages] = useState<string[]>([]);

  // ---- Motion Control: character image reuses refImages[0] above; this is
  // the separate motion-reference video upload it also needs. ----
  const [motionVideoUrl, setMotionVideoUrl] = useState<string | null>(null);
  const [motionVideoName, setMotionVideoName] = useState<string | null>(null);
  const [uploadingMotionVideo, setUploadingMotionVideo] = useState(false);
  const [uploadingRefImage, setUploadingRefImage] = useState(false);
  const [characterOrientation, setCharacterOrientation] = useState<"image" | "video">("image");
  const motionVideoInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Avatar: face image reuses refImages[0] above; this is the audio
  // track it lip-syncs to. ----
  const [avatarAudioUrl, setAvatarAudioUrl] = useState<string | null>(null);
  const [avatarAudioName, setAvatarAudioName] = useState<string | null>(null);
  const [uploadingAvatarAudio, setUploadingAvatarAudio] = useState(false);
  const avatarAudioInputRef = useRef<HTMLInputElement | null>(null);

  const [generations, setGenerations] = useState<LocalGeneration[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const assetsRef = useRef<HTMLDivElement | null>(null);

  // ---- Bound elements (@name reference images) — only kling-3.0/video
  // supports these on kie.ai, so the whole panel is gated on that model. ----
  const [elements, setElements] = useState<MediaElement[]>([]);
  const [boundNames, setBoundNames] = useState<string[]>([]);
  const [elementPanelOpen, setElementPanelOpen] = useState(false);
  const [elementSearch, setElementSearch] = useState("");
  const [newElementOpen, setNewElementOpen] = useState(false);
  const [newElementName, setNewElementName] = useState("");
  const [newElementImages, setNewElementImages] = useState<string[]>([]);
  const [savingElement, setSavingElement] = useState(false);
  const [uploadingElementImage, setUploadingElementImage] = useState(false);
  const elementFileInputRef = useRef<HTMLInputElement | null>(null);

  function loadElements() {
    listMediaElements().then(setElements).catch(() => {});
  }

  function toggleBoundElement(name: string) {
    setBoundNames((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function handleNewElementImage(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    e.target.value = "";
    // Elements are sent to kie.ai as `kling_elements`, which fetches each
    // image_input_url itself over the network — same constraint as
    // uploadRefImage/handleRefUpload above, so this needs a real hosted
    // URL too, not a local base64 data: URL. Upload every selected file in
    // parallel and append them all once done, respecting the 6-image cap.
    setUploadingElementImage(true);
    Promise.all(files.map((file) => uploadMedia(file).then(({ url }) => url).catch(() => null)))
      .then((urls) => {
        const ok = urls.filter((u): u is string => !!u);
        if (ok.length < urls.length) showToast("Some images failed to upload.");
        setNewElementImages((prev) => [...prev, ...ok].slice(0, 6));
      })
      .finally(() => setUploadingElementImage(false));
  }

  async function createElement() {
    if (!newElementName.trim() || !newElementImages.length || savingElement) return;
    setSavingElement(true);
    try {
      const el = await saveMediaElement(newElementName.trim(), newElementImages);
      setElements((prev) => [el, ...prev.filter((e) => e.name !== el.name)]);
      setBoundNames((prev) => [...prev, el.name]);
      setNewElementName("");
      setNewElementImages([]);
      setNewElementOpen(false);
      showToast("Element created");
    } catch (err: any) {
      showToast(err?.message || "Could not create element");
    } finally {
      setSavingElement(false);
    }
  }

  async function removeElement(id: string, name: string) {
    setElements((prev) => prev.filter((e) => e.id !== id));
    setBoundNames((prev) => prev.filter((n) => n !== name));
    deleteMediaElement(id).catch(() => {});
  }

  // ---- Real state for the previously-decorative rail buttons ----

  const [usage, setUsage] = useState<TodayUsage | null>(null);
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [creditsShortfall, setCreditsShortfall] = useState<{ required: number; available: number } | null>(null);
  const [credits, setCredits] = useState<number | null>(null);

  // ---- Real state for the previously-decorative result action bar
  // (like/dislike/share/more/favorite). Reactions + favorites persist in
  // localStorage per taskId since there's no backend column for them yet.
  const [reactions, setReactions] = useState<Record<string, "like" | "dislike">>({});
  const [favorites, setFavorites] = useState<Record<string, true>>({});
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  // The "..." menu had no close-on-outside-click and no reset when
  // switching between images, so it could stay open indefinitely (or
  // pop back up over a different image later) until the tab reloaded.
  useEffect(() => {
    if (!moreMenuFor) return;
    function onClick(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuFor(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [moreMenuFor]);

  useEffect(() => {
    setMoreMenuFor(null);
  }, [selectedId]);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  }

  function toggleReaction(id: string, kind: "like" | "dislike") {
    setReactions((prev) => {
      const next = { ...prev };
      if (next[id] === kind) delete next[id];
      else next[id] = kind;
      localStorage.setItem("visiyon:generateReactions", JSON.stringify(next));
      return next;
    });
  }

  function toggleFavorite(id: string) {
    setFavorites((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      localStorage.setItem("visiyon:generateFavorites", JSON.stringify(next));
      return next;
    });
  }

  async function shareResult(g: LocalGeneration) {
    const url = g.resultUrls?.[0];
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied");
    } catch {
      showToast("Copy failed");
    }
  }

  // Cross-origin URLs (kie.ai's CDN) ignore the `download` attribute in most
  // browsers and just open in a new tab instead of saving. Fetch as a blob
  // and trigger the save ourselves so it actually downloads.
  // Hover-toolbar actions on a finished image. "Generate Video" and
  // "Upscale" call real kie.ai models below. Inpaint / Expand / Remove /
  // Create in Omni need a mask-drawing canvas that doesn't exist yet, so
  // they're intentionally left out rather than wired to nothing.
  function sendToVideo(g: LocalGeneration) {
    if (!g.resultUrls?.[0]) return;
    setModality("video");
    setPrompt(g.prompt);
    setRefImages([g.resultUrls[0]]);
    const videoModel = models.find((m) => m.modality === "video" && /i2v|image-to-video/i.test(m.key));
    if (videoModel) setModelKey(videoModel.key);
    showToast("Loaded into Video Generation — press Generate");
  }

  async function upscaleSelected(g: LocalGeneration) {
    if (!g.resultUrls?.[0] || busy) return;
    setBusy(true);
    const placeholderId = safeRandomUUID();
    setGenerations((prev) => [
      { id: placeholderId, modality: "image", modelKey: "topaz-upscale", prompt: "Upscale", status: "PENDING" },
      ...prev,
    ]);
    setSelectedId(placeholderId);
    try {
      const { taskId } = await startUpscale(g.resultUrls[0], 2);
      setGenerations((prev) => prev.map((x) => (x.id === placeholderId ? { ...x, id: taskId } : x)));
      setSelectedId(taskId);
      pollFor(taskId);
    } catch (err) {
      setGenerations((prev) =>
        prev.map((x) => (x.id === placeholderId ? { ...x, status: "FAILED", error: (err as Error).message } : x))
      );
    } finally {
      setBusy(false);
    }
  }

  const router = useRouter();

  async function downloadResult(g: LocalGeneration) {
    const url = g.resultUrls?.[0];
    if (!url) return;
    try {
      // Fetch through our own backend (/generate/:taskId/download) instead
      // of hitting the result CDN straight from the browser: kie.ai's CDN
      // doesn't reliably send CORS headers, so the direct fetch used to
      // get silently blocked and fall back to opening a new tab instead
      // of actually downloading. A server-to-server fetch has no such
      // restriction, so proxying it through the backend fixes that.
      const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
      const res = await fetch(`${API_URL}/generate/${g.id}/download`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const blob = await res.blob();
      const ext = g.modality === "video" ? "mp4" : blob.type.includes("png") ? "png" : "jpg";
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `visiyon-${g.id}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Fallback: open in a new tab so the user can save it manually.
      window.open(url, "_blank", "noreferrer");
      showToast("Download failed, opened in new tab");
    }
  }

  async function copyPrompt(g: LocalGeneration) {
    try {
      await navigator.clipboard.writeText(g.prompt);
      showToast("Prompt copied");
    } catch {
      showToast("Copy failed");
    }
    setMoreMenuFor(null);
  }

  async function togglePublish(g: LocalGeneration) {
    if (g.status !== "COMPLETE") return;
    setPublishingId(g.id);
    const nextPublic = !g.isPublic;
    try {
      await publishGeneration(g.id, nextPublic);
      setGenerations((prev) => prev.map((x) => (x.id === g.id ? { ...x, isPublic: nextPublic } : x)));
      showToast(nextPublic ? "Published to Explore" : "Removed from Explore");
    } catch {
      showToast("Publish failed, please try again");
    } finally {
      setPublishingId(null);
    }
  }

  function deleteResult(id: string) {
    setGenerations((prev) => prev.filter((g) => g.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
    setMoreMenuFor(null);
    // Only real server-side tasks (not still-pending local placeholders)
    // have a row to delete — taskId IDs come back from the backend and
    // replace the placeholder UUID once the generation starts.
    deleteGeneration(id).catch(() => {
      // If this was just a local placeholder or the row is already gone,
      // there's nothing to roll back — the UI removal above still holds.
    });
  }

  useEffect(() => {
    getTodayUsage().then(setUsage).catch(() => {});
    getCreditsBalance().then((b) => setCredits(b.credits)).catch(() => {});
    loadElements();
    try {
      setReactions(JSON.parse(localStorage.getItem("visiyon:generateReactions") || "{}"));
      setFavorites(JSON.parse(localStorage.getItem("visiyon:generateFavorites") || "{}"));
    } catch {
      // ignore malformed localStorage
    }
    // Deep link from the "All Tools" grid (e.g. /generate?modality=motion) —
    // preselect the right tab so a tool tile actually lands where it says.
    const m = searchParams?.get("modality");
    if (m === "image" || m === "video" || m === "motion" || m === "avatar") {
      setModality(m);
    }
    // Handed off from Explore's "Recreate" button — preload the prompt
    // (and model, once the catalog loads below) so the user can tweak and
    // regenerate instead of retyping everything from scratch. Previously
    // this happened silently, so landing on /generate looked like nothing
    // had happened at all — a toast makes clear what got filled in and
    // that pressing Generate is the next step.
    const recreatePrompt = searchParams?.get("prompt");
    if (recreatePrompt) {
      setPrompt(recreatePrompt);
      showToast("Loaded from Explore — press Generate to recreate it");
    }
    // Picked up an edited photo handed off from the Photoshop editor
    // (/editor). The editor no longer uploads it itself — it only ever
    // touched the browser's own sessionStorage — so the actual upload
    // (needed because generation providers require a real hosted URL,
    // not inline data) happens here, reusing the same uploadMedia() call
    // every other reference-image upload on this page already relies on.
    // This means nothing is sent to the server for edits the person
    // never continues with.
    try {
      const handoff = sessionStorage.getItem("visiyon_editor_handoff");
      if (handoff) {
        sessionStorage.removeItem("visiyon_editor_handoff");
        (async () => {
          try {
            const res = await fetch(handoff);
            const blob = await res.blob();
            const file = new File([blob], "visiyon-edit.png", { type: blob.type || "image/png" });
            const { url } = await uploadMedia(file);
            setRefImages((prev) => [url, ...prev].slice(0, 2));
          } catch (err: any) {
            setErrorMsg(err?.message || "Couldn't bring your edited photo over from the editor. Please try again.");
          }
        })();
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    generateConfig()
      .then((cfg) => {
        setEnabled(cfg.enabled);
        setModels(cfg.models);
        const wantedKey = searchParams?.get("modelKey");
        const wanted = wantedKey ? cfg.models.find((m) => m.key === wantedKey) : undefined;
        const first = wanted || cfg.models.find((m) => m.modality === modality) || cfg.models[0];
        if (first) setModelKey(first.key);
      })
      .catch(() => setEnabled(false));

    myGenerationHistory()
      .then((rows: MediaGeneration[]) => {
        const mapped = rows.map((r) => ({
          id: r.taskId,
          modality: (r.modality === "IMAGE" ? "image" : "video") as Modality,
          modelKey: r.modelKey,
          prompt: r.prompt,
          status: r.status,
          resultUrls: r.resultUrls || undefined,
          error: r.error || undefined,
          // These were dropped here before, so every reload showed the
          // Publish button as un-published (and likes reset to 0) even
          // though the backend still had the real values — read them
          // back from history same as everything else.
          isPublic: r.isPublic,
          likeCount: r.likeCount,
        }));
        setGenerations(mapped);
        if (mapped[0]) setSelectedId(mapped[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const inModality = filterModelsForModality(models, modality);
    if (inModality.length && !inModality.some((m) => m.key === modelKey)) {
      setModelKey(inModality[0].key);
    }
  }, [modality, models, modelKey]);

  // Per-tab cache so switching Image ⇄ Video ⇄ Motion ⇄ Avatar and back
  // doesn't lose what you uploaded on the tab you left. Reference images
  // use different formats between "plain" (image/video — base64 data URL)
  // and "special" (motion/avatar — needs a real hosted URL), so those two
  // groups get their own cache slot; motion video / avatar audio are only
  // relevant to their own tab and get their own slots too.
  const uploadCache = useRef<{
    plainRef: string[];
    specialRef: string[];
    motionVideo: { url: string | null; name: string | null };
    avatarAudio: { url: string | null; name: string | null };
  }>({ plainRef: [], specialRef: [], motionVideo: { url: null, name: null }, avatarAudio: { url: null, name: null } });
  const prevModality = useRef<Modality>(modality);

  useEffect(() => {
    const prev = prevModality.current;
    const prevGroup = prev === "motion" || prev === "avatar" ? "special" : "plain";
    const nextGroup = modality === "motion" || modality === "avatar" ? "special" : "plain";

    // Stash whatever was on the tab we're leaving.
    if (prevGroup === "plain") uploadCache.current.plainRef = refImages;
    else uploadCache.current.specialRef = refImages;
    if (prev === "motion") uploadCache.current.motionVideo = { url: motionVideoUrl, name: motionVideoName };
    if (prev === "avatar") uploadCache.current.avatarAudio = { url: avatarAudioUrl, name: avatarAudioName };

    // Restore whatever belongs to the tab we're entering.
    setRefImages(nextGroup === "plain" ? uploadCache.current.plainRef : uploadCache.current.specialRef);
    setMotionVideoUrl(modality === "motion" ? uploadCache.current.motionVideo.url : null);
    setMotionVideoName(modality === "motion" ? uploadCache.current.motionVideo.name : null);
    setAvatarAudioUrl(modality === "avatar" ? uploadCache.current.avatarAudio.url : null);
    setAvatarAudioName(modality === "avatar" ? uploadCache.current.avatarAudio.name : null);

    prevModality.current = modality;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modality]);

  useEffect(() => {
    if (modelKey !== "kling-3-0") {
      setBoundNames([]);
      setElementPanelOpen(false);
    }
  }, [modelKey]);

  useEffect(() => {
    setLightboxOpen(false);
  }, [selectedId]);

  useEffect(() => {
    return () => {
      pollTimers.current.forEach((t) => clearInterval(t));
    };
  }, []);

  function pollFor(taskId: string) {
    const timer = setInterval(async () => {
      try {
        const result = await checkMediaGeneration(taskId);
        if (result.status === "PENDING") return;
        clearInterval(timer);
        pollTimers.current.delete(taskId);
        setGenerations((prev) =>
          prev.map((g) =>
            g.id === taskId ? { ...g, status: result.status, resultUrls: result.resultUrls, error: result.error } : g
          )
        );
        // Bell toggle in the left rail only requests permission and
        // flips the pref — nothing ever actually fired a notification.
        // Do that here, same convention as ChatWindow's notifyReplyReady:
        // only when the tab is hidden, so we don't interrupt someone
        // already watching the result land.
        if (result.status === "COMPLETE") {
          notifyReplyReady("Your generation is ready.");
        } else if (result.status === "FAILED") {
          notifyReplyReady(result.error || "Your generation failed.");
          // Backend refunds credits for a FAILED generation — reflect that
          // in the shown balance without waiting for the next page load.
          getCreditsBalance().then((b) => setCredits(b.credits)).catch(() => {});
        }
      } catch {
        // transient poll error — leave PENDING, try again next tick
      }
    }, 3000);
    pollTimers.current.set(taskId, timer);
  }

  async function handleGenerate() {
    // Every kie.ai model here requires a non-empty prompt string even for
    // pure image-to-video, so "just a reference image, no prompt" needs a
    // sensible default rather than a blocked button — this was blocking
    // generation outright whenever someone attached an image and didn't
    // type anything.
    const effectivePrompt = prompt.trim() || (refImages[0] ? "Animate this image with natural, cinematic motion." : "");
    if (!effectivePrompt || busy) return;
    setBusy(true);
    setErrorMsg(null);

    // Images: generate 2 variants per prompt (like the reference — a pair
    // side by side), each with its own placeholder + taskId. Video stays 1.
    const variantCount = modality === "image" ? 2 : 1;
    const placeholderIds = Array.from({ length: variantCount }, () => safeRandomUUID());
    setGenerations((prev) => [
      ...placeholderIds.map((id) => ({ id, modality, modelKey, prompt: effectivePrompt, status: "PENDING" as const })),
      ...prev,
    ]);
    setSelectedId(placeholderIds[0]);
    try {
      if (modality === "image") {
        const { taskIds } = await startImageGeneration(effectivePrompt, modelKey, {
          aspectRatio,
          imageUrl: refImages[0],
          count: variantCount,
        });
        setGenerations((prev) =>
          prev.map((g) => {
            const idx = placeholderIds.indexOf(g.id);
            return idx !== -1 && taskIds[idx] ? { ...g, id: taskIds[idx] } : g;
          })
        );
        setSelectedId(taskIds[0]);
        taskIds.forEach(pollFor);
      } else if (modality === "video") {
        const { taskId } = await startVideoGeneration(effectivePrompt, modelKey, {
          durationSeconds,
          imageUrl: refImages[0],
          nativeAudio,
          elementNames: modelKey === "kling-3-0" && boundNames.length ? boundNames : undefined,
        });
        setGenerations((prev) => prev.map((g) => (g.id === placeholderIds[0] ? { ...g, id: taskId } : g)));
        setSelectedId(taskId);
        pollFor(taskId);
      } else if (modality === "motion") {
        // Motion Control: character image + motion-reference video, no
        // duration/native-audio controls (output length follows the video).
        const { taskId } = await startVideoGeneration(effectivePrompt, modelKey, {
          imageUrl: refImages[0],
          motionVideoUrl: motionVideoUrl || undefined,
          characterOrientation,
        });
        setGenerations((prev) => prev.map((g) => (g.id === placeholderIds[0] ? { ...g, id: taskId } : g)));
        setSelectedId(taskId);
        pollFor(taskId);
      } else {
        // Avatar: face image + audio track, no duration/native-audio
        // controls (output length follows the audio).
        const { taskId } = await startVideoGeneration(effectivePrompt, modelKey, {
          imageUrl: refImages[0],
          audioUrl: avatarAudioUrl || undefined,
        });
        setGenerations((prev) => prev.map((g) => (g.id === placeholderIds[0] ? { ...g, id: taskId } : g)));
        setSelectedId(taskId);
        pollFor(taskId);
      }
      setPrompt("");
      // Deduction already happened server-side — refresh the shown balance
      // rather than guessing the new number client-side.
      getCreditsBalance().then((b) => setCredits(b.credits)).catch(() => {});
    } catch (err: any) {
      if (err?.needsCredits) {
        setCreditsShortfall({ required: err.required ?? 0, available: err.available ?? 0 });
        setShowBuyCredits(true);
      } else {
        setErrorMsg(err?.message || "Generation failed. Please try again.");
      }
      setGenerations((prev) => prev.filter((g) => !placeholderIds.includes(g.id)));
    } finally {
      setBusy(false);
    }
  }

  function uploadRefImage(file: File) {
    setUploadingRefImage(true);
    setErrorMsg(null);
    uploadMedia(file)
      .then(({ url }) => {
        setRefImages((prev) => [...prev, url].slice(0, modality === "image" ? 2 : 1));
        // Auto-describe the reference image into the prompt box — only
        // when it's empty, so this never overwrites something the person
        // already typed themselves.
        if (chatModel && !prompt.trim()) {
          describeImage(url, chatModel)
            .then(({ description }) => {
              if (description) setPrompt((cur) => (cur.trim() ? cur : description));
            })
            .catch(() => {
              // Best-effort — the reference image is already attached and
              // usable even if the auto-description fails, so stay quiet.
            });
        }
      })
      .catch((err: any) => setErrorMsg(err?.message || "Image upload failed. Please try again."))
      .finally(() => setUploadingRefImage(false));
  }

  function handleRefUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    // kie.ai runs on its own external server and fetches the reference
    // image itself over the network — it can't resolve an inline base64
    // data URL (no network location to fetch), so every mode needs a real
    // hosted URL here, the same way Motion Control's and Avatar's uploads
    // already worked. Plain Image mode happened to work by coincidence for
    // pure text-to-image models (which ignore imageUrl entirely), but any
    // image-to-video/image-to-image model needs the real URL too — hence
    // "This field is required" from kie.ai when a data: URL was sent.
    uploadRefImage(file);
  }

  async function handleMotionVideoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingMotionVideo(true);
    setErrorMsg(null);
    try {
      const { url } = await uploadMedia(file);
      setMotionVideoUrl(url);
      setMotionVideoName(file.name);
    } catch (err: any) {
      setErrorMsg(err?.message || "Video upload failed. Please try again.");
    } finally {
      setUploadingMotionVideo(false);
    }
  }

  async function handleAvatarAudioUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingAvatarAudio(true);
    setErrorMsg(null);
    try {
      const { url } = await uploadMedia(file);
      setAvatarAudioUrl(url);
      setAvatarAudioName(file.name);
    } catch (err: any) {
      setErrorMsg(err?.message || "Audio upload failed. Please try again.");
    } finally {
      setUploadingAvatarAudio(false);
    }
  }

  const modelsForModality = filterModelsForModality(models, modality);
  const selectedModel = models.find((m) => m.key === modelKey);
  const selected = generations.find((g) => g.id === selectedId) || generations[0];

  // Mirrors the backend's charge in lib/mediaCost.ts: image models charge a
  // flat per-image cost (x2 here since this page always generates 2
  // variants per image prompt — see handleGenerate's variantCount), video
  // models charge per 5s block, rounded up. Motion/Avatar don't expose a
  // duration control (output length follows the source video/audio), so
  // they show the flat 5s-block price as a floor estimate rather than
  // trying to predict the real length.
  const estimatedCredits = !selectedModel?.creditsPerUse
    ? null
    : modality === "image"
    ? selectedModel.creditsPerUse * 2
    : modality === "video"
    ? selectedModel.creditsPerUse * Math.max(1, Math.ceil(durationSeconds / 5))
    : selectedModel.creditsPerUse;

  if (!ready) return null;

  return (
    <div className="h-screen bg-visiyon-bg text-visiyon-text flex overflow-hidden">
      {/* Backdrop — mobile only, closes the icon-rail drawer on tap outside it */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 sm:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* ================= Left icon rail — every button is real =================
          Desktop: always-visible narrow column, as before.
          Mobile (<sm): hidden by default, slides in as an overlay drawer
          when the hamburger button in the header is tapped. */}
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
          <RailIcon icon={<Sparkles size={18} />} label="Generate" color="#f472b6" active />
          <RailIcon icon={<Wand2 size={18} />} label="Photoshop" color="#22d3ee" href="/editor" />
          <RailIcon icon={<Clapperboard size={18} />} label="Video Edit" color="#a78bfa" href="/video-editor" />
          <RailIcon icon={<Grid3x3 size={18} />} label="All Tools" color="#94a3b8" href="/tools" />
        </div>

        <div className="flex-1" />

        <div className="w-full px-1.5 flex flex-col gap-0.5 items-center">
          <NotificationBell />
          <RailIcon icon={<Terminal size={17} />} label="API" color="#94a3b8" href="/settings" />
          <UserMenu />
          <div
            className="flex items-center gap-1 text-[11px] text-visiyon-accent font-semibold mt-1"
            title="Credits remaining"
          >
            <Droplet size={12} fill="currentColor" />
            {credits ?? 0}
          </div>
          <button
            onClick={() => {
              setCreditsShortfall(null);
              setShowBuyCredits(true);
            }}
            className="mt-1 w-full inline-flex items-center justify-center gap-1 whitespace-nowrap text-[9px] font-semibold leading-none rounded-lg py-2 px-1 text-black bg-white shadow-sm transition-colors duration-150 hover:bg-white/90"
          >
            Buy credits
          </button>
        </div>
      </aside>

      {showBuyCredits && (
        <BuyCreditsModal
          onClose={() => {
            setShowBuyCredits(false);
            setCreditsShortfall(null);
          }}
          insufficientAmount={creditsShortfall}
        />
      )}


      <div className="flex-1 min-w-0 flex flex-col">
        {/* ================= Top tabs ================= */}
        <header className="h-12 shrink-0 flex items-center gap-2 px-3 sm:px-5 sm:gap-6">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="sm:hidden shrink-0 h-8 w-8 flex items-center justify-center rounded-lg hover:bg-white/5 text-visiyon-text-2"
            title="Menu"
          >
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-4 sm:gap-6 overflow-x-auto no-scrollbar">
          <button
            onClick={() => setModality("image")}
            className={`shrink-0 text-[13.5px] font-medium pb-[1px] border-b-2 transition-colors ${
              modality === "image" ? "border-white text-white" : "border-transparent text-visiyon-text-3 hover:text-visiyon-text-2"
            }`}
          >
            Image Generation
          </button>
          <button
            onClick={() => setModality("video")}
            className={`shrink-0 text-[13.5px] font-medium pb-[1px] border-b-2 transition-colors ${
              modality === "video" ? "border-white text-white" : "border-transparent text-visiyon-text-3 hover:text-visiyon-text-2"
            }`}
          >
            Video Generation
          </button>
          <button
            onClick={() => setModality("motion")}
            className={`shrink-0 text-[13.5px] font-medium pb-[1px] border-b-2 transition-colors ${
              modality === "motion" ? "border-white text-white" : "border-transparent text-visiyon-text-3 hover:text-visiyon-text-2"
            }`}
          >
            Motion Control
          </button>
          <button
            onClick={() => setModality("avatar")}
            className={`shrink-0 text-[13.5px] font-medium pb-[1px] border-b-2 transition-colors ${
              modality === "avatar" ? "border-white text-white" : "border-transparent text-visiyon-text-3 hover:text-visiyon-text-2"
            }`}
          >
            Avatar
          </button>
          </div>
        </header>

        {enabled === false && (
          <div className="mx-5 mt-3 flex items-center gap-2 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5 text-[12.5px] text-yellow-200 shrink-0">
            <AlertTriangle size={14} />
            Generation isn&apos;t configured on this server yet. Ask an admin to enable it in Admin &gt; Settings.
          </div>
        )}

        <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-y-auto sm:overflow-hidden">
          {/* ================= Left control panel ================= */}
          <div className="relative shrink-0 flex flex-col sm:flex-row w-full sm:w-auto">
            <div
              ref={panelElRef}
              className={`w-full bg-visiyon-panel2 flex flex-col p-3 gap-3 sm:overflow-y-auto ${
                isResizingPanel ? "" : "transition-all duration-200"
              } ${panelOpen ? "opacity-100" : "opacity-0 p-0 sm:h-0"}`}
              style={{
                width: panelOpen ? (isDesktop ? panelWidth : "100%") : isDesktop ? 0 : "100%",
                overflow: panelOpen ? "auto" : "hidden",
              }}
            >
            {/* Model badge / picker */}
            <div className="relative">
              <button
                onClick={() => setModelPickerOpen((v) => !v)}
                className="w-full flex items-center gap-2.5 rounded-xl bg-black/30 px-3 py-2.5 text-left hover:bg-black/50 transition-colors"
              >
                <div className="h-7 w-7 shrink-0 rounded-lg bg-visiyon-accent flex items-center justify-center text-[10px] font-bold text-visiyon-bg">
                  {modality === "image" ? "IMG" : modality === "avatar" ? "AVT" : "VID"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold truncate">{selectedModel?.label || "Choose a model"}</div>
                  {selectedModel?.resolution && (
                    <div className="text-[11px] text-visiyon-text-3">{selectedModel.resolution}</div>
                  )}
                </div>
                <ChevronDown size={14} className={`text-visiyon-text-3 transition-transform ${modelPickerOpen ? "rotate-180" : ""}`} />
              </button>
              {modelPickerOpen && (
                <div className="absolute z-20 mt-1.5 w-full rounded-xl bg-black shadow-2xl p-1.5 space-y-1">
                  {modelsForModality.map((m) => (
                    <button
                      key={m.key}
                      onClick={() => {
                        setModelKey(m.key);
                        setModelPickerOpen(false);
                      }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        modelKey === m.key ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium truncate">{m.label}</span>
                        {m.resolution && <span className="block text-[10.5px] text-visiyon-text-3">{m.resolution}</span>}
                      </span>
                      {m.recommended && (
                        <span className="shrink-0 text-[9.5px] font-medium px-1.5 py-0.5 rounded bg-visiyon-accent/15 text-visiyon-accent">
                          BEST
                        </span>
                      )}
                      {modelKey === m.key && <Check size={13} className="shrink-0 text-white" />}
                    </button>
                  ))}
                  {modelsForModality.length === 0 && (
                    <p className="px-2.5 py-2 text-[12px] text-visiyon-text-3">No models available.</p>
                  )}
                </div>
              )}
            </div>

            {/* Reference image slot(s) — Motion Control and Avatar only take
                one (the character/face image), the other modes allow two. */}
            {(modality === "motion" || modality === "avatar") && (
              <p className="text-[11px] text-visiyon-text-3 -mb-1">{modality === "avatar" ? "Face image" : "Character image"}</p>
            )}
            {elements.length > 0 && refImages.length < (modality === "motion" || modality === "avatar" ? 1 : 2) && (
              <div className="flex flex-wrap gap-1.5 -mb-1">
                <span className="text-[11px] text-visiyon-text-3 self-center">Use a saved element:</span>
                {elements.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => e.imageUrls?.[0] && setRefImages((prev) => [...prev, e.imageUrls[0]].slice(0, modality === "motion" || modality === "avatar" ? 1 : 2))}
                    disabled={!e.imageUrls?.[0]}
                    title={`Use @${e.name}'s first saved photo as a reference image`}
                    className="flex items-center gap-1 pl-1 pr-2 py-0.5 rounded-full border border-visiyon-text-3/30 text-[11px] text-visiyon-text-2 hover:bg-white/5 disabled:opacity-40"
                  >
                    {e.imageUrls?.[0] && <img src={e.imageUrls[0]} alt={e.name} className="h-4 w-4 rounded-full object-cover" />}
                    @{e.name}
                  </button>
                ))}
              </div>
            )}
            <div className={`grid gap-2 ${modality === "motion" || modality === "avatar" ? "grid-cols-1" : "grid-cols-2"}`}>
              {(modality === "motion" || modality === "avatar" ? [0] : [0, 1]).map((slot) => {
                const img = refImages[slot];
                return img ? (
                  <div key={slot} className="relative aspect-video rounded-lg overflow-hidden bg-black/30">
                    <img src={img} alt="Reference" className="w-full h-full object-cover" />
                    <button
                      onClick={() => setRefImages((prev) => prev.filter((_, i) => i !== slot))}
                      className="absolute top-1 right-1 h-5 w-5 flex items-center justify-center rounded-full bg-black/60 text-white"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    key={slot}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingRefImage}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      // A real file dragged in from the desktop (the common
                      // case) — upload it the same way click-to-upload does,
                      // reference-image auto-description included.
                      const file = e.dataTransfer.files?.[0];
                      if (file) {
                        if (modality !== "motion" && modality !== "avatar" && refImages.length >= 2) return;
                        uploadRefImage(file);
                        return;
                      }
                      // Otherwise: a URL dragged in from elsewhere in the
                      // browser (e.g. another tab) — attach it directly,
                      // no upload needed since it's already hosted.
                      if (modality === "motion" || modality === "avatar") return; // needs a real upload, not a dropped URL
                      const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
                      if (url) setRefImages((prev) => [...prev, url]);
                    }}
                    className="aspect-video rounded-lg border border-dashed border-visiyon-text-3/20 bg-black/20 flex flex-col items-center justify-center gap-1 text-visiyon-text-3 hover:bg-black/30 hover:text-visiyon-text-2 transition-colors disabled:opacity-50"
                  >
                    {uploadingRefImage ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    <span className="text-[10.5px]">{uploadingRefImage ? "Uploading…" : "Reference"}</span>
                  </button>
                );
              })}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleRefUpload} />

            {/* Motion Control: the reference video whose movement gets
                transferred onto the character image above. */}
            {modality === "motion" && (
              <div className="space-y-2">
                <p className="text-[11px] text-visiyon-text-3">Motion video</p>
                {motionVideoUrl ? (
                  <div className="flex items-center gap-2 rounded-lg border border-visiyon-text-3/20 bg-black/20 px-3 py-2.5">
                    <VideoIcon size={14} className="shrink-0 text-visiyon-text-3" />
                    <span className="flex-1 min-w-0 truncate text-[12px] text-visiyon-text-2">{motionVideoName}</span>
                    <button
                      onClick={() => {
                        setMotionVideoUrl(null);
                        setMotionVideoName(null);
                      }}
                      className="shrink-0 h-5 w-5 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => motionVideoInputRef.current?.click()}
                    disabled={uploadingMotionVideo}
                    className="w-full aspect-video rounded-lg border border-dashed border-visiyon-text-3/20 bg-black/20 flex flex-col items-center justify-center gap-1 text-visiyon-text-3 hover:bg-black/30 hover:text-visiyon-text-2 transition-colors disabled:opacity-50"
                  >
                    {uploadingMotionVideo ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    <span className="text-[11px]">{uploadingMotionVideo ? "Uploading…" : "Upload motion video (MP4/MOV, 3–30s)"}</span>
                  </button>
                )}
                <input
                  ref={motionVideoInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime"
                  className="hidden"
                  onChange={handleMotionVideoUpload}
                />

                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-visiyon-text-3 mr-1">Character comes from</span>
                  {(["image", "video"] as const).map((o) => (
                    <button
                      key={o}
                      onClick={() => setCharacterOrientation(o)}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                        characterOrientation === o ? "bg-visiyon-accent text-visiyon-bg" : "bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2"
                      }`}
                    >
                      {o === "image" ? "the image" : "the video"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Avatar: the audio track the face image lip-syncs to. */}
            {modality === "avatar" && (
              <div className="space-y-2">
                <p className="text-[11px] text-visiyon-text-3">Audio track</p>
                {avatarAudioUrl ? (
                  <div className="flex items-center gap-2 rounded-lg border border-visiyon-text-3/20 bg-black/20 px-3 py-2.5">
                    <VideoIcon size={14} className="shrink-0 text-visiyon-text-3" />
                    <span className="flex-1 min-w-0 truncate text-[12px] text-visiyon-text-2">{avatarAudioName}</span>
                    <button
                      onClick={() => {
                        setAvatarAudioUrl(null);
                        setAvatarAudioName(null);
                      }}
                      className="shrink-0 h-5 w-5 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => avatarAudioInputRef.current?.click()}
                    disabled={uploadingAvatarAudio}
                    className="w-full aspect-video rounded-lg border border-dashed border-visiyon-text-3/20 bg-black/20 flex flex-col items-center justify-center gap-1 text-visiyon-text-3 hover:bg-black/30 hover:text-visiyon-text-2 transition-colors disabled:opacity-50"
                  >
                    {uploadingAvatarAudio ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    <span className="text-[11px]">{uploadingAvatarAudio ? "Uploading…" : "Upload audio (MP3/WAV/M4A/AAC)"}</span>
                  </button>
                )}
                <input
                  ref={avatarAudioInputRef}
                  type="file"
                  accept="audio/mpeg,audio/mp3,audio/wav,audio/m4a,audio/x-m4a,audio/mp4,audio/aac"
                  className="hidden"
                  onChange={handleAvatarAudioUpload}
                />
              </div>
            )}

            {/* Bind elements — only kie.ai's kling-3.0/video model accepts these */}
            {modality === "video" && modelKey === "kling-3-0" && (
              <div className="rounded-lg border border-visiyon-text-3/20 overflow-hidden">
                <button
                  onClick={() => setElementPanelOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-[12.5px] text-visiyon-text-2 hover:bg-white/5"
                >
                  <span>
                    Bind elements to enhance consistency
                    {boundNames.length > 0 && <span className="text-visiyon-accent"> ({boundNames.length})</span>}
                  </span>
                  <ChevronDown size={13} className={elementPanelOpen ? "rotate-180 transition-transform" : "transition-transform"} />
                </button>

                {elementPanelOpen && (
                  <div className="border-t border-visiyon-text-3/20 p-2.5 space-y-2">
                    <input
                      value={elementSearch}
                      onChange={(e) => setElementSearch(e.target.value)}
                      placeholder="Search by element name"
                      className="w-full px-2.5 py-1.5 rounded-md bg-black/30 text-[12px] outline-none placeholder:text-visiyon-text-3"
                    />

                    <div className="flex flex-wrap gap-1.5">
                      {elements
                        .filter((e) => e.name.toLowerCase().includes(elementSearch.toLowerCase()))
                        .map((e) => (
                          <div
                            key={e.id}
                            className={`flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full border text-[11.5px] cursor-pointer ${
                              boundNames.includes(e.name)
                                ? "border-visiyon-accent bg-visiyon-accent/10 text-visiyon-accent"
                                : "border-visiyon-text-3/30 text-visiyon-text-2 hover:bg-white/5"
                            }`}
                            onClick={() => toggleBoundElement(e.name)}
                          >
                            {e.imageUrls?.[0] && (
                              <img src={e.imageUrls[0]} alt={e.name} className="h-5 w-5 rounded-full object-cover" />
                            )}
                            @{e.name}
                            <button
                              onClick={(ev) => {
                                ev.stopPropagation();
                                removeElement(e.id, e.name);
                              }}
                              className="hover:text-red-400"
                              title="Delete element"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        ))}

                      <button
                        onClick={() => setNewElementOpen((v) => !v)}
                        className="h-7 w-7 rounded-full border border-dashed border-visiyon-text-3/40 flex items-center justify-center text-visiyon-text-3 hover:text-visiyon-text-2"
                        title="Create element"
                      >
                        +
                      </button>
                    </div>

                    {newElementOpen && (
                      <div className="pt-2 border-t border-visiyon-text-3/10 space-y-2">
                        <input
                          value={newElementName}
                          onChange={(e) => setNewElementName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                          placeholder="Name (e.g. dog) — used as @dog in your prompt"
                          className="w-full px-2.5 py-1.5 rounded-md bg-black/30 text-[12px] outline-none placeholder:text-visiyon-text-3"
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {newElementImages.map((src, i) => (
                            <div key={i} className="relative h-12 w-12 rounded overflow-hidden bg-black/30">
                              <img src={src} className="h-full w-full object-cover" alt="" />
                              <button
                                onClick={() => setNewElementImages((prev) => prev.filter((_, idx) => idx !== i))}
                                className="absolute top-0 right-0 h-3.5 w-3.5 bg-black/70 flex items-center justify-center"
                              >
                                <X size={8} />
                              </button>
                            </div>
                          ))}
                          {newElementImages.length < 6 && (
                            <button
                              onClick={() => elementFileInputRef.current?.click()}
                              disabled={uploadingElementImage}
                              className="h-12 w-12 rounded border border-dashed border-visiyon-text-3/30 flex items-center justify-center text-visiyon-text-3 hover:bg-white/5 disabled:opacity-40"
                            >
                              {uploadingElementImage ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                            </button>
                          )}
                        </div>
                        <input ref={elementFileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleNewElementImage} />
                        <button
                          onClick={createElement}
                          disabled={!newElementName.trim() || newElementImages.length < 2 || uploadingElementImage || savingElement}
                          className="w-full py-1.5 rounded-md bg-white text-black text-[12px] font-medium disabled:opacity-40"
                        >
                          {savingElement ? "Saving…" : "Save element"}
                        </button>
                        {newElementImages.length > 0 && newElementImages.length < 2 && (
                          <p className="text-[10.5px] text-visiyon-text-3">kie.ai requires 2–4 images per element.</p>
                        )}
                      </div>
                    )}

                    <p className="text-[10.5px] text-visiyon-text-3 pt-1">
                      Use @name in your prompt to reference a bound element (e.g. "a happy @dog running").
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Prompt — also a drop target: dragging an image straight onto
                the textarea (not just the small Reference box above)
                uploads it as a reference and auto-fills the description,
                same as clicking the Reference box would. */}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file && file.type.startsWith("image/")) {
                  if (modality !== "motion" && modality !== "avatar" && refImages.length >= 2) return;
                  uploadRefImage(file);
                  return;
                }
                if (modality === "motion" || modality === "avatar") return;
                const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
                if (url && chatModel && !prompt.trim()) {
                  setRefImages((prev) => [...prev, url]);
                  describeImage(url, chatModel)
                    .then(({ description }) => {
                      if (description) setPrompt((cur) => (cur.trim() ? cur : description));
                    })
                    .catch(() => {});
                } else if (url) {
                  setRefImages((prev) => [...prev, url]);
                }
              }}
              placeholder={modality === "image" ? "Describe the image you want to generate…" : "Describe the video you want to generate…"}
              rows={6}
              className="w-full flex-1 min-h-[120px] rounded-xl bg-black/30 outline-none resize-none text-[13.5px] leading-relaxed px-3 py-2.5 placeholder:text-visiyon-text-3"
            />
            {errorMsg && (
              <p className="text-[12px] text-red-400 flex items-center gap-1.5">
                <AlertTriangle size={12} /> {errorMsg}
              </p>
            )}

            {/* Options row */}
            {modality === "image" ? (
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map((ar) => (
                  <button
                    key={ar}
                    onClick={() => setAspectRatio(ar)}
                    className={`rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ${
                      aspectRatio === ar ? "bg-visiyon-accent text-visiyon-bg" : "bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2"
                    }`}
                  >
                    {ar}
                  </button>
                ))}
                <button
                  onClick={handleImprovePrompt}
                  disabled={!prompt.trim() || isImprovingPrompt}
                  title="Turn your short idea into a full, detailed prompt"
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2 transition-colors disabled:opacity-40"
                >
                  {isImprovingPrompt ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  Improve prompt
                </button>
              </div>
            ) : modality === "video" ? (
              <div className="flex flex-wrap gap-1.5">
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDurationSeconds(d)}
                    className={`rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ${
                      durationSeconds === d ? "bg-visiyon-accent text-visiyon-bg" : "bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2"
                    }`}
                  >
                    {d}s
                  </button>
                ))}
                <button
                  onClick={() => setNativeAudio((v) => !v)}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ${
                    nativeAudio ? "bg-visiyon-accent text-visiyon-bg" : "bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2"
                  }`}
                >
                  {nativeAudio ? <Check size={12} /> : null} Native Audio
                </button>
                <button
                  onClick={handleImprovePrompt}
                  disabled={!prompt.trim() || isImprovingPrompt}
                  title="Turn your short idea into a full, detailed prompt"
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2 transition-colors disabled:opacity-40"
                >
                  {isImprovingPrompt ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  Improve prompt
                </button>
              </div>
            ) : (
              // Motion Control / Avatar: duration/audio don't apply — the
              // output follows the uploaded motion video's / audio track's
              // own length.
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={handleImprovePrompt}
                  disabled={!prompt.trim() || isImprovingPrompt}
                  title="Turn your short idea into a full, detailed prompt"
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium bg-black/30 text-visiyon-text-3 hover:text-visiyon-text-2 transition-colors disabled:opacity-40"
                >
                  {isImprovingPrompt ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  Improve prompt
                </button>
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={
                // A prompt isn't strictly required anymore when a
                // reference image is attached — handleGenerate fills in a
                // sensible default in that case (see its comment).
                (!prompt.trim() && !refImages[0]) ||
                busy ||
                enabled === false ||
                (modality === "motion" && (!refImages[0] || !motionVideoUrl)) ||
                (modality === "avatar" && (!refImages[0] || !avatarAudioUrl))
              }
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-visiyon-accent text-visiyon-bg text-[13.5px] font-semibold py-2.5 disabled:opacity-40 hover:opacity-90 transition"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              Generate
              {estimatedCredits != null && (
                <span className="text-[11.5px] font-normal opacity-75">— {estimatedCredits} credits</span>
              )}
            </button>
            {estimatedCredits != null && credits != null && credits < estimatedCredits && (
              <p className="text-[11.5px] text-red-400 mt-1.5 text-center">
                Not enough credits — you have {credits}, this needs {estimatedCredits}.{" "}
                <button
                  onClick={() => {
                    setCreditsShortfall({ required: estimatedCredits, available: credits });
                    setShowBuyCredits(true);
                  }}
                  className="underline hover:no-underline"
                >
                  Buy credits
                </button>
              </p>
            )}
            </div>
            {panelOpen && (
              <div
                onPointerDown={onPanelResizeDown}
                onPointerMove={onPanelResizeMove}
                onPointerUp={onPanelResizeUp}
                onPointerCancel={onPanelResizeUp}
                className="hidden sm:block w-1 shrink-0 cursor-col-resize hover:bg-visiyon-accent/40 active:bg-visiyon-accent/60 transition-colors touch-none"
                title="Drag to resize"
              />
            )}
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className="hidden sm:flex self-start mt-3 h-7 w-4 shrink-0 rounded-r-md bg-visiyon-panel2 hover:brightness-125 items-center justify-center text-visiyon-text-3"
              title={panelOpen ? "Collapse panel" : "Expand panel"}
            >
              {panelOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>

          {/* ================= Center: big preview stage ================= */}
          <main ref={mainRef} className="flex-1 min-w-0 min-h-0 flex flex-col sm:overflow-y-auto relative">
            <div
              ref={stageElRef}
              // While a drag is live, isResizingStage is true and this
              // object has no "height" key at all — so no matter how many
              // times something ELSE forces this component to re-render
              // (and it does: generation-status polling re-renders the
              // whole tree), React never touches the height property on
              // this node. If it did, it would keep re-applying the STALE
              // committed `stageHeight` state (which only updates on
              // pointer-up) and silently snap back whatever the drag's rAF
              // loop had just set — making the drag look like it does
              // nothing. Only once the drag ends does this go back to
              // being state-controlled with the final, real value.
              style={isResizingStage ? undefined : { height: stageHeight }}
              className="min-h-[160px] shrink-0 flex items-center justify-center bg-black/40 relative"
            >
              {!selected && (
                <p className="text-visiyon-text-3 text-[13px]">Nothing generated yet — describe something on the left to get started.</p>
              )}
              {selected?.status === "PENDING" && (
                <div className="flex flex-col items-center gap-2 text-visiyon-text-3">
                  <Loader2 size={26} className="animate-spin" />
                  <span className="text-[12.5px]">Generating…</span>
                </div>
              )}
              {selected?.status === "FAILED" && (
                <div className="flex flex-col items-center gap-2 text-red-400 px-6 text-center">
                  <AlertTriangle size={22} />
                  <span className="text-[12.5px]">{selected.error || "Generation failed"}</span>
                </div>
              )}
              {selected?.status === "COMPLETE" && selected.resultUrls?.[0] && (
                <>
                  {selected.modality === "image" ? (
                    <div className="group relative h-full w-full flex items-center justify-center">
                      <img
                        src={selected.resultUrls[0]}
                        alt={selected.prompt}
                        draggable={!isResizingStage}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/uri-list", selected.resultUrls![0]);
                          e.dataTransfer.setData("text/plain", selected.resultUrls![0]);
                        }}
                        onClick={() => setLightboxOpen(true)}
                        className="max-h-full max-w-full object-contain cursor-zoom-in"
                      />
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 hidden group-hover:flex items-center gap-0 rounded-lg bg-black/80 text-white text-[12.5px] overflow-hidden">
                        <button onClick={() => sendToVideo(selected)} className="px-3 py-2 hover:bg-white/10 whitespace-nowrap">
                          Generate Video
                        </button>
                        <span className="w-px self-stretch bg-white/15" />
                        <button onClick={() => upscaleSelected(selected)} className="px-3 py-2 hover:bg-white/10 whitespace-nowrap">
                          Upscale
                        </button>
                        <span className="w-px self-stretch bg-white/15" />
                        <button
                          disabled
                          title="Coming soon — needs a mask editor"
                          className="px-3 py-2 whitespace-nowrap text-white/30 cursor-not-allowed"
                        >
                          Inpaint
                        </button>
                        <span className="w-px self-stretch bg-white/15" />
                        <button
                          disabled
                          title="Coming soon — needs a mask editor"
                          className="px-3 py-2 whitespace-nowrap text-white/30 cursor-not-allowed"
                        >
                          Expand
                        </button>
                        <span className="w-px self-stretch bg-white/15" />
                        <button
                          disabled
                          title="Coming soon — needs a mask editor"
                          className="px-3 py-2 whitespace-nowrap text-white/30 cursor-not-allowed"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <video src={selected.resultUrls[0]} controls autoPlay loop className="max-h-full max-w-full object-contain" />
                  )}
                  <button
                    onClick={() => setLightboxOpen(true)}
                    className="absolute top-3 right-3 h-8 w-8 flex items-center justify-center rounded-lg bg-black/50 hover:bg-black/70 text-white"
                    title="Expand"
                  >
                    <Maximize2 size={14} />
                  </button>
                </>
              )}
            </div>

            {lightboxOpen && selected?.resultUrls?.[0] && (
              <div
                className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
                onClick={() => setLightboxOpen(false)}
              >
                {selected.modality === "image" ? (
                  <img
                    src={selected.resultUrls[0]}
                    alt={selected.prompt}
                    onClick={(e) => e.stopPropagation()}
                    className="max-h-[90vh] max-w-[90vw] object-contain"
                  />
                ) : (
                  <video
                    src={selected.resultUrls[0]}
                    controls
                    autoPlay
                    loop
                    onClick={(e) => e.stopPropagation()}
                    className="max-h-[90vh] max-w-[90vw] object-contain"
                  />
                )}
                <button
                  onClick={() => setLightboxOpen(false)}
                  className="absolute top-4 right-4 h-9 w-9 flex items-center justify-center rounded-lg bg-black/50 hover:bg-black/70 text-white"
                  title="Close"
                >
                  <X size={18} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadResult(selected);
                  }}
                  className="absolute top-4 right-16 h-9 w-9 flex items-center justify-center rounded-lg bg-black/50 hover:bg-black/70 text-white"
                  title="Download"
                >
                  <Download size={16} />
                </button>
              </div>
            )}

            {selected && (
              <div className="shrink-0 flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-2.5 bg-visiyon-panel2 text-visiyon-text-3 overflow-visible">
                <span className="flex items-center gap-1.5 text-[12px]">
                  {selected.modality === "image" ? <ImageIcon size={13} /> : <VideoIcon size={13} />}
                  {models.find((m) => m.key === selected.modelKey)?.label || selected.modelKey}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px]">{selected.prompt}</span>
                <button
                  onClick={() => toggleReaction(selected.id, "like")}
                  className={reactions[selected.id] === "like" ? "text-visiyon-accent" : "hover:text-visiyon-text-2"}
                  title="Like"
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  onClick={() => toggleReaction(selected.id, "dislike")}
                  className={reactions[selected.id] === "dislike" ? "text-visiyon-accent" : "hover:text-visiyon-text-2"}
                  title="Dislike"
                >
                  <ThumbsDown size={14} />
                </button>
                <button onClick={() => shareResult(selected)} className="hover:text-visiyon-text-2" title="Share">
                  <Send size={14} />
                </button>
                {selected.resultUrls?.[0] && (
                  <button onClick={() => downloadResult(selected)} className="hover:text-visiyon-text-2" title="Download">
                    <Download size={14} />
                  </button>
                )}
                <div className="relative" ref={moreMenuRef}>
                  <button
                    onClick={() => setMoreMenuFor((cur) => (cur === selected.id ? null : selected.id))}
                    className="hover:text-visiyon-text-2"
                    title="More"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {moreMenuFor === selected.id && (
                    <div className="absolute bottom-full right-0 mb-2 w-40 rounded-lg border border-white/10 bg-visiyon-panel2 shadow-lg py-1 text-[12.5px] z-50">
                      <button
                        onClick={() => {
                          copyPrompt(selected);
                          setMoreMenuFor(null);
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-white/5 text-visiyon-text-2"
                      >
                        Copy prompt
                      </button>
                      <button
                        onClick={() => {
                          deleteResult(selected.id);
                          setMoreMenuFor(null);
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-white/5 text-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggleFavorite(selected.id)}
                  className={favorites[selected.id] ? "text-yellow-400" : "hover:text-visiyon-text-2"}
                  title="Favorite"
                >
                  <Star size={14} fill={favorites[selected.id] ? "currentColor" : "none"} />
                </button>
                {selected.status === "COMPLETE" && (
                  <button
                    onClick={() => togglePublish(selected)}
                    disabled={publishingId === selected.id}
                    className={
                      "text-[12px] font-medium px-3 py-1 rounded-lg border disabled:opacity-50 " +
                      (selected.isPublic
                        ? "bg-visiyon-accent/20 text-visiyon-accent border-visiyon-accent/40"
                        : "bg-white text-black border-white/15")
                    }
                    title={selected.isPublic ? "Published to Explore" : "Publish to Explore"}
                  >
                    {publishingId === selected.id ? "…" : selected.isPublic ? "Published" : "Publish"}
                  </button>
                )}
              </div>
            )}

            {toast && (
              <div className="absolute bottom-16 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-black/80 text-white text-[12px] z-20">
                {toast}
              </div>
            )}

            {/* Drag up to shrink the preview and reveal more of the grid
                below — handy once a session has accumulated a lot of
                generations. Drag down to grow it back. The handle tracks
                the cursor 1:1. Bigger touch target + onTouchStart so it
                also works with a finger on mobile, not just a mouse. */}
            <div
              onPointerDown={startStageResize}
              className="h-3 -my-1 shrink-0 flex items-center justify-center cursor-row-resize touch-none z-10 relative"
              title="Drag to resize"
            >
              <div className="h-1 w-10 rounded-full bg-white/15 hover:bg-visiyon-accent/50 active:bg-visiyon-accent/70 transition-colors" />
            </div>

            {/* Results grid below the stage. pointer-events is switched off
                for the duration of a stage-resize drag — see the note by
                isResizingStage above: these thumbnails are natively
                draggable, and the cursor has to cross them on the way down,
                so without this a resize drag could get hijacked into an
                image drag partway through. */}
            <div
              ref={assetsRef}
              className="p-3"
              style={isResizingStage ? { pointerEvents: "none" } : undefined}
            >
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
                {generations.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setSelectedId(g.id)}
                    draggable={!isResizingStage && g.status === "COMPLETE" && !!g.resultUrls?.[0]}
                    onDragStart={(e) => {
                      if (g.resultUrls?.[0]) {
                        e.dataTransfer.setData("text/uri-list", g.resultUrls[0]);
                        e.dataTransfer.setData("text/plain", g.resultUrls[0]);
                      }
                    }}
                    className={`aspect-square rounded-lg overflow-hidden relative bg-black/30 flex items-center justify-center ${
                      selectedId === g.id
                        ? "ring-1 ring-inset ring-visiyon-text/70"
                        : g.status === "PENDING"
                        ? "ring-1 ring-inset ring-visiyon-text-3/30"
                        : "hover:brightness-110"
                    }`}
                  >
                    {g.status === "PENDING" && <Loader2 size={16} className="animate-spin text-visiyon-text-3" />}
                    {g.status === "FAILED" && <AlertTriangle size={16} className="text-red-400" />}
                    {g.status === "COMPLETE" && g.resultUrls?.[0] && (
                      g.modality === "image" ? (
                        <img src={g.resultUrls[0]} alt={g.prompt} className="w-full h-full object-cover" />
                      ) : (
                        <video src={g.resultUrls[0]} className="w-full h-full object-cover" muted />
                      )
                    )}
                    {g.modality === "video" && (
                      <span className="absolute bottom-1 right-1 h-4 w-4 rounded bg-black/60 flex items-center justify-center">
                        <VideoIcon size={9} className="text-white" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
