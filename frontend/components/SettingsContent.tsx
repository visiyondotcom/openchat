"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";

import { useRequireAuth, updateCachedUser } from "@/lib/useAuth";
import { useChatStore } from "@/lib/store";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";
import Select from "@/components/Select";
import BuyCreditsModal from "@/components/BuyCreditsModal";
import { getSupportWidgetEnabled, setSupportWidgetEnabled } from "@/lib/supportWidgetPref";
import {
  listApiKeys,
  createApiKey,
  deleteApiKey,
  ApiKeySummary,
  changePassword,
  getMe,
  uploadAvatar,
  deleteAvatar,
  setup2fa,
  enable2fa,
  disable2fa,
  regenerateBackupCodes,
  getTodayUsage,
  TodayUsage,
  getUsageHistory,
  UsageHistoryBucket,
  getBillingConfig,
  listInvoices,
  Invoice,
  getCreditsBalance,
  getServerConnection,
  saveServerConnection,
  deleteServerConnection,
  testServerConnectionApi,
  ServerConnectionSummary,
  listMyMemories,
  addMyMemory,
  updateMyMemory,
  deleteMyMemory,
  clearMyMemories,
  UserMemory,
  getPublicConfigCached,
} from "@/lib/api";
import {
  ArrowLeft,
  X,
  Plus,
  Trash2,
  Copy,
  Check,
  KeyRound,
  Lock,
  ShieldCheck,
  CreditCard,
  Camera,
  User,
  BarChart3,
  Receipt,
  Download,
  ExternalLink,
  Server,
  BrainCircuit,
  SlidersHorizontal,
  Bell,
  Sparkles,
  Zap,
  Sun,
  Moon,
  MoonStar,
  Upload,
} from "lucide-react";
import {
  getNotificationsPref,
  setNotificationsPref,
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/notificationPref";
import { copyToClipboard } from "@/lib/clipboard";
import { formatResetRelative } from "@/lib/format";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

type Tab = "general" | "notifications" | "memory" | "keys" | "server" | "security" | "profile" | "usage" | "billing";

// Font choices for Settings → Appearance → Font. Web-safe / OS-bundled
// stacks only (no custom font files to load) so the switch is instant.
// `value` is the exact CSS font-family value stored + applied via the
// --visiyon-font custom property.
const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: '"General Sans", ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', label: "Default (General Sans)" },
  { value: '"Inter", ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif', label: "Inter" },
  { value: 'Arial, Helvetica, sans-serif', label: "Arial" },
  { value: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: "Helvetica Neue" },
  { value: 'Verdana, Geneva, sans-serif', label: "Verdana" },
  { value: '"Trebuchet MS", sans-serif', label: "Trebuchet MS" },
  { value: '"Segoe UI", sans-serif', label: "Segoe UI" },
  { value: 'Tahoma, Geneva, sans-serif', label: "Tahoma" },
  { value: 'Georgia, Cambria, "Times New Roman", Times, serif', label: "Georgia" },
  { value: '"Times New Roman", Times, serif', label: "Times New Roman" },
  { value: '"Palatino Linotype", Palatino, Georgia, serif', label: "Palatino" },
  { value: 'Garamond, Baskerville, "Baskerville Old Face", serif', label: "Garamond" },
  { value: '"Source Serif Pro", Georgia, serif', label: "Source Serif" },
  { value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace', label: "Default Mono" },
  { value: '"Courier New", Courier, monospace', label: "Courier New" },
  { value: 'Consolas, Menlo, monospace', label: "Consolas" },
];


// Grouped and labeled to match a familiar "General / Notifications /
// Memory / Data controls / Security and login / Account" settings
// layout. Ids are unchanged from before this reshuffle (profile, keys,
// server, memory, ...) — only the label, icon, and nav order changed — so
// none of the tab === "..." content blocks below needed to move.
const TABS: { id: Tab; label: string; icon: any; group?: string }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "memory", label: "Memory", icon: Sparkles },
  { id: "keys", label: "API keys", icon: KeyRound, group: "Data controls" },
  { id: "server", label: "Server connection", icon: Server, group: "Data controls" },
  { id: "security", label: "Security and login", icon: ShieldCheck },
  { id: "profile", label: "Account", icon: User },
  { id: "usage", label: "Usage & Analytics", icon: BarChart3 },
  { id: "billing", label: "Billing & Invoices", icon: CreditCard },
];

// Shared between the standalone /settings route (direct links, refreshes)
// and SettingsModal (opened from the sidebar as a floating panel over the
// chat). `onClose`, when provided, means we're rendering inside the modal —
// swaps the "Back to chat" link for an X button that just closes the panel
// instead of navigating.
export function SettingsContent({ onClose }: { onClose?: () => void } = {}) {
  const { ready, user } = useRequireAuth();
  const [tab, setTab] = useState<Tab>("general");

  // Admin-controlled — Admin > Settings > Uploads > "API keys tab". Hides
  // the "API keys" nav item for regular users; admins always see it, and
  // any keys a user already created keep working regardless — this only
  // hides the tab itself.
  const [apiKeysTabEnabled, setApiKeysTabEnabled] = useState(true);
  useEffect(() => {
    getPublicConfigCached()
      .then((c) => setApiKeysTabEnabled(c.features.apiKeysTab))
      .catch(() => {});
  }, []);
  const visibleTabs = useMemo(
    () => TABS.filter((t) => t.id !== "keys" || apiKeysTabEnabled || user?.role === "ADMIN"),
    [apiKeysTabEnabled, user]
  );
  // If the tab was hidden out from under the user (or a deep link pointed
  // at it while disabled), fall back to General instead of showing a
  // blank nav with an active tab that isn't in the list.
  useEffect(() => {
    if (tab === "keys" && !apiKeysTabEnabled && user?.role !== "ADMIN") setTab("general");
  }, [tab, apiKeysTabEnabled, user]);

  // Sidebar rows like "Import memory" / "Customize for you" open this modal
  // pointed at a specific tab instead of always landing on General — read
  // once on mount, same as any other "initial" prop.
  const settingsInitialTab = useChatStore((s) => s.settingsInitialTab);
  useEffect(() => {
    if (settingsInitialTab) setTab(settingsInitialTab as Tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);

  // ---- Profile photo ----
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarName, setAvatarName] = useState<string | null>(null);
  const [avatarEmail, setAvatarEmail] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // ---- 2FA ----
  const [twoFaEnabled, setTwoFaEnabled] = useState(false);
  const [twoFaSetupRequired, setTwoFaSetupRequired] = useState(false);
  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [twoFaCode, setTwoFaCode] = useState("");
  const [twoFaError, setTwoFaError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [regenPassword, setRegenPassword] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [showRegenForm, setShowRegenForm] = useState(false);
  const [supportWidgetEnabled, setSupportWidgetEnabledState] = useState(true);

  // ---- General: appearance ----
  const [theme, setThemeState] = useState<"dark" | "light" | "midnight">("dark");
  const [font, setFontState] = useState<string>(FONT_OPTIONS[0].value);

  // ---- Notifications ----
  const [desktopNotifsEnabled, setDesktopNotifsEnabledState] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("unsupported");

  // ---- Usage widget + analytics chart ----
  const [usage, setUsage] = useState<TodayUsage | null>(null);
  const [range, setRange] = useState<"day" | "month" | "year">("day");
  const [history, setHistory] = useState<UsageHistoryBucket[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ---- Billing ----
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);

  const [serverConn, setServerConn] = useState<ServerConnectionSummary | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverForm, setServerForm] = useState({
    host: "",
    port: "22",
    username: "",
    authType: "password" as "password" | "privateKey",
    password: "",
    privateKey: "",
    passphrase: "",
    baseDir: "",
  });
  const [serverSaving, setServerSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverTesting, setServerTesting] = useState(false);
  const [serverTestResult, setServerTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [memories, setMemories] = useState<UserMemory[] | null>(null);
  const [memoriesError, setMemoriesError] = useState<string | null>(null);
  const [newMemoryFact, setNewMemoryFact] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryValue, setEditingMemoryValue] = useState("");
  const [memorySaving, setMemorySaving] = useState(false);
  // Import memory: lets a user paste an export from another assistant
  // (or a plain list of facts) and adds each line as a separate memory,
  // reusing the same one-fact-per-request /auth/me/memories endpoint —
  // there's no bulk-import route on the backend, so this just loops.
  const [showMemoryImport, setShowMemoryImport] = useState(false);
  const [memoryImportText, setMemoryImportText] = useState("");
  const [memoryImporting, setMemoryImporting] = useState(false);
  const [memoryImportResult, setMemoryImportResult] = useState<string | null>(null);

  function refresh() {
    listApiKeys()
      .then(setKeys)
      .catch(() => {});
  }

  useEffect(() => {
    refresh();
    getMe()
      .then((u) => {
        setTwoFaEnabled(Boolean(u?.twoFaEnabled));
        setTwoFaSetupRequired(Boolean(u?.twoFaSetupRequired));
        setAvatarUrl(u?.avatarUrl ?? null);
        setAvatarName(u?.name ?? null);
        setAvatarEmail(u?.email ?? null);
      })
      .catch(() => {});
    getTodayUsage()
      .then(setUsage)
      .catch(() => {});
    getCreditsBalance()
      .then((b) => setCredits(b.credits))
      .catch(() => {});
    getBillingConfig()
      .then((cfg) => {
        setBillingEnabled(cfg.enabled);
      })
      .catch(() => {});
    setSupportWidgetEnabledState(getSupportWidgetEnabled());
    const storedTheme = (localStorage.getItem("visiyon_theme") as "dark" | "light" | "midnight" | null) || "dark";
    setThemeState(storedTheme);
    const storedFont = localStorage.getItem("visiyon_font_family");
    if (storedFont) setFontState(storedFont);
    setDesktopNotifsEnabledState(getNotificationsPref());
    setNotifPermission(getNotificationPermission());
  }, []);

  function toggleTheme(next: "dark" | "light" | "midnight") {
    setThemeState(next);
    localStorage.setItem("visiyon_theme", next);
    document.documentElement.classList.remove("dark", "light", "midnight");
    document.documentElement.classList.add(next);
  }

  function toggleFont(next: string) {
    setFontState(next);
    localStorage.setItem("visiyon_font_family", next);
    document.documentElement.style.setProperty("--visiyon-font", next);
  }

  async function toggleDesktopNotifs(next: boolean) {
    if (next) {
      const perm = await requestNotificationPermission();
      setNotifPermission(perm);
      if (perm !== "granted") return; // user denied — leave the toggle off
    }
    setDesktopNotifsEnabledState(next);
    setNotificationsPref(next);
  }

  useEffect(() => {
    if (tab !== "usage") return;
    setHistoryLoading(true);
    getUsageHistory(range)
      .then((res) => setHistory(res.buckets))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [tab, range]);

  useEffect(() => {
    if (tab !== "server") return;
    setServerLoading(true);
    setServerTestResult(null);
    getServerConnection()
      .then((res) => {
        setServerConn(res.connection);
        if (res.connection) {
          setServerForm((f) => ({
            ...f,
            host: res.connection!.host,
            port: String(res.connection!.port),
            username: res.connection!.username,
            authType: res.connection!.authType,
            baseDir: res.connection!.baseDir || "",
          }));
        }
      })
      .catch(() => setServerConn(null))
      .finally(() => setServerLoading(false));
  }, [tab]);

  useEffect(() => {
    if (tab !== "memory") return;
    setMemoriesError(null);
    listMyMemories()
      .then((res) => setMemories(res.memories))
      .catch(() => {
        setMemories([]);
        setMemoriesError("Memory is disabled on this server, or couldn't be loaded.");
      });
  }, [tab]);

  function refreshMyMemories() {
    listMyMemories()
      .then((res) => setMemories(res.memories))
      .catch(() => {});
  }

  async function handleAddMemory() {
    const content = newMemoryFact.trim();
    if (!content) return;
    setMemorySaving(true);
    try {
      await addMyMemory(content);
      setNewMemoryFact("");
      refreshMyMemories();
    } finally {
      setMemorySaving(false);
    }
  }

  // Splits the pasted export into individual candidate facts: one per
  // line, stripping common list markers ("- ", "* ", "1. ") and leading
  // date tags like "[2026-01-01]" so a real export's formatting doesn't
  // end up stored verbatim. Blank lines and section headers (lines with
  // no lowercase content, e.g. "## Identity") are dropped.
  function parseMemoryImportLines(raw: string): string[] {
    return raw
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/^[-*•]\s+/, "")
          .replace(/^\d+[.)]\s+/, "")
          .replace(/^\[[^\]]*\]\s*-?\s*/, "")
          .trim()
      )
      .filter((line) => line.length >= 3 && line.length <= 500)
      .filter((line) => !/^#{1,6}\s/.test(line));
  }

  async function handleImportMemory() {
    const candidates = parseMemoryImportLines(memoryImportText);
    if (candidates.length === 0) {
      setMemoryImportResult("No usable lines found in that text.");
      return;
    }
    const existingLower = new Set((memories ?? []).map((m) => m.content.toLowerCase()));
    const toAdd = candidates.filter((c) => !existingLower.has(c.toLowerCase()));
    const skipped = candidates.length - toAdd.length;

    setMemoryImporting(true);
    setMemoryImportResult(null);
    let added = 0;
    let failed = 0;
    try {
      for (const fact of toAdd) {
        try {
          await addMyMemory(fact);
          added += 1;
        } catch {
          failed += 1;
        }
      }
      refreshMyMemories();
      const parts = [`Added ${added} fact${added === 1 ? "" : "s"}`];
      if (skipped > 0) parts.push(`skipped ${skipped} already known`);
      if (failed > 0) parts.push(`${failed} failed`);
      setMemoryImportResult(parts.join(", ") + ".");
      if (failed === 0) {
        setMemoryImportText("");
      }
    } finally {
      setMemoryImporting(false);
    }
  }

  async function handleSaveMemoryEdit(id: string) {
    const content = editingMemoryValue.trim();
    if (!content) return;
    await updateMyMemory(id, content);
    setEditingMemoryId(null);
    refreshMyMemories();
  }

  async function handleDeleteMemory(id: string) {
    await deleteMyMemory(id);
    refreshMyMemories();
  }

  async function handleClearMyMemories() {
    if (
      await askConfirm({
        title: `Forget everything the AI has learned about you? This deletes all ${memories?.length ?? 0} stored facts.`,
        confirmLabel: "Forget all",
        danger: true,
      })
    ) {
      await clearMyMemories();
      refreshMyMemories();
    }
  }

  async function handleServerSave() {
    setServerError(null);
    setServerSaving(true);
    try {
      const res = await saveServerConnection({
        host: serverForm.host.trim(),
        port: Number(serverForm.port) || 22,
        username: serverForm.username.trim(),
        authType: serverForm.authType,
        password: serverForm.authType === "password" ? serverForm.password : undefined,
        privateKey: serverForm.authType === "privateKey" ? serverForm.privateKey : undefined,
        passphrase: serverForm.authType === "privateKey" ? serverForm.passphrase || undefined : undefined,
        baseDir: serverForm.baseDir.trim() || null,
      });
      setServerConn(res.connection);
      setServerForm((f) => ({ ...f, password: "", privateKey: "", passphrase: "" }));
      setServerTestResult(null);
    } catch (err: any) {
      setServerError(err.message || "Could not save connection");
    } finally {
      setServerSaving(false);
    }
  }

  async function handleServerTest() {
    setServerTestResult(null);
    setServerTesting(true);
    try {
      const res = await testServerConnectionApi();
      setServerTestResult(res);
    } catch (err: any) {
      setServerTestResult({ ok: false, error: err.message || "Test failed" });
    } finally {
      setServerTesting(false);
    }
  }

  async function handleServerDisconnect() {
    if (
      !(await askConfirm({
        title: "Disconnect this server? The AI will no longer be able to read or write files there.",
        confirmLabel: "Disconnect",
        danger: true,
      }))
    )
      return;
    await deleteServerConnection();
    setServerConn(null);
    setServerForm({ host: "", port: "22", username: "", authType: "password", password: "", privateKey: "", passphrase: "", baseDir: "" });
    setServerTestResult(null);
  }

  useEffect(() => {
    if (tab !== "billing" || !billingEnabled) return;
    setInvoicesLoading(true);
    setInvoicesError(null);
    listInvoices()
      .then((res) => setInvoices(res.invoices))
      .catch((err) => setInvoicesError(err.message || "Could not load invoices."))
      .finally(() => setInvoicesLoading(false));
  }, [tab, billingEnabled]);

  const chartData = useMemo(
    () =>
      history.map((b) => ({
        label: formatBucketLabel(b.date, range),
        Tokens: b.tokens,
        Images: b.images,
      })),
    [history, range]
  );

  const totalTokensInRange = useMemo(() => history.reduce((sum, b) => sum + b.tokens, 0), [history]);
  const totalImagesInRange = useMemo(() => history.reduce((sum, b) => sum + b.images, 0), [history]);

  async function handleAvatarChange(file: File | null) {
    if (!file) return;
    setAvatarError(null);
    setAvatarUploading(true);
    try {
      const url = await uploadAvatar(file);
      setAvatarUrl(url);
      // Every other mounted component (rail avatar, UserMenu, Sidebar)
      // reads the shared cached user, not this page's local state — push
      // the change there too so the new photo shows up everywhere in the
      // app immediately instead of only after a refresh.
      updateCachedUser({ avatarUrl: url });
    } catch (err: any) {
      setAvatarError(err.message || "Upload failed");
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleAvatarRemove() {
    setAvatarError(null);
    try {
      await deleteAvatar();
      setAvatarUrl(null);
      updateCachedUser({ avatarUrl: null });
    } catch (err: any) {
      setAvatarError(err.message || "Could not remove photo");
    }
  }

  async function handleCreate() {
    const created = await createApiKey(label.trim() || undefined);
    setFreshKey(created.key);
    setLabel("");
    setCreating(false);
    refresh();
  }

  async function handlePasswordChange() {
    setPwError(null);
    setPwSuccess(false);
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New password and confirmation don't match.");
      return;
    }
    setPwSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setPwError(err.message || "Failed to change password.");
    } finally {
      setPwSaving(false);
    }
  }

  async function handleCopy() {
    if (!freshKey) return;
    await copyToClipboard(freshKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleStart2fa() {
    setTwoFaError(null);
    try {
      const data = await setup2fa();
      setTwoFaSetup(data);
    } catch (err: any) {
      setTwoFaError(err.message || "Failed to start 2FA setup.");
    }
  }

  async function handleConfirm2fa() {
    setTwoFaError(null);
    try {
      const data = await enable2fa(twoFaCode);
      setBackupCodes(data.backupCodes);
      setTwoFaEnabled(true);
      setTwoFaSetup(null);
      setTwoFaCode("");
    } catch (err: any) {
      setTwoFaError(err.message || "Invalid code.");
    }
  }

  async function handleDisable2fa() {
    setTwoFaError(null);
    setDisabling(true);
    try {
      await disable2fa(disablePassword);
      setTwoFaEnabled(false);
      setDisablePassword("");
      setBackupCodes(null);
    } catch (err: any) {
      setTwoFaError(err.message || "Failed to disable 2FA.");
    } finally {
      setDisabling(false);
    }
  }

  async function handleRegenerateBackupCodes() {
    setTwoFaError(null);
    setRegenerating(true);
    try {
      const data = await regenerateBackupCodes(regenPassword);
      setBackupCodes(data.backupCodes);
      setRegenPassword("");
      setShowRegenForm(false);
    } catch (err: any) {
      setTwoFaError(err.message || "Failed to regenerate backup codes.");
    } finally {
      setRegenerating(false);
    }
  }



  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto relative">
      <div className="px-4 py-6 sm:px-8 sm:py-8 max-w-[1400px] mx-auto">
        <div className="mb-8">
          {onClose ? (
            <button
              onClick={onClose}
              className="absolute top-6 right-6 sm:top-8 sm:right-8 p-2 rounded-full text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.08] transition-colors"
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          ) : (
            <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text mb-6">
              <ArrowLeft size={14} /> Back to chat
            </Link>
          )}
          <Logo />
          <h1 className="text-2xl font-semibold mt-4">Settings</h1>
          <p className="text-[13px] text-visiyon-text-3 mt-1">Manage your account, personalization, data, and security.</p>
        </div>

        {twoFaSetupRequired && (
          <div className="mb-8 border border-amber-400/40 bg-amber-400/10 rounded-2xl p-4">
            <p className="text-[13px] text-amber-300">
              This server requires admin accounts to have two-factor authentication enabled. Please set it up in the
              Security and login tab below.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-6 md:flex-row md:gap-8 md:items-start">
          <nav className="flex md:block gap-1 overflow-x-auto md:overflow-visible -mx-1 px-1 md:mx-0 md:px-0 pb-1 md:pb-0 w-full md:w-56 md:shrink-0 md:sticky md:top-8 md:space-y-1">
            {visibleTabs.map((t, idx) => {
              const Icon = t.icon;
              const active = tab === t.id;
              // Print a small section heading right before the first tab
              // of a group (currently just "Data controls" for API
              // keys/server), so related items read as one cluster instead
              // of two unrelated nav rows. Only makes sense in the
              // vertical (md+) layout — the mobile row is a flat
              // horizontal scroller, so the heading is hidden there.
              const showGroupHeading = t.group && visibleTabs[idx - 1]?.group !== t.group;
              return (
                <div key={t.id} className="shrink-0 md:shrink">
                  {showGroupHeading && (
                    <div className="hidden md:block px-3 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-visiyon-text-3">
                      {t.group}
                    </div>
                  )}
                  <button
                    onClick={() => setTab(t.id)}
                    className={`flex items-center gap-2.5 text-[13.5px] px-3 py-2.5 rounded-xl transition-colors text-left whitespace-nowrap md:w-full ${
                      active ? "bg-white text-black font-medium" : "text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.06]"
                    }`}
                  >
                    <Icon size={16} />
                    {t.label}
                  </button>
                </div>
              );
            })}
          </nav>

          <div className="flex-1 min-w-0">
            {tab === "profile" && (
              <div className="space-y-10">
                <section>
                  <h2 className="text-lg font-semibold mb-4">Profile photo</h2>
                  <div className="flex items-center gap-4 border border-visiyon-border rounded-2xl p-5">
                    <div className="relative shrink-0">
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="" className="w-16 h-16 rounded-full object-cover" />
                      ) : (
                        <span className="w-16 h-16 rounded-full bg-visiyon-accent text-visiyon-bg text-xl font-semibold flex items-center justify-center">
                          {(avatarName || avatarEmail || "?").charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <label className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-lg bg-visiyon-text/[0.06] hover:bg-visiyon-text/[0.1] cursor-pointer transition-colors">
                          <Camera size={14} />
                          {avatarUploading ? "Uploading…" : avatarUrl ? "Change photo" : "Upload photo"}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            className="hidden"
                            disabled={avatarUploading}
                            onChange={(e) => handleAvatarChange(e.target.files?.[0] ?? null)}
                          />
                        </label>
                        {avatarUrl && (
                          <button
                            onClick={handleAvatarRemove}
                            className="text-[13px] px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.06] transition-colors"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-visiyon-text-3 mt-1.5">PNG, JPEG, WEBP, or GIF · max 2 MB</p>
                      {avatarError && <p className="text-[12px] text-red-400 mt-1">{avatarError}</p>}
                    </div>
                  </div>
                </section>

                <section>
                  <h2 className="text-lg font-semibold mb-4">Account</h2>
                  <div className="border border-visiyon-border rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-xl">
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Name</div>
                      <div className="text-[14px]">{avatarName || "—"}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Email</div>
                      <div className="text-[14px]">{avatarEmail || "—"}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Credits</div>
                      <div className="text-[14px]">{credits == null ? "—" : credits.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Two-factor authentication</div>
                      <div className={`text-[14px] ${twoFaEnabled ? "text-emerald-400" : ""}`}>{twoFaEnabled ? "Enabled" : "Disabled"}</div>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {tab === "general" && (
              <div className="space-y-10">
                <section>
                  <h2 className="text-lg font-semibold mb-4">Appearance</h2>
                  <div className="border border-visiyon-border rounded-2xl p-5 max-w-xl flex items-center justify-between flex-wrap gap-4">
                    <div>
                      <div className="text-[14px]">Theme</div>
                      <p className="text-[11.5px] text-visiyon-text-3 mt-0.5">Applies to this browser only.</p>
                    </div>
                    <div className="flex items-center gap-1 border border-visiyon-border rounded-lg p-1">
                      <button
                        onClick={() => toggleTheme("dark")}
                        className={`flex items-center gap-1.5 text-[12.5px] px-2.5 py-1.5 rounded-md transition-colors ${
                          theme === "dark" ? "bg-white text-black font-medium" : "text-visiyon-text-2 hover:text-visiyon-text"
                        }`}
                      >
                        <Moon size={13} /> Dark
                      </button>
                      <button
                        onClick={() => toggleTheme("light")}
                        className={`flex items-center gap-1.5 text-[12.5px] px-2.5 py-1.5 rounded-md transition-colors ${
                          theme === "light" ? "bg-white text-black font-medium" : "text-visiyon-text-2 hover:text-visiyon-text"
                        }`}
                      >
                        <Sun size={13} /> Light
                      </button>
                      <button
                        onClick={() => toggleTheme("midnight")}
                        className={`flex items-center gap-1.5 text-[12.5px] px-2.5 py-1.5 rounded-md transition-colors ${
                          theme === "midnight" ? "bg-white text-black font-medium" : "text-visiyon-text-2 hover:text-visiyon-text"
                        }`}
                      >
                        <MoonStar size={13} /> Midnight
                      </button>
                    </div>
                  </div>

                  <div className="border border-visiyon-border rounded-2xl p-5 max-w-xl flex items-center justify-between flex-wrap gap-4 mt-3">
                    <div>
                      <div className="text-[14px]">Font</div>
                      <p className="text-[11.5px] text-visiyon-text-3 mt-0.5">Applies to chat text on this browser only.</p>
                    </div>
                    <Select
                      value={font}
                      onChange={toggleFont}
                      options={FONT_OPTIONS}
                      className="w-44"
                      buttonClassName="font-normal"
                    />
                  </div>
                </section>

                <section>
                  <h2 className="text-lg font-semibold mb-4">Preferences</h2>
                  <div className="border border-visiyon-border rounded-2xl p-5 max-w-xl">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[14px]">Show &quot;Need help?&quot; button</div>
                        <p className="text-[11.5px] text-visiyon-text-3 mt-0.5">
                          The floating support widget in the bottom-left corner. Turning this off
                          only affects your own account.
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          const next = !supportWidgetEnabled;
                          setSupportWidgetEnabledState(next);
                          setSupportWidgetEnabled(next);
                        }}
                        className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
                          supportWidgetEnabled ? "bg-visiyon-accent" : "bg-visiyon-text/15"
                        }`}
                      >
                        <span
                          className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform ${
                            supportWidgetEnabled ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {tab === "notifications" && (
              <div className="space-y-10">
                <section>
                  <h2 className="text-lg font-semibold mb-4">Desktop notifications</h2>
                  <div className="border border-visiyon-border rounded-2xl p-5 max-w-xl">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[14px]">Notify me when a reply is ready</div>
                        <p className="text-[11.5px] text-visiyon-text-3 mt-0.5">
                          Shows a browser notification when a response finishes generating while this tab
                          is in the background.
                        </p>
                        {notifPermission === "denied" && (
                          <p className="text-[11.5px] text-red-400 mt-1.5">
                            Notifications are blocked for this site in your browser. Allow them in your
                            browser's site settings, then try again.
                          </p>
                        )}
                        {notifPermission === "unsupported" && (
                          <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                            Your browser doesn't support notifications.
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => toggleDesktopNotifs(!desktopNotifsEnabled)}
                        disabled={notifPermission === "unsupported" || notifPermission === "denied"}
                        className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 disabled:opacity-40 ${
                          desktopNotifsEnabled ? "bg-visiyon-accent" : "bg-visiyon-text/15"
                        }`}
                      >
                        <span
                          className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform ${
                            desktopNotifsEnabled ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {tab === "usage" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <BarChart3 size={18} /> Usage & Analytics
                  </h2>
                  <div className="inline-flex rounded-xl border border-visiyon-border p-1">
                    {(["day", "month", "year"] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => setRange(r)}
                        className={`text-[12.5px] px-3.5 py-1.5 rounded-lg transition-colors capitalize ${
                          range === r ? "bg-white text-black font-medium" : "text-visiyon-text-2 hover:text-visiyon-text"
                        }`}
                      >
                        {r === "day" ? "Daily" : r === "month" ? "Monthly" : "Yearly"}
                      </button>
                    ))}
                  </div>
                </div>

                {usage && (
                  <div className="border border-visiyon-border rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-3 gap-6">
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Tokens (current window)</div>
                      <div className="text-2xl font-semibold">
                        {(usage.tokenCount ?? 0).toLocaleString()}
                        {usage.dailyTokenQuota != null && (
                          <span className="text-[13px] text-visiyon-text-3 font-normal"> / {usage.dailyTokenQuota.toLocaleString()}</span>
                        )}
                      </div>
                      {usage.dailyTokenQuota != null && <UsageBar label="" used={usage.tokenCount ?? 0} limit={usage.dailyTokenQuota} hideLabel />}
                    </div>
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Images generated</div>
                      <div className="text-2xl font-semibold">{usage.imageCount}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-visiyon-text-3 mb-1">Rolling window</div>
                      <div className="text-2xl font-semibold">{usage.windowHours ?? 5}h</div>
                      {usage.resetAt && <p className="text-[11px] text-visiyon-text-3 mt-1">Budget frees up {formatResetRelative(usage.resetAt)}</p>}
                    </div>
                  </div>
                )}

                <div className="border border-visiyon-border rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="text-[13px] font-medium">Token usage</div>
                      <div className="text-[11px] text-visiyon-text-3">
                        {totalTokensInRange.toLocaleString()} tokens · {totalImagesInRange.toLocaleString()} images ·{" "}
                        {range === "day" ? "last 24 hours" : range === "month" ? "last 30 days" : "last 12 months"}
                      </div>
                    </div>
                  </div>
                  <div className="h-72">
                    {historyLoading ? (
                      <div className="h-full flex items-center justify-center text-[13px] text-visiyon-text-3">Loading…</div>
                    ) : chartData.length === 0 || totalTokensInRange + totalImagesInRange === 0 ? (
                      <div className="h-full flex items-center justify-center text-[13px] text-visiyon-text-3">No usage recorded in this period yet.</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                          <XAxis dataKey="label" stroke="rgba(255,255,255,0.35)" fontSize={11} tickLine={false} axisLine={false} />
                          <YAxis stroke="rgba(255,255,255,0.35)" fontSize={11} tickLine={false} axisLine={false} width={44} />
                          <Tooltip contentStyle={{ background: "#111", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#fff" }} />
                          <Bar dataKey="Tokens" fill="#ffffff" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              </div>
            )}

            {tab === "billing" && (
              <div className="space-y-10">
                <section>
                  <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                    <CreditCard size={18} /> Credits
                  </h2>
                  <div className="relative overflow-hidden rounded-2xl border border-visiyon-border p-5">
                    <div
                      className="pointer-events-none absolute inset-0 opacity-90"
                      style={{
                        background:
                          "radial-gradient(120% 140% at 0% 0%, rgb(var(--visiyon-accent) / 0.14), transparent 60%)",
                      }}
                    />
                    <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-[11.5px] uppercase tracking-wide text-visiyon-text-3 font-medium">
                          Current balance
                        </p>
                        <p className="mt-1 flex items-baseline gap-1.5">
                          <span className="text-[28px] leading-none font-semibold text-visiyon-text tabular-nums">
                            {credits == null ? "—" : credits.toLocaleString()}
                          </span>
                          <span className="text-[13px] text-visiyon-text-3">credits</span>
                        </p>
                        {!billingEnabled && (
                          <p className="mt-2 text-[11.5px] text-visiyon-text-3">
                            Payments aren't configured on this server yet — nothing to buy right now.
                          </p>
                        )}
                      </div>
                      {billingEnabled && (
                        <button
                          onClick={() => setShowBuyCredits(true)}
                          className="group inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold text-black bg-gradient-to-b from-white to-visiyon-text/85 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_8px_20px_-8px_rgba(0,0,0,0.45)] transition-all duration-150 hover:shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_10px_24px_-8px_rgba(0,0,0,0.55)] hover:-translate-y-[1px] active:translate-y-0"
                        >
                          <Zap size={14} className="fill-black/80 text-black/80 transition-transform group-hover:scale-110" />
                          Buy credits
                        </button>
                      )}
                    </div>
                  </div>
                </section>

                <section>
                  <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                    <Receipt size={18} /> Invoices & orders
                  </h2>
                  <div className="border border-visiyon-border rounded-2xl overflow-hidden">
                    {!billingEnabled ? (
                      <p className="text-[12.5px] text-visiyon-text-3 p-5">Billing isn't configured on this server.</p>
                    ) : invoicesLoading ? (
                      <p className="text-[12.5px] text-visiyon-text-3 p-5">Loading invoices…</p>
                    ) : invoicesError ? (
                      <p className="text-[12.5px] text-red-400 p-5">{invoicesError}</p>
                    ) : invoices.length === 0 ? (
                      <p className="text-[12.5px] text-visiyon-text-3 p-5">No invoices yet — they'll show up here after your first payment.</p>
                    ) : (
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="text-left text-[11px] text-visiyon-text-3 border-b border-visiyon-border">
                            <th className="font-normal px-5 py-3">Invoice</th>
                            <th className="font-normal px-5 py-3">Date</th>
                            <th className="font-normal px-5 py-3">Status</th>
                            <th className="font-normal px-5 py-3">Amount</th>
                            <th className="font-normal px-5 py-3"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {invoices.map((inv) => (
                            <tr key={inv.id} className="border-b border-visiyon-border last:border-0">
                              <td className="px-5 py-3 font-mono text-[12.5px]">{inv.number || inv.id.slice(0, 12)}</td>
                              <td className="px-5 py-3 text-visiyon-text-2">{new Date(inv.created * 1000).toLocaleDateString()}</td>
                              <td className="px-5 py-3">
                                <span
                                  className={`text-[11.5px] px-2 py-0.5 rounded-full capitalize ${
                                    inv.status === "paid" ? "bg-emerald-400/10 text-emerald-400" : inv.status === "open" ? "bg-amber-400/10 text-amber-400" : "bg-visiyon-text/[0.08] text-visiyon-text-3"
                                  }`}
                                >
                                  {inv.status}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-visiyon-text-2">{formatMoney(inv.amountPaid || inv.amountDue, inv.currency)}</td>
                              <td className="px-5 py-3 text-right">
                                <div className="flex justify-end gap-3">
                                  {inv.hostedInvoiceUrl && (
                                    <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-visiyon-text-3 hover:text-visiyon-text" title="View invoice">
                                      <ExternalLink size={14} />
                                    </a>
                                  )}
                                  {inv.invoicePdf && (
                                    <a href={inv.invoicePdf} target="_blank" rel="noreferrer" className="text-visiyon-text-3 hover:text-visiyon-text" title="Download PDF">
                                      <Download size={14} />
                                    </a>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>
              </div>
            )}

            {tab === "security" && (
              <div className="space-y-10">
                <section>
                  <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                    <Lock size={18} /> Change password
                  </h2>

                  <div className="border border-visiyon-border rounded-2xl p-5 space-y-3 max-w-sm">
                    <div>
                      <label className="text-[12px] text-visiyon-text-3 block mb-1">Current password</label>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                    </div>
                    <div>
                      <label className="text-[12px] text-visiyon-text-3 block mb-1">New password</label>
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                    </div>
                    <div>
                      <label className="text-[12px] text-visiyon-text-3 block mb-1">Confirm new password</label>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                    </div>

                    {pwError && <p className="text-[12.5px] text-red-400">{pwError}</p>}
                    {pwSuccess && <p className="text-[12.5px] text-emerald-400">Password changed successfully.</p>}

                    <button
                      onClick={handlePasswordChange}
                      disabled={pwSaving || !currentPassword || !newPassword}
                      className="text-[13px] font-medium px-4 py-2 rounded-lg bg-white text-black disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {pwSaving ? "Saving..." : "Update password"}
                    </button>
                  </div>
                </section>

                <section>
                  <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                    <ShieldCheck size={18} /> Two-factor authentication
                  </h2>

                  <div className="border border-visiyon-border rounded-2xl p-5 max-w-sm space-y-3">
                    {twoFaEnabled ? (
                      <>
                        <p className="text-[12.5px] text-emerald-400">2FA is enabled on your account.</p>
                        {backupCodes && (
                          <div className="bg-visiyon-text/[0.06] rounded-lg p-3">
                            <p className="text-[12px] text-visiyon-text-2 mb-2">
                              Save these backup codes somewhere safe — each works once if you lose access to your authenticator app. They won't be shown again.
                            </p>
                            <div className="grid grid-cols-2 gap-1 font-mono text-[12.5px]">
                              {backupCodes.map((c) => (
                                <span key={c}>{c}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        {showRegenForm ? (
                          <div className="rounded-lg p-3 space-y-2">
                            <p className="text-[12px] text-visiyon-text-3">Enter your password to regenerate backup codes.</p>
                            <input
                              type="password"
                              value={regenPassword}
                              onChange={(e) => setRegenPassword(e.target.value)}
                              className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={handleRegenerateBackupCodes}
                                disabled={regenerating || !regenPassword}
                                className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-white text-black disabled:opacity-40"
                              >
                                {regenerating ? "Regenerating…" : "Regenerate"}
                              </button>
                              <button
                                onClick={() => {
                                  setShowRegenForm(false);
                                  setRegenPassword("");
                                }}
                                className="text-[12.5px] text-visiyon-text-3 hover:text-visiyon-text"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => setShowRegenForm(true)} className="text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
                            Regenerate backup codes
                          </button>
                        )}

                        <div className="pt-2 border-t border-visiyon-border space-y-2">
                          <label className="text-[12px] text-visiyon-text-3 block">Password to disable 2FA</label>
                          <input
                            type="password"
                            value={disablePassword}
                            onChange={(e) => setDisablePassword(e.target.value)}
                            className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                          />
                          {twoFaError && <p className="text-[12.5px] text-red-400">{twoFaError}</p>}
                          <button
                            onClick={handleDisable2fa}
                            disabled={disabling || !disablePassword}
                            className="text-[13px] font-medium px-4 py-2 rounded-lg border border-red-400/40 text-red-400 hover:bg-red-400/10 disabled:opacity-40 transition-colors"
                          >
                            {disabling ? "Disabling…" : "Disable 2FA"}
                          </button>
                        </div>
                      </>
                    ) : twoFaSetup ? (
                      <>
                        <p className="text-[12.5px] text-visiyon-text-3">Scan this in your authenticator app, then enter the 6-digit code it shows.</p>
                        <div className="bg-visiyon-text/[0.06] rounded-lg p-3 break-all font-mono text-[11.5px]">{twoFaSetup.secret}</div>
                        <label className="text-[12px] text-visiyon-text-3 block">6-digit code</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={twoFaCode}
                          onChange={(e) => setTwoFaCode(e.target.value)}
                          className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text tracking-widest"
                        />
                        {twoFaError && <p className="text-[12.5px] text-red-400">{twoFaError}</p>}
                        <div className="flex gap-2">
                          <button onClick={handleConfirm2fa} disabled={twoFaCode.length !== 6} className="text-[13px] font-medium px-4 py-2 rounded-lg bg-white text-black disabled:opacity-40">
                            Confirm & enable
                          </button>
                          <button
                            onClick={() => {
                              setTwoFaSetup(null);
                              setTwoFaCode("");
                            }}
                            className="text-[13px] text-visiyon-text-3 hover:text-visiyon-text"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-[12.5px] text-visiyon-text-3">
                          Add an extra layer of security: after your password, you'll also need a code from an authenticator app to log in.
                        </p>
                        <button onClick={handleStart2fa} className="text-[13px] font-medium px-4 py-2 rounded-lg border border-visiyon-border hover:border-visiyon-text transition-colors">
                          Set up 2FA
                        </button>
                        {twoFaError && <p className="text-[12.5px] text-red-400">{twoFaError}</p>}
                      </>
                    )}
                  </div>
                </section>
              </div>
            )}

            {tab === "keys" && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <KeyRound size={18} /> API keys
                  </h2>
                  <button onClick={() => setCreating((v) => !v)} className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-lg border border-visiyon-border hover:border-visiyon-text transition-colors">
                    <Plus size={14} /> New key
                  </button>
                </div>

                <p className="text-[12.5px] text-visiyon-text-3 mb-4">
                  Use an API key to call Visiyon's API directly (e.g. from a script or another app). The full value is only shown once, right after creation — store it somewhere safe.
                </p>

                {freshKey && (
                  <div className="border border-visiyon-text rounded-2xl p-4 mb-4">
                    <p className="text-[12.5px] text-visiyon-text-2 mb-2">Your new key — copy it now, it won't be shown again:</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-[13px] bg-visiyon-text/[0.06] rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap">{freshKey}</code>
                      <button onClick={handleCopy} className="p-2 rounded-lg border border-visiyon-border hover:border-visiyon-text transition-colors shrink-0" title="Copy">
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                    <button onClick={() => setFreshKey(null)} className="mt-3 text-[12px] text-visiyon-text-3 hover:text-visiyon-text">
                      Done, dismiss
                    </button>
                  </div>
                )}

                {creating && (
                  <div className="flex gap-2 mb-4">
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder='Label (optional, e.g. "laptop script")'
                      className="flex-1 text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                    />
                    <button onClick={handleCreate} className="text-[13px] font-medium px-4 py-2 rounded-lg bg-white text-black">
                      Create
                    </button>
                  </div>
                )}

                <div className="space-y-2">
                  {keys.length === 0 && <p className="text-visiyon-text-3 text-sm">No API keys yet.</p>}
                  {keys.map((k) => (
                    <div key={k.id} className="flex items-center justify-between border border-visiyon-border rounded-2xl px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium truncate">{k.label || "Unlabeled key"}</div>
                        <div className="text-[12px] text-visiyon-text-3 font-mono truncate">{k.masked}</div>
                        <div className="text-[11px] text-visiyon-text-3 mt-0.5">
                          Created {new Date(k.createdAt).toLocaleDateString()}
                          {k.lastUsed ? ` · last used ${new Date(k.lastUsed).toLocaleDateString()}` : " · never used"}
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          if (
                            await askConfirm({
                              title: "Revoke this API key? Anything using it will stop working immediately.",
                              confirmLabel: "Revoke",
                              danger: true,
                            })
                          ) {
                            await deleteApiKey(k.id);
                            refresh();
                          }
                        }}
                        className="text-visiyon-text-3 hover:text-red-400 shrink-0"
                        title="Revoke"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "memory" && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <BrainCircuit size={18} /> Memory
                  </h2>
                  <button
                    onClick={() => {
                      setShowMemoryImport((v) => !v);
                      setMemoryImportResult(null);
                    }}
                    className="flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-lg border border-visiyon-border hover:border-visiyon-text transition-colors"
                  >
                    <Upload size={13} /> Import memory
                  </button>
                </div>
                <p className="text-[12.5px] text-visiyon-text-3 mb-4">
                  What the AI has learned about you from past conversations, plus your name (pulled
                  automatically from your account). Edit or remove anything, or add a fact by hand.
                </p>

                {showMemoryImport && (
                  <div className="border border-visiyon-border rounded-2xl p-4 mb-4">
                    <p className="text-[12.5px] text-visiyon-text-2 mb-2">
                      Paste a memory export from another AI assistant, or just a list of facts — one per
                      line. Each line is added as a separate memory (existing/duplicate lines are skipped).
                    </p>
                    <textarea
                      value={memoryImportText}
                      onChange={(e) => setMemoryImportText(e.target.value)}
                      placeholder={'- Works as a backend developer\n- Prefers concise answers\n- Learning Spanish for a trip in June'}
                      rows={6}
                      className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text resize-y"
                    />
                    {memoryImportResult && (
                      <p className="text-[12.5px] text-visiyon-text-2 mt-2">{memoryImportResult}</p>
                    )}
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        onClick={handleImportMemory}
                        disabled={memoryImporting || !memoryImportText.trim()}
                        className="flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-2 rounded-lg bg-white text-black disabled:opacity-40"
                      >
                        <Upload size={13} /> {memoryImporting ? "Importing…" : "Import"}
                      </button>
                      <button
                        onClick={() => setShowMemoryImport(false)}
                        className="text-[12.5px] text-visiyon-text-3 hover:text-visiyon-text"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {memoriesError && <p className="text-[12.5px] text-red-400 mb-4">{memoriesError}</p>}

                {!memoriesError && (
                  <>
                    {memories === null && <p className="text-[13px] text-visiyon-text-3">Loading…</p>}
                    {memories !== null && memories.length === 0 && (
                      <p className="text-[13px] text-visiyon-text-3 mb-4">No stored facts yet.</p>
                    )}

                    <div className="space-y-2 mb-4">
                      {memories?.map((m) => (
                        <div key={m.id} className="flex items-start gap-2 border border-visiyon-border rounded-2xl px-4 py-3">
                          {editingMemoryId === m.id ? (
                            <>
                              <input
                                value={editingMemoryValue}
                                onChange={(e) => setEditingMemoryValue(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleSaveMemoryEdit(m.id)}
                                autoFocus
                                className="flex-1 text-[13px] bg-transparent text-visiyon-text outline-none border-b border-visiyon-border focus:border-visiyon-text"
                              />
                              <button onClick={() => handleSaveMemoryEdit(m.id)} className="text-[12px] text-visiyon-text-2 hover:text-visiyon-text shrink-0">
                                Save
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => {
                                  setEditingMemoryId(m.id);
                                  setEditingMemoryValue(m.content);
                                }}
                                className="flex-1 text-left text-[13px] text-visiyon-text-2 hover:text-visiyon-text"
                                title="Click to edit"
                              >
                                {m.content}
                              </button>
                              <span className="text-[11px] text-visiyon-text-3 shrink-0 mt-0.5">{m.source}</span>
                              <button onClick={() => handleDeleteMemory(m.id)} className="text-visiyon-text-3 hover:text-red-400 shrink-0">
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 mb-6">
                      <input
                        value={newMemoryFact}
                        onChange={(e) => setNewMemoryFact(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAddMemory()}
                        placeholder='Add a fact by hand, e.g. "Prefers concise answers"'
                        autoComplete="off"
                        className="flex-1 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                      <button
                        onClick={handleAddMemory}
                        disabled={memorySaving || !newMemoryFact.trim()}
                        className="flex items-center gap-1 text-[12.5px] font-medium px-3 py-2 rounded-lg border border-visiyon-border hover:border-visiyon-text transition-colors disabled:opacity-40"
                      >
                        <Plus size={14} /> Add
                      </button>
                    </div>

                    <button
                      onClick={handleClearMyMemories}
                      disabled={!memories || memories.length === 0}
                      className="text-[12.5px] text-visiyon-text-3 hover:text-red-400 disabled:opacity-40"
                    >
                      Forget everything the AI has learned about me
                    </button>
                  </>
                )}
              </div>
            )}

            {tab === "server" && (
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2 mb-2">
                  <Server size={18} /> Connect your server
                </h2>
                <p className="text-[12.5px] text-visiyon-text-3 mb-4">
                  Connect your own server over SSH so the AI can read and write files there directly during chats. It can only list, read, and write files — it can't run commands. Optionally restrict it to a base directory.
                </p>

                {serverLoading ? (
                  <p className="text-visiyon-text-3 text-sm">Loading…</p>
                ) : (
                  <>
                    {serverConn && (
                      <div className="border border-visiyon-border rounded-2xl px-4 py-3 mb-4 flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="text-[13.5px] font-medium truncate">
                            {serverConn.username}@{serverConn.host}:{serverConn.port}
                          </div>
                          <div className="text-[11px] text-visiyon-text-3 mt-0.5">
                            {serverConn.baseDir ? `Restricted to ${serverConn.baseDir}` : "No base directory restriction"}
                            {serverConn.lastTestedAt
                              ? ` · last tested ${new Date(serverConn.lastTestedAt).toLocaleString()} (${serverConn.lastTestOk ? "ok" : "failed"})`
                              : " · not tested yet"}
                          </div>
                        </div>
                        <button
                          onClick={handleServerDisconnect}
                          className="text-visiyon-text-3 hover:text-red-400 shrink-0"
                          title="Disconnect"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}

                    <div className="space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          value={serverForm.host}
                          onChange={(e) => setServerForm((f) => ({ ...f, host: e.target.value }))}
                          placeholder="Host (e.g. 203.0.113.5)"
                          className="col-span-2 text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                        />
                        <input
                          value={serverForm.port}
                          onChange={(e) => setServerForm((f) => ({ ...f, port: e.target.value }))}
                          placeholder="Port"
                          inputMode="numeric"
                          className="text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                        />
                      </div>
                      <input
                        value={serverForm.username}
                        onChange={(e) => setServerForm((f) => ({ ...f, username: e.target.value }))}
                        placeholder="Username"
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                      />

                      <div className="flex gap-2 text-[12.5px]">
                        <button
                          onClick={() => setServerForm((f) => ({ ...f, authType: "password" }))}
                          className={`px-3 py-1.5 rounded-lg border ${serverForm.authType === "password" ? "border-visiyon-text" : "border-visiyon-border text-visiyon-text-3"}`}
                        >
                          Password
                        </button>
                        <button
                          onClick={() => setServerForm((f) => ({ ...f, authType: "privateKey" }))}
                          className={`px-3 py-1.5 rounded-lg border ${serverForm.authType === "privateKey" ? "border-visiyon-text" : "border-visiyon-border text-visiyon-text-3"}`}
                        >
                          Private key
                        </button>
                      </div>

                      {serverForm.authType === "password" ? (
                        <input
                          type="password"
                          value={serverForm.password}
                          onChange={(e) => setServerForm((f) => ({ ...f, password: e.target.value }))}
                          placeholder={serverConn ? "New password (leave blank to keep current)" : "Password"}
                          className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                        />
                      ) : (
                        <>
                          <textarea
                            value={serverForm.privateKey}
                            onChange={(e) => setServerForm((f) => ({ ...f, privateKey: e.target.value }))}
                            placeholder={serverConn ? "New private key (leave blank to keep current)" : "-----BEGIN OPENSSH PRIVATE KEY-----…"}
                            rows={5}
                            className="w-full text-[12px] font-mono bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                          />
                          <input
                            type="password"
                            value={serverForm.passphrase}
                            onChange={(e) => setServerForm((f) => ({ ...f, passphrase: e.target.value }))}
                            placeholder="Passphrase (optional)"
                            className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                          />
                        </>
                      )}

                      <input
                        value={serverForm.baseDir}
                        onChange={(e) => setServerForm((f) => ({ ...f, baseDir: e.target.value }))}
                        placeholder="Base directory (optional, e.g. /home/user/project)"
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-lg px-3 py-2 outline-none focus:border-visiyon-text"
                      />

                      {serverError && <p className="text-[12.5px] text-red-400">{serverError}</p>}
                      {serverTestResult && (
                        <p className={`text-[12.5px] ${serverTestResult.ok ? "text-green-400" : "text-red-400"}`}>
                          {serverTestResult.ok ? "Connection OK" : `Test failed: ${serverTestResult.error}`}
                        </p>
                      )}

                      <div className="flex gap-2">
                        <button
                          onClick={handleServerSave}
                          disabled={serverSaving || !serverForm.host || !serverForm.username}
                          className="text-[13px] font-medium px-4 py-2 rounded-lg bg-white text-black visiyon-btn-primary disabled:opacity-50"
                        >
                          {serverSaving ? "Saving…" : serverConn ? "Save changes" : "Connect"}
                        </button>
                        {serverConn && (
                          <button
                            onClick={handleServerTest}
                            disabled={serverTesting}
                            className="text-[13px] font-medium px-4 py-2 rounded-lg border border-visiyon-border hover:border-visiyon-text transition-colors disabled:opacity-50"
                          >
                            {serverTesting ? "Testing…" : "Test connection"}
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {showBuyCredits && <BuyCreditsModal onClose={() => setShowBuyCredits(false)} />}
    </div>
  );
}


function formatBucketLabel(iso: string, range: "day" | "month" | "year"): string {
  const d = new Date(iso);
  if (range === "day") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "month") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}

function formatMoney(amountInCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amountInCents / 100);
  } catch {
    return `${(amountInCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function UsageBar({ label, used, limit, hideLabel }: { label: string; used: number; limit: number | null; hideLabel?: boolean }) {
  if (limit == null) {
    return (
      <div className="flex items-center justify-between text-[12px]">
        {!hideLabel && <span className="text-visiyon-text-2">{label}</span>}
        <span className="text-visiyon-text-3">{used} sent · unlimited</span>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const nearLimit = used >= limit;
  return (
    <div className="mt-2">
      {!hideLabel && (
        <div className="flex items-center justify-between text-[12px] mb-1">
          <span className="text-visiyon-text-2">{label}</span>
          <span className={nearLimit ? "text-red-400" : "text-visiyon-text-3"}>
            {used} / {limit}
          </span>
        </div>
      )}
      <div className="h-1.5 rounded-full bg-visiyon-text/[0.08] overflow-hidden">
        <div className={`h-full rounded-full ${nearLimit ? "bg-red-400" : "bg-white"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
