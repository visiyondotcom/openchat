"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useRequireAuth } from "@/lib/useAuth";
import {
  Sparkles,
  Upload,
  Download,
  Undo2,
  Redo2,
  Crop as CropIcon,
  Paintbrush,
  Eraser,
  Type as TypeIcon,
  Square,
  Circle as CircleIcon,
  Minus,
  MousePointer2,
  ZoomIn,
  ZoomOut,
  Check,
  X,
  RotateCcw,
  FlipHorizontal2,
  FlipVertical2,
  SlidersHorizontal,
  Wand2,
  Send,
  Compass,
  FolderOpen,
  Clapperboard,
  Grid3x3,
  Menu,
} from "lucide-react";
import UserMenu from "@/components/UserMenu";

// Same left-rail shape/behaviour as /generate: every tool gets its own
// accent color, and this page keeps its own copy since the rail isn't a
// shared component across pages.
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

// ---- A self-contained, single-canvas raster photo editor ("Photoshop"
// entry in the sidebar). No third-party canvas/editor library — everything
// here is native <canvas> 2D so it needs zero extra dependencies.
//
// Model: one "work" canvas holds committed pixels (the loaded photo, plus
// every brush stroke / shape / text / crop baked in). Adjustment sliders
// (brightness, contrast, ...) are a *live* CSS-filter preview drawn on top
// of the work canvas into a separate "display" canvas, and only get baked
// into the work canvas's real pixels when the user clicks "Apply". Undo/
// redo is a plain stack of the work canvas's dataURLs — simple and fully
// correct for a tool like this, at the cost of some memory for very large
// images (capped via MAX_DIMENSION below). ----

type Tool = "move" | "crop" | "brush" | "eraser" | "text" | "rect" | "ellipse" | "line" | "eyedropper";

type Adjustments = {
  brightness: number; // 100 = neutral, CSS filter %
  contrast: number;
  saturation: number;
  hue: number; // degrees
  blur: number; // px
  grayscale: number; // %
  sepia: number; // %
  invert: number; // %
};

const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hue: 0,
  blur: 0,
  grayscale: 0,
  sepia: 0,
  invert: 0,
};

const MAX_DIMENSION = 2400; // cap very large uploads so canvas ops stay fast
const MAX_HISTORY = 30;

const FILTER_PRESETS: { label: string; value: Partial<Adjustments> }[] = [
  { label: "None", value: {} },
  { label: "B&W", value: { grayscale: 100 } },
  { label: "Sepia", value: { sepia: 80 } },
  { label: "Vintage", value: { sepia: 40, contrast: 90, brightness: 105, saturation: 85 } },
  { label: "Cold", value: { hue: 190, saturation: 110 } },
  { label: "Warm", value: { hue: 15, saturation: 115, brightness: 105 } },
  { label: "Vivid", value: { saturation: 160, contrast: 115 } },
  { label: "Faded", value: { contrast: 80, brightness: 110, saturation: 70 } },
  { label: "Noir", value: { grayscale: 100, contrast: 130, brightness: 90 } },
  { label: "Invert", value: { invert: 100 } },
];

function buildFilterString(a: Adjustments): string {
  const parts: string[] = [];
  if (a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
  if (a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
  if (a.saturation !== 100) parts.push(`saturate(${a.saturation}%)`);
  if (a.hue !== 0) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.blur > 0) parts.push(`blur(${a.blur}px)`);
  if (a.grayscale > 0) parts.push(`grayscale(${a.grayscale}%)`);
  if (a.sepia > 0) parts.push(`sepia(${a.sepia}%)`);
  if (a.invert > 0) parts.push(`invert(${a.invert}%)`);
  return parts.length ? parts.join(" ") : "none";
}

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`h-10 w-10 flex items-center justify-center rounded-lg transition-colors ${
        active ? "bg-visiyon-accent text-visiyon-bg" : "bg-black/30 text-visiyon-text-2 hover:bg-black/50"
      }`}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-visiyon-text-3">
        <span>{label}</span>
        <span>
          {value}
          {suffix || ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-visiyon-accent"
      />
    </div>
  );
}

export default function EditorPage() {
  const { ready } = useRequireAuth();
  // Mobile (<sm): the rail is hidden by default and slides in as an
  // overlay drawer, same behaviour as /generate.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Mobile (<sm): the 260px properties panel used to be a permanent
  // fixed-width column, which on a phone left almost no room for the
  // canvas itself. It now collapses into a slide-in drawer, toggled from
  // the header, same pattern as the left icon rail.
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const router = useRouter();

  const workCanvasRef = useRef<HTMLCanvasElement | null>(null); // committed pixels
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null); // what's shown (work + live filter preview)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [hasImage, setHasImage] = useState(false);
  const [tool, setTool] = useState<Tool>("move");
  const [zoom, setZoom] = useState(1);

  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [adjustments, setAdjustments] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [adjustmentsDirty, setAdjustmentsDirty] = useState(false);

  const [brushColor, setBrushColor] = useState("#22d3ee");
  const [brushSize, setBrushSize] = useState(16);
  const [brushOpacity, setBrushOpacity] = useState(100);

  const [shapeColor, setShapeColor] = useState("#f472b6");
  const [shapeFilled, setShapeFilled] = useState(false);
  const [shapeStroke, setShapeStroke] = useState(4);

  const [textValue, setTextValue] = useState("");
  const [textSize, setTextSize] = useState(48);
  const [textColor, setTextColor] = useState("#ffffff");
  const [textBold, setTextBold] = useState(true);

  // ---- Text layers: text is kept as an editable/movable object (like a
  // Photoshop text layer) instead of being baked into pixels immediately.
  // It only gets flattened into the raster when the image is exported
  // (download / send to generate). This is what lets a text box be
  // re-opened and dragged again later, any number of times. ----
  type TextLayer = { id: string; x: number; y: number; value: string; size: number; color: string; bold: boolean };
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null); // null = editing a brand-new not-yet-placed layer
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);
  const draggingText = useRef<{ id: string | null; dx: number; dy: number } | null>(null);
  // While a placed layer is being dragged, it's hidden from the baked
  // canvas render and shown instead as a plain DOM ghost that we move
  // directly (see below) — so dragging never waits on a canvas redraw.
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const pendingBoxRef = useRef<HTMLDivElement | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

  function measureTextLayer(l: { value: string; size: number; bold: boolean }) {
    const ctx = getWorkCtx();
    const w = ctx ? (() => {
      ctx.save();
      ctx.font = `${l.bold ? "700" : "400"} ${l.size}px Inter, sans-serif`;
      const width = ctx.measureText(l.value || " ").width;
      ctx.restore();
      return width;
    })() : (l.value.length * l.size * 0.55);
    return { w, h: l.size * 1.2 };
  }

  const [panelTab, setPanelTab] = useState<"adjust" | "filters">("adjust");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isDrawing = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  function getWorkCtx() {
    return workCanvasRef.current?.getContext("2d") || null;
  }
  function getDisplayCtx() {
    return displayCanvasRef.current?.getContext("2d") || null;
  }

  // Redraw the visible canvas = work canvas pixels + live adjustment filter.
  const renderDisplay = useCallback(() => {
    const work = workCanvasRef.current;
    const display = displayCanvasRef.current;
    const dctx = getDisplayCtx();
    if (!work || !display || !dctx) return;
    display.width = work.width;
    display.height = work.height;
    dctx.save();
    dctx.filter = buildFilterString(adjustments);
    dctx.clearRect(0, 0, display.width, display.height);
    dctx.drawImage(work, 0, 0);
    dctx.restore();
    // Text layers draw on top, unfiltered, and stay separate from the
    // baked pixels so they can keep being edited/moved.
    dctx.save();
    dctx.textBaseline = "top";
    for (const l of textLayers) {
      if (l.id === editingTextId || l.id === draggingLayerId) continue; // shown via a live DOM overlay instead
      dctx.fillStyle = l.color;
      dctx.font = `${l.bold ? "700" : "400"} ${l.size}px Inter, sans-serif`;
      dctx.fillText(l.value, l.x, l.y);
    }
    dctx.restore();
  }, [adjustments, textLayers, editingTextId, draggingLayerId]);

  useEffect(() => {
    renderDisplay();
  }, [renderDisplay, historyIndex]);

  function pushHistory() {
    const work = workCanvasRef.current;
    if (!work) return;
    const dataUrl = work.toDataURL("image/png");
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      const next = [...trimmed, dataUrl].slice(-MAX_HISTORY);
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function loadImageIntoWork(img: HTMLImageElement) {
    let { naturalWidth: w, naturalHeight: h } = img;
    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const work = workCanvasRef.current;
    if (!work) return;
    work.width = w;
    work.height = h;
    const ctx = work.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    setHasImage(true);
    setAdjustments(NEUTRAL_ADJUSTMENTS);
    setAdjustmentsDirty(false);
    setTextLayers([]);
    setSelectedTextId(null);
    setEditingTextId(null);
    setPendingText(null);
    setHistory([work.toDataURL("image/png")]);
    setHistoryIndex(0);
    setTimeout(renderDisplay, 0);
  }

  function handleFileOpen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => loadImageIntoWork(img);
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  function restoreFromHistory(index: number) {
    const url = history[index];
    const work = workCanvasRef.current;
    if (!url || !work) return;
    const img = new Image();
    img.onload = () => {
      work.width = img.naturalWidth;
      work.height = img.naturalHeight;
      const ctx = work.getContext("2d")!;
      ctx.clearRect(0, 0, work.width, work.height);
      ctx.drawImage(img, 0, 0);
      renderDisplay();
    };
    img.src = url;
  }

  function undo() {
    if (historyIndex <= 0) return;
    const next = historyIndex - 1;
    setHistoryIndex(next);
    restoreFromHistory(next);
  }
  function redo() {
    if (historyIndex >= history.length - 1) return;
    const next = historyIndex + 1;
    setHistoryIndex(next);
    restoreFromHistory(next);
  }

  // ---- Adjustments: live preview via CSS filter; "Apply" bakes pixels ----
  function applyAdjustments() {
    const work = workCanvasRef.current;
    if (!work || !adjustmentsDirty) return;
    const baked = document.createElement("canvas");
    baked.width = work.width;
    baked.height = work.height;
    const bctx = baked.getContext("2d")!;
    bctx.filter = buildFilterString(adjustments);
    bctx.drawImage(work, 0, 0);
    const wctx = work.getContext("2d")!;
    wctx.clearRect(0, 0, work.width, work.height);
    wctx.drawImage(baked, 0, 0);
    setAdjustments(NEUTRAL_ADJUSTMENTS);
    setAdjustmentsDirty(false);
    pushHistory();
  }
  function resetAdjustments() {
    setAdjustments(NEUTRAL_ADJUSTMENTS);
    setAdjustmentsDirty(false);
  }
  function applyPreset(preset: Partial<Adjustments>) {
    setAdjustments({ ...NEUTRAL_ADJUSTMENTS, ...preset });
    setAdjustmentsDirty(true);
  }

  // ---- Pointer coordinate helper: screen px -> work-canvas px ----
  function toCanvasPoint(e: React.MouseEvent): { x: number; y: number } {
    const display = displayCanvasRef.current!;
    const rect = display.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }

  function handleCanvasMouseDown(e: React.MouseEvent) {
    if (!hasImage) return;
    const pt = toCanvasPoint(e);

    if (tool === "brush" || tool === "eraser") {
      isDrawing.current = true;
      const ctx = getWorkCtx();
      if (!ctx) return;
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.globalAlpha = brushOpacity / 100;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = brushColor;
      ctx.lineWidth = brushSize;
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      dragStart.current = pt;
      return;
    }

    if (tool === "crop") {
      dragStart.current = pt;
      setCropRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
      isDrawing.current = true;
      return;
    }

    if (tool === "rect" || tool === "ellipse" || tool === "line") {
      dragStart.current = pt;
      setShapePreview({ x: pt.x, y: pt.y, w: 0, h: 0 });
      isDrawing.current = true;
      return;
    }

    if (tool === "text") {
      // Clicking an existing text layer re-opens it for editing/moving;
      // clicking empty space starts placing a brand-new one.
      const hit = hitTestText(pt);
      if (hit) {
        openTextForEdit(hit.id);
      } else {
        setEditingTextId(null);
        setPendingText(pt);
        setTextValue("");
      }
      return;
    }

    if (tool === "move") {
      const hit = hitTestText(pt);
      if (hit) {
        setSelectedTextId(hit.id);
        beginLayerDrag(hit, e);
      } else {
        setSelectedTextId(null);
      }
      return;
    }

    if (tool === "eyedropper") {
      const ctx = getWorkCtx();
      if (!ctx) return;
      const data = ctx.getImageData(Math.round(pt.x), Math.round(pt.y), 1, 1).data;
      const hex = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      setBrushColor(hex);
      setShapeColor(hex);
      return;
    }
  }

  function handleCanvasMouseMove(e: React.MouseEvent) {
    if (!isDrawing.current || !hasImage) return;
    const pt = toCanvasPoint(e);

    if (tool === "brush" || tool === "eraser") {
      const ctx = getWorkCtx();
      if (!ctx) return;
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      renderDisplay();
      return;
    }

    if (tool === "crop" && dragStart.current) {
      const s = dragStart.current;
      setCropRect({ x: Math.min(s.x, pt.x), y: Math.min(s.y, pt.y), w: Math.abs(pt.x - s.x), h: Math.abs(pt.y - s.y) });
      return;
    }

    if ((tool === "rect" || tool === "ellipse" || tool === "line") && dragStart.current) {
      const s = dragStart.current;
      setShapePreview({ x: Math.min(s.x, pt.x), y: Math.min(s.y, pt.y), w: Math.abs(pt.x - s.x), h: Math.abs(pt.y - s.y) });
      return;
    }
  }

  function handleCanvasDoubleClick(e: React.MouseEvent) {
    if (!hasImage || tool !== "move") return;
    const hit = hitTestText(toCanvasPoint(e));
    if (hit) openTextForEdit(hit.id);
  }

  function handleCanvasMouseUp(e: React.MouseEvent) {
    if (!isDrawing.current) return;
    isDrawing.current = false;

    if (tool === "brush" || tool === "eraser") {
      const ctx = getWorkCtx();
      ctx?.closePath();
      pushHistory();
      return;
    }

    if (tool === "rect" || tool === "ellipse" || tool === "line") {
      const pt = toCanvasPoint(e);
      const s = dragStart.current;
      const ctx = getWorkCtx();
      if (s && ctx) {
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.strokeStyle = shapeColor;
        ctx.fillStyle = shapeColor;
        ctx.lineWidth = shapeStroke;
        if (tool === "line") {
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(pt.x, pt.y);
          ctx.stroke();
        } else {
          const x = Math.min(s.x, pt.x);
          const y = Math.min(s.y, pt.y);
          const w = Math.abs(pt.x - s.x);
          const h = Math.abs(pt.y - s.y);
          if (tool === "rect") {
            shapeFilled ? ctx.fillRect(x, y, w, h) : ctx.strokeRect(x, y, w, h);
          } else {
            ctx.beginPath();
            ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            shapeFilled ? ctx.fill() : ctx.stroke();
          }
        }
        renderDisplay();
        pushHistory();
      }
      setShapePreview(null);
      dragStart.current = null;
      return;
    }

    dragStart.current = null;
  }

  function applyCrop() {
    const work = workCanvasRef.current;
    if (!work || !cropRect || cropRect.w < 4 || cropRect.h < 4) {
      setCropRect(null);
      return;
    }
    const x = Math.round(cropRect.x);
    const y = Math.round(cropRect.y);
    const w = Math.round(cropRect.w);
    const h = Math.round(cropRect.h);
    const ctx = work.getContext("2d")!;
    const data = ctx.getImageData(x, y, w, h);
    work.width = w;
    work.height = h;
    ctx.putImageData(data, 0, 0);
    setCropRect(null);
    setTool("move");
    renderDisplay();
    pushHistory();
  }

  function hitTestText(pt: { x: number; y: number }) {
    for (let i = textLayers.length - 1; i >= 0; i--) {
      const l = textLayers[i];
      const { w, h } = measureTextLayer(l);
      if (pt.x >= l.x && pt.x <= l.x + w && pt.y >= l.y && pt.y <= l.y + h) return l;
    }
    return null;
  }

  function openTextForEdit(id: string) {
    const l = textLayers.find((t) => t.id === id);
    if (!l) return;
    setEditingTextId(id);
    setSelectedTextId(id);
    setPendingText({ x: l.x, y: l.y });
    setTextValue(l.value);
    setTextSize(l.size);
    setTextColor(l.color);
    setTextBold(l.bold);
  }

  // Confirms the text box currently being edited: updates the existing
  // layer, or creates a new one. Either way the text stays a layer — never
  // baked into pixels — so it can be reopened and moved again any time.
  function commitText() {
    if (!pendingText) return;
    if (!textValue.trim()) {
      cancelTextEdit();
      return;
    }
    if (editingTextId) {
      setTextLayers((prev) =>
        prev.map((l) =>
          l.id === editingTextId
            ? { ...l, x: pendingText.x, y: pendingText.y, value: textValue, size: textSize, color: textColor, bold: textBold }
            : l
        )
      );
    } else {
      const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      setTextLayers((prev) => [...prev, { id, x: pendingText.x, y: pendingText.y, value: textValue, size: textSize, color: textColor, bold: textBold }]);
      setSelectedTextId(id);
    }
    setPendingText(null);
    setEditingTextId(null);
    setTextValue("");
  }

  function cancelTextEdit() {
    setPendingText(null);
    setEditingTextId(null);
    setTextValue("");
  }

  function deleteSelectedText() {
    if (!selectedTextId) return;
    setTextLayers((prev) => prev.filter((l) => l.id !== selectedTextId));
    setSelectedTextId(null);
    if (editingTextId === selectedTextId) cancelTextEdit();
  }

  // ---- Dragging a text box (new-pending or an already-placed layer).
  // Listens on the window so the drag keeps tracking even if the pointer
  // moves past the small handle/canvas, in every direction. Position is
  // written straight to the DOM node's style on every mousemove — no
  // React state update, no canvas redraw, no rAF batching — so the box
  // tracks the pointer exactly, immediately. React state (and the real
  // canvas pixels, for a placed layer) is only touched once, on drop.
  const dragLatest = useRef<{ x: number; y: number } | null>(null);
  function startTextDrag(e: React.MouseEvent) {
    if (!pendingText) return;
    e.preventDefault();
    draggingText.current = { id: null, dx: e.clientX - pendingText.x * zoom, dy: e.clientY - pendingText.y * zoom };
  }
  function beginLayerDrag(l: TextLayer, e: React.MouseEvent) {
    e.preventDefault();
    setDraggingLayerId(l.id);
    draggingText.current = { id: l.id, dx: e.clientX - l.x * zoom, dy: e.clientY - l.y * zoom };
  }
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = draggingText.current;
      if (!drag) return;
      const x = (e.clientX - drag.dx) / zoom;
      const y = (e.clientY - drag.dy) / zoom;
      if (drag.id) {
        const node = dragGhostRef.current;
        if (node) {
          node.style.left = `${x * zoom}px`;
          node.style.top = `${y * zoom}px`;
        }
      } else {
        const node = pendingBoxRef.current;
        if (node) {
          node.style.left = `${x * zoom}px`;
          node.style.top = `${y * zoom}px`;
        }
      }
      dragLatest.current = { x, y };
    }
    function onUp() {
      const drag = draggingText.current;
      const pt = dragLatest.current;
      draggingText.current = null;
      dragLatest.current = null;
      if (!drag || !pt) return;
      if (drag.id) {
        // Commit the ghost's final position into real state once — this
        // is also what puts the layer back on the canvas (it was hidden
        // from the raster while draggingLayerId was set).
        setTextLayers((prev) => prev.map((l) => (l.id === drag.id ? { ...l, x: pt.x, y: pt.y } : l)));
        setDraggingLayerId(null);
      } else {
        setPendingText({ x: pt.x, y: pt.y });
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [zoom]);

  function flip(axis: "h" | "v") {
    const work = workCanvasRef.current;
    if (!work) return;
    const w = work.width;
    const h = work.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(work, 0, 0);
    const ctx = work.getContext("2d")!;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (axis === "h") {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, h);
      ctx.scale(1, -1);
    }
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    renderDisplay();
    pushHistory();
  }

  function rotate90() {
    const work = workCanvasRef.current;
    if (!work) return;
    const w = work.width;
    const h = work.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d")!.drawImage(work, 0, 0);
    work.width = h;
    work.height = w;
    const ctx = work.getContext("2d")!;
    ctx.clearRect(0, 0, h, w);
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(tmp, 0, 0);
    renderDisplay();
    pushHistory();
  }

  // Bake current live filter preview + all committed pixels into one
  // exportable dataURL, without mutating the actual work canvas.
  // format/quality/maxDim let callers pick a small, downscaled JPEG for
  // handing off over sessionStorage/HTTP (a full-res PNG — or even a
  // full-res JPEG of a busy/detailed photo — can still be several MB,
  // enough to blow past the browser's ~5MB sessionStorage quota) versus
  // a full-resolution lossless PNG for an actual download.
  function exportDataUrl(format: "image/png" | "image/jpeg" = "image/png", quality = 0.92, maxDim?: number): string {
    const work = workCanvasRef.current!;
    const scale = maxDim ? Math.min(1, maxDim / Math.max(work.width, work.height)) : 1;
    const outW = Math.max(1, Math.round(work.width * scale));
    const outH = Math.max(1, Math.round(work.height * scale));
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const octx = out.getContext("2d")!;
    if (format === "image/jpeg") {
      // JPEG has no alpha channel — flatten onto white first or transparent
      // areas turn black.
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, outW, outH);
    }
    octx.filter = buildFilterString(adjustments);
    octx.drawImage(work, 0, 0, outW, outH);
    octx.filter = "none";
    octx.textBaseline = "top";
    for (const l of textLayers) {
      octx.fillStyle = l.color;
      octx.font = `${l.bold ? "700" : "400"} ${l.size * scale}px Inter, sans-serif`;
      octx.fillText(l.value, l.x * scale, l.y * scale);
    }
    return out.toDataURL(format, quality);
  }

  function handleDownload() {
    if (!hasImage) return;
    const url = exportDataUrl("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "visiyon-edit.png";
    a.click();
  }

  // Browsers disagree on how a full sessionStorage quota is reported:
  // modern ones throw DOMException("QuotaExceededError"), older Firefox
  // uses the numeric legacy code 22, and the message text is the one
  // thing that's reliably present everywhere.
  function isQuotaError(err: any): boolean {
    return err?.name === "QuotaExceededError" || err?.code === 22 || /quota/i.test(String(err?.message || ""));
  }

  // Hands the edited photo to /generate WITHOUT touching the server: the
  // exported canvas stays a data URL in sessionStorage, so nothing gets
  // uploaded (and no server storage is spent) unless the person actually
  // goes on to generate with it. /generate's own reference-image upload
  // path (already working elsewhere in the app) takes over the real
  // upload at that point — see the handoff effect in app/generate/page.tsx.
  // A reference image doesn't need full editing resolution, so this
  // downscales more aggressively than Download does, and backs off
  // further still if the first attempt doesn't fit in sessionStorage.
  function handleSendToGenerate() {
    if (!hasImage) return;
    setErrorMsg(null);
    const attempts: [number, number][] = [
      [1600, 0.85],
      [1200, 0.75],
      [900, 0.7],
    ];
    for (const [maxDim, quality] of attempts) {
      try {
        const dataUrl = exportDataUrl("image/jpeg", quality, maxDim);
        sessionStorage.setItem("visiyon_editor_handoff", dataUrl);
        router.push("/generate");
        return;
      } catch (err: any) {
        if (!isQuotaError(err)) {
          setErrorMsg("Couldn't hand this off to Generate. Please try again.");
          return;
        }
        // else: too big even at this size — fall through and try smaller
      }
    }
    setErrorMsg("This photo is too large to hand off, even scaled down. Try cropping it smaller first.");
  }

  const cursorClass = useMemo(() => {
    if (tool === "brush" || tool === "eraser") return "cursor-crosshair";
    if (tool === "crop" || tool === "rect" || tool === "ellipse" || tool === "line") return "cursor-crosshair";
    if (tool === "text") return "cursor-text";
    if (tool === "eyedropper") return "cursor-copy";
    return "cursor-default";
  }, [tool]);

  if (!ready) return null;

  return (
    <div className="h-screen w-screen bg-visiyon-bg text-visiyon-text-1 flex overflow-hidden">

      {/* Mobile overlay: dims the screen while a drawer (nav or
          properties panel) is open on tap outside it */}
      {(mobileNavOpen || mobilePanelOpen) && (
        <div
          className="fixed inset-0 z-30 bg-black/60 sm:hidden"
          onClick={() => {
            setMobileNavOpen(false);
            setMobilePanelOpen(false);
          }}
        />
      )}

      {/* ---- Left rail ----
          Desktop: always-visible narrow column.
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
          <RailIcon icon={<SlidersHorizontal size={18} />} label="Generate" color="#f472b6" href="/generate" />
          <RailIcon icon={<Wand2 size={18} />} label="Photoshop" color="#22d3ee" active />
          <RailIcon icon={<Clapperboard size={18} />} label="Video Edit" color="#a78bfa" href="/video-editor" />
          <RailIcon icon={<Grid3x3 size={18} />} label="All Tools" color="#94a3b8" href="/tools" />
        </div>

        <div className="flex-1" />

        <div className="w-full px-1.5 flex flex-col gap-0.5 items-center">
          <UserMenu />
        </div>
      </aside>

      {/* ---- Top bar ---- */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-12 shrink-0 flex items-center gap-1.5 px-3 border-b border-white/5 overflow-x-auto overflow-y-hidden">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="sm:hidden shrink-0 h-8 w-8 flex items-center justify-center rounded-lg hover:bg-white/5 text-visiyon-text-2"
            title="Menu"
          >
            <Menu size={18} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium bg-black/30 hover:bg-black/50"
          >
            <Upload size={14} /> <span className="hidden sm:inline">Open</span>
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileOpen} />

          <div className="shrink-0 w-px h-5 bg-white/10 mx-1" />

          <button
            onClick={undo}
            disabled={historyIndex <= 0}
            className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50 disabled:opacity-30"
            title="Undo"
          >
            <Undo2 size={15} />
          </button>
          <button
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50 disabled:opacity-30"
            title="Redo"
          >
            <Redo2 size={15} />
          </button>

          <div className="shrink-0 w-px h-5 bg-white/10 mx-1" />

          <button onClick={() => flip("h")} disabled={!hasImage} className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50 disabled:opacity-30" title="Flip horizontal">
            <FlipHorizontal2 size={15} />
          </button>
          <button onClick={() => flip("v")} disabled={!hasImage} className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50 disabled:opacity-30" title="Flip vertical">
            <FlipVertical2 size={15} />
          </button>
          <button onClick={rotate90} disabled={!hasImage} className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50 disabled:opacity-30" title="Rotate 90°">
            <RotateCcw size={15} />
          </button>

          {/* On desktop this spacer pushes zoom/download/send to the far
              right. On mobile the header scrolls horizontally instead, so
              a flex-1 spacer here would just stretch to fill unused
              scroll space — keep it a small fixed gap there and only grow
              it from sm: up. */}
          <div className="shrink-0 w-3 sm:w-0 sm:flex-1" />

          <button onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))} className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50" title="Zoom out">
            <ZoomOut size={15} />
          </button>
          <span className="shrink-0 text-[11.5px] text-visiyon-text-3 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.1))} className="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50" title="Zoom in">
            <ZoomIn size={15} />
          </button>

          <div className="shrink-0 w-px h-5 bg-white/10 mx-1" />

          <button
            onClick={() => setMobilePanelOpen(true)}
            className="sm:hidden shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-black/30 hover:bg-black/50"
            title="Properties"
          >
            <SlidersHorizontal size={15} />
          </button>

          <button
            onClick={handleDownload}
            disabled={!hasImage}
            className="shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium bg-black/30 hover:bg-black/50 disabled:opacity-40"
          >
            <Download size={14} /> <span className="hidden sm:inline">Download</span>
          </button>
          <button
            onClick={handleSendToGenerate}
            disabled={!hasImage}
            className="shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold bg-visiyon-accent text-visiyon-bg hover:opacity-90 disabled:opacity-40"
          >
            <Send size={14} /> <span className="hidden sm:inline">Send to Generate</span>
          </button>
        </header>

        {errorMsg && (
          <div className="mx-3 mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300">
            {errorMsg}
          </div>
        )}

        <div className="flex-1 min-h-0 flex">
          {/* ---- Tool rail ----
              pb-6 + safe-area inset: on short/mobile viewports this list can
              run to the very bottom of the screen. Without bottom padding
              the last tool (eyedropper) sat flush against the edge — or
              under the home-indicator on notched phones — with zero room
              to tap it comfortably. */}
          <div
            className="w-14 shrink-0 flex flex-col items-center gap-1.5 py-3 pb-6 bg-visiyon-panel2/60 overflow-y-auto"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <ToolButton active={tool === "move"} onClick={() => setTool("move")} title="Move / Select">
              <MousePointer2 size={17} />
            </ToolButton>
            <ToolButton active={tool === "crop"} onClick={() => setTool("crop")} title="Crop">
              <CropIcon size={17} />
            </ToolButton>
            <ToolButton active={tool === "brush"} onClick={() => setTool("brush")} title="Brush">
              <Paintbrush size={17} />
            </ToolButton>
            <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} title="Eraser">
              <Eraser size={17} />
            </ToolButton>
            <ToolButton active={tool === "text"} onClick={() => setTool("text")} title="Text">
              <TypeIcon size={17} />
            </ToolButton>
            <ToolButton active={tool === "rect"} onClick={() => setTool("rect")} title="Rectangle">
              <Square size={17} />
            </ToolButton>
            <ToolButton active={tool === "ellipse"} onClick={() => setTool("ellipse")} title="Ellipse">
              <CircleIcon size={17} />
            </ToolButton>
            <ToolButton active={tool === "line"} onClick={() => setTool("line")} title="Line">
              <Minus size={17} />
            </ToolButton>
            <ToolButton active={tool === "eyedropper"} onClick={() => setTool("eyedropper")} title="Eyedropper">
              <span className="text-[13px]">🎨</span>
            </ToolButton>
          </div>

          {/* ---- Canvas ---- */}
          <div ref={wrapRef} className="flex-1 min-w-0 overflow-auto bg-[#0a0a0c] flex items-center justify-center relative p-8">
            {!hasImage ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-white/10 px-16 py-14 text-visiyon-text-3 hover:text-visiyon-text-2 hover:border-white/20 transition-colors"
              >
                <Upload size={28} />
                <span className="text-[13.5px] font-medium">Open a photo to start editing</span>
                <span className="text-[11.5px]">JPEG or PNG</span>
              </button>
            ) : (
              <div className="relative" style={{ width: displayCanvasRef.current?.width ? displayCanvasRef.current.width * zoom : undefined }}>
                <canvas
                  ref={displayCanvasRef}
                  style={{
                    width: workCanvasRef.current ? workCanvasRef.current.width * zoom : undefined,
                    height: workCanvasRef.current ? workCanvasRef.current.height * zoom : undefined,
                  }}
                  className={`block bg-white/5 shadow-2xl ${cursorClass}`}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={handleCanvasMouseUp}
                  onDoubleClick={handleCanvasDoubleClick}
                />
                {/* Selection outline + edit/delete controls for a placed
                    text layer (move tool). Drag anywhere inside the box
                    to reposition it; double-click, or the pencil, to edit
                    its text again. */}
                {tool === "move" && selectedTextId && editingTextId !== selectedTextId && (() => {
                  const l = textLayers.find((t) => t.id === selectedTextId);
                  if (!l) return null;
                  const { w, h } = measureTextLayer(l);
                  // While this layer is actively being dragged it's hidden
                  // from the canvas (see renderDisplay) and shown here as a
                  // plain text ghost instead, positioned directly via ref —
                  // so it moves with the pointer with zero lag, in every
                  // direction, independent of any canvas redraw.
                  if (draggingLayerId === l.id) {
                    return (
                      <div
                        ref={dragGhostRef}
                        className="absolute whitespace-nowrap pointer-events-none select-none"
                        style={{
                          left: l.x * zoom,
                          top: l.y * zoom,
                          fontSize: l.size * zoom,
                          fontWeight: l.bold ? 700 : 400,
                          color: l.color,
                          fontFamily: "Inter, sans-serif",
                          lineHeight: 1.2,
                          opacity: 0.85,
                        }}
                      >
                        {l.value}
                      </div>
                    );
                  }
                  return (
                    <div
                      className="absolute border-2 border-dashed border-visiyon-accent cursor-move"
                      style={{ left: l.x * zoom, top: l.y * zoom, width: w * zoom, height: h * zoom }}
                      onMouseDown={(e) => beginLayerDrag(l, e)}
                    >
                      <div className="absolute -top-7 right-0 flex items-center gap-1">
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => openTextForEdit(l.id)}
                          title="Edit text"
                          className="h-6 w-6 flex items-center justify-center rounded-md bg-black/70 border border-white/20 text-white/80"
                        >
                          <TypeIcon size={12} />
                        </button>
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={deleteSelectedText}
                          title="Delete text"
                          className="h-6 w-6 flex items-center justify-center rounded-full bg-black/70 border border-white/20 text-white/80"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })()}
                {/* Crop selection overlay */}
                {cropRect && (
                  <div
                    className="absolute border-2 border-visiyon-accent bg-visiyon-accent/10 pointer-events-none"
                    style={{ left: cropRect.x * zoom, top: cropRect.y * zoom, width: cropRect.w * zoom, height: cropRect.h * zoom }}
                  />
                )}
                {/* Shape drag preview */}
                {shapePreview && (
                  <div
                    className="absolute border-2 border-dashed pointer-events-none"
                    style={{
                      left: shapePreview.x * zoom,
                      top: shapePreview.y * zoom,
                      width: shapePreview.w * zoom,
                      height: shapePreview.h * zoom,
                      borderColor: shapeColor,
                      borderRadius: tool === "ellipse" ? "50%" : 0,
                    }}
                  />
                )}
                {/* Inline text input, placed at click point — drag the ⠿ handle to
                    reposition before confirming, since once committed the text
                    is baked into pixels and can no longer be moved. */}
                {pendingText && (
                  <div
                    ref={pendingBoxRef}
                    className="absolute z-10 flex items-center gap-1.5"
                    style={{ left: pendingText.x * zoom, top: pendingText.y * zoom }}
                  >
                    <div
                      onMouseDown={startTextDrag}
                      title="Drag to reposition"
                      className="h-6 w-6 flex items-center justify-center rounded-md bg-black/70 border border-white/20 text-white/70 cursor-move active:cursor-grabbing select-none"
                    >
                      <MousePointer2 size={12} />
                    </div>
                    <input
                      autoFocus
                      value={textValue}
                      onChange={(e) => setTextValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && commitText()}
                      placeholder="Type text…"
                      style={{ fontSize: Math.max(11, textSize * zoom * 0.5), color: textColor }}
                      className="bg-black/70 border border-white/20 rounded-md px-2 py-1 outline-none min-w-[140px]"
                    />
                    <button onClick={commitText} className="h-6 w-6 flex items-center justify-center rounded-full bg-visiyon-accent text-visiyon-bg">
                      <Check size={12} />
                    </button>
                    <button
                      onClick={cancelTextEdit}
                      className="h-6 w-6 flex items-center justify-center rounded-full bg-black/60 text-white"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
                {/* Crop confirm/cancel bar */}
                {tool === "crop" && cropRect && cropRect.w > 4 && cropRect.h > 4 && (
                  <div
                    className="absolute flex items-center gap-1.5"
                    style={{ left: cropRect.x * zoom, top: (cropRect.y + cropRect.h) * zoom + 6 }}
                  >
                    <button onClick={applyCrop} className="flex items-center gap-1 rounded-md bg-visiyon-accent text-visiyon-bg text-[11px] font-semibold px-2.5 py-1">
                      <Check size={12} /> Apply crop
                    </button>
                    <button onClick={() => setCropRect(null)} className="flex items-center gap-1 rounded-md bg-black/70 text-white text-[11px] px-2.5 py-1">
                      <X size={12} /> Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            <canvas ref={workCanvasRef} className="hidden" />
          </div>

          {/* ---- Right panel ----
              Desktop: always-visible 260px column.
              Mobile (<sm): hidden by default, opened via the header's
              Properties button, slides in from the right as an overlay —
              previously this was a permanent fixed-width column that
              left almost no room for the canvas on a phone screen. */}
          <div
            className={`fixed sm:static inset-y-0 right-0 z-40 w-[260px] shrink-0 border-l border-white/5 overflow-y-auto p-3 space-y-4 bg-visiyon-panel2 sm:bg-transparent transition-transform duration-200 sm:translate-x-0 ${
              mobilePanelOpen ? "translate-x-0" : "translate-x-full"
            }`}
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={() => setMobilePanelOpen(false)}
              className="sm:hidden w-full flex items-center justify-between text-[11px] font-semibold text-visiyon-text-3 uppercase tracking-wide pb-2 border-b border-white/5"
            >
              Properties
              <X size={14} />
            </button>
            {(tool === "brush" || tool === "eraser") && (
              <div className="space-y-2.5">
                <p className="text-[11px] font-semibold text-visiyon-text-3 uppercase tracking-wide">{tool === "brush" ? "Brush" : "Eraser"}</p>
                <Slider label="Size" value={brushSize} min={1} max={120} onChange={setBrushSize} suffix="px" />
                {tool === "brush" && <Slider label="Opacity" value={brushOpacity} min={5} max={100} onChange={setBrushOpacity} suffix="%" />}
                {tool === "brush" && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-visiyon-text-3">Color</span>
                    <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} className="h-7 w-10 rounded cursor-pointer bg-transparent" />
                  </div>
                )}
              </div>
            )}

            {(tool === "rect" || tool === "ellipse" || tool === "line") && (
              <div className="space-y-2.5">
                <p className="text-[11px] font-semibold text-visiyon-text-3 uppercase tracking-wide">Shape</p>
                <Slider label="Stroke width" value={shapeStroke} min={1} max={40} onChange={setShapeStroke} suffix="px" />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-visiyon-text-3">Color</span>
                  <input type="color" value={shapeColor} onChange={(e) => setShapeColor(e.target.value)} className="h-7 w-10 rounded cursor-pointer bg-transparent" />
                </div>
                {tool !== "line" && (
                  <label className="flex items-center gap-2 text-[11.5px] text-visiyon-text-2">
                    <input type="checkbox" checked={shapeFilled} onChange={(e) => setShapeFilled(e.target.checked)} /> Filled
                  </label>
                )}
              </div>
            )}

            {tool === "text" && (
              <div className="space-y-2.5">
                <p className="text-[11px] font-semibold text-visiyon-text-3 uppercase tracking-wide">Text</p>
                <Slider label="Size" value={textSize} min={10} max={200} onChange={setTextSize} suffix="px" />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-visiyon-text-3">Color</span>
                  <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-7 w-10 rounded cursor-pointer bg-transparent" />
                </div>
                <label className="flex items-center gap-2 text-[11.5px] text-visiyon-text-2">
                  <input type="checkbox" checked={textBold} onChange={(e) => setTextBold(e.target.checked)} /> Bold
                </label>
                <p className="text-[10.5px] text-visiyon-text-3">Click anywhere on the photo to place text. Switch to Move to drag it around or double-click it to edit again.</p>
              </div>
            )}

            {(tool === "move" || tool === "crop" || tool === "eyedropper") && (
              <>
                <div className="flex rounded-lg bg-black/30 p-0.5">
                  <button
                    onClick={() => setPanelTab("adjust")}
                    className={`flex-1 rounded-md py-1.5 text-[11.5px] font-medium transition-colors ${panelTab === "adjust" ? "bg-white/10 text-white" : "text-visiyon-text-3"}`}
                  >
                    Adjust
                  </button>
                  <button
                    onClick={() => setPanelTab("filters")}
                    className={`flex-1 rounded-md py-1.5 text-[11.5px] font-medium transition-colors ${panelTab === "filters" ? "bg-white/10 text-white" : "text-visiyon-text-3"}`}
                  >
                    Filters
                  </button>
                </div>

                {panelTab === "adjust" ? (
                  <div className="space-y-3">
                    <Slider
                      label="Brightness"
                      value={adjustments.brightness}
                      min={0}
                      max={200}
                      onChange={(v) => {
                        setAdjustments((a) => ({ ...a, brightness: v }));
                        setAdjustmentsDirty(true);
                      }}
                      suffix="%"
                    />
                    <Slider
                      label="Contrast"
                      value={adjustments.contrast}
                      min={0}
                      max={200}
                      onChange={(v) => {
                        setAdjustments((a) => ({ ...a, contrast: v }));
                        setAdjustmentsDirty(true);
                      }}
                      suffix="%"
                    />
                    <Slider
                      label="Saturation"
                      value={adjustments.saturation}
                      min={0}
                      max={200}
                      onChange={(v) => {
                        setAdjustments((a) => ({ ...a, saturation: v }));
                        setAdjustmentsDirty(true);
                      }}
                      suffix="%"
                    />
                    <Slider
                      label="Hue"
                      value={adjustments.hue}
                      min={0}
                      max={360}
                      onChange={(v) => {
                        setAdjustments((a) => ({ ...a, hue: v }));
                        setAdjustmentsDirty(true);
                      }}
                      suffix="°"
                    />
                    <Slider
                      label="Blur"
                      value={adjustments.blur}
                      min={0}
                      max={20}
                      onChange={(v) => {
                        setAdjustments((a) => ({ ...a, blur: v }));
                        setAdjustmentsDirty(true);
                      }}
                      suffix="px"
                    />
                    <div className="flex gap-1.5 pt-1">
                      <button
                        onClick={applyAdjustments}
                        disabled={!adjustmentsDirty}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-visiyon-accent text-visiyon-bg text-[12px] font-semibold py-1.5 disabled:opacity-40"
                      >
                        <Check size={13} /> Apply
                      </button>
                      <button
                        onClick={resetAdjustments}
                        disabled={!adjustmentsDirty}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-black/30 text-visiyon-text-2 text-[12px] font-medium py-1.5 disabled:opacity-40"
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {FILTER_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => applyPreset(p.value)}
                        className="rounded-lg bg-black/30 hover:bg-black/50 px-2 py-2 text-[11.5px] text-visiyon-text-2"
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      onClick={applyAdjustments}
                      disabled={!adjustmentsDirty}
                      className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg bg-visiyon-accent text-visiyon-bg text-[12px] font-semibold py-1.5 disabled:opacity-40 mt-1"
                    >
                      <Check size={13} /> Apply filter
                    </button>
                  </div>
                )}

                {tool === "eyedropper" && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[11px] text-visiyon-text-3">Picked</span>
                    <div className="h-6 w-10 rounded border border-white/20" style={{ background: brushColor }} />
                    <span className="text-[11px] text-visiyon-text-3">{brushColor}</span>
                  </div>
                )}
              </>
            )}

            <div className="pt-2 border-t border-white/5 text-[10.5px] text-visiyon-text-3 leading-relaxed">
              Edit a photo here, then hit <span className="text-visiyon-text-2 font-medium">Send to Generate</span> to use it as
              the reference image for image, video, motion or avatar generation.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
