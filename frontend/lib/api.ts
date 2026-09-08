import { useChatStore } from "./store";

// Relative by default ("/api") instead of a hardcoded domain: nginx already
// proxies /api/ to the backend on the SAME origin the frontend is served
// from (see nginx.conf), so this works on any domain — localhost, a staging
// URL, ai.visiyon.com — with zero rebuilds. NEXT_PUBLIC_API_URL is baked in
// at BUILD time (Next.js inlines NEXT_PUBLIC_* vars into the JS bundle), so
// hardcoding a specific domain here was the bug: a build done without that
// env var set correctly permanently shipped "http://localhost/api" to every
// browser, which only works when the browser itself is on the same machine
// as the server (hence ERR_CONNECTION_REFUSED from a real domain). Only set
// NEXT_PUBLIC_API_URL if the API truly lives on a different origin than the
// frontend (e.g. a separate API subdomain) — otherwise leave it unset.
export const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

// Upload endpoints can fail before ever reaching our backend (e.g. nginx's
// client_max_body_size rejects an oversized file with a plain HTML 413 page).
// In that case res.json() throws and we'd otherwise fall back to a useless
// generic "Upload failed" with no explanation. This gives a real reason
// whenever we can infer one from the HTTP status.
async function uploadErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as { error?: string }));
  if (body.error) return body.error;
  if (res.status === 413) return "File is too large.";
  return `Upload failed (${res.status})`;
}

// Custom drag-and-drop MIME type used to drag an AI-generated file (from
// its chat message chip) onto the connected-server file browser panel —
// see MarkdownMessage's GeneratedFileChip (drag source) and
// ServerFilesPanel (drop target).
export const GENERATED_FILE_DRAG_MIME = "application/x-visiyon-generated-file";
function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    // Needed so the shared session cookie (set on login, scoped to
    // COOKIE_DOMAIN) is sent even when the frontend and API are reached
    // through different visiyon.com subdomains — the default "same-origin"
    // credentials mode would otherwise silently drop it cross-origin.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...init.headers,
    },
  });
  if (res.status === 401 && typeof window !== "undefined" && localStorage.getItem("visiyon_token")) {
    // Session expired or token invalidated — clear it and bounce to login
    // rather than leaving the app stuck silently failing every request.
    logout();
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login?session_expired=1";
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed: ${res.status}`);
    // Attach the raw error body so callers can branch on structured fields
    // like `needsCredits`/`required`/`available` (see /generate/image and
    // /generate/video's 402 responses) without re-parsing the message.
    Object.assign(err, body);
    throw err;
  }
  return res.json();
}

export type LoginResult =
  | { twoFaRequired: true; preAuthToken: string }
  | { twoFaRequired?: false; user: any };

export async function login(
  email: string,
  password: string,
  captcha?: { token: string; x: number; elapsedMs: number }
): Promise<LoginResult> {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      captchaToken: captcha?.token,
      captchaX: captcha?.x,
      captchaElapsedMs: captcha?.elapsedMs,
    }),
  });
  if (data.twoFaRequired) {
    return { twoFaRequired: true, preAuthToken: data.preAuthToken };
  }
  localStorage.setItem("visiyon_token", data.token);
  return { user: data.user };
}

// Second step of login for accounts with 2FA enabled — pass the
// preAuthToken from login() plus a 6-digit code or backup code.
export async function verify2fa(preAuthToken: string, code: string) {
  const data = await apiFetch("/auth/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ preAuthToken, code }),
  });
  localStorage.setItem("visiyon_token", data.token);
  return data.user;
}

export async function getMe() {
  const data = await apiFetch("/auth/me");
  return data.user;
}

export async function uploadAvatar(file: File): Promise<string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/auth/me/avatar`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    throw new Error(await uploadErrorMessage(res));
  }
  const data = await res.json();
  return data.avatarUrl;
}

export async function deleteAvatar() {
  return apiFetch("/auth/me/avatar", { method: "DELETE" });
}

// ---- 2FA (Settings page) ----
export async function setup2fa(): Promise<{ secret: string; otpauthUrl: string }> {
  return apiFetch("/auth/2fa/setup", { method: "POST" });
}

export async function enable2fa(code: string): Promise<{ ok: boolean; backupCodes: string[] }> {
  return apiFetch("/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code }) });
}

export async function disable2fa(password: string) {
  return apiFetch("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password }) });
}

export async function regenerateBackupCodes(password: string): Promise<{ ok: boolean; backupCodes: string[] }> {
  return apiFetch("/auth/2fa/backup-codes/regenerate", { method: "POST", body: JSON.stringify({ password }) });
}

// ---- Usage (Settings page widget) ----
// Note: despite the historic "today"/"daily" naming (kept to avoid a wider
// rename), usage is now tracked over a rolling window (see backend
// QUOTA_WINDOW_HOURS, default 5h) rather than resetting at midnight UTC.
export interface TodayUsage {
  tokenCount: number;
  imageCount: number;
  dailyTokenQuota: number | null;
  windowHours: number;
  // When the oldest usage event currently counted will age out of the
  // window and free up budget. Null if there's no usage right now.
  resetAt: string | null;
}

export async function getTodayUsage(): Promise<TodayUsage> {
  return apiFetch("/usage/today");
}

// ---- Usage & Analytics tab (Settings page) ----
export interface UsageHistoryBucket {
  date: string;
  tokens: number;
  images: number;
}

export async function getUsageHistory(range: "day" | "month" | "year"): Promise<{ range: string; buckets: UsageHistoryBucket[] }> {
  return apiFetch(`/usage/history?range=${range}`);
}

// ---- Billing (Settings page) ----
export interface LimitPopupCopy {
  title: string | null;
  message: string | null;
  buttonText: string | null;
}

export async function getBillingConfig(): Promise<{ enabled: boolean; limitPopup: LimitPopupCopy }> {
  const res = await fetch(`${API_URL}/billing/config`);
  return res.json();
}

export async function getBillingStatus(): Promise<{
  hasCustomer: boolean;
}> {
  return apiFetch("/billing/status");
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  periodStart: number | null;
  periodEnd: number | null;
}

export async function listInvoices(): Promise<{ invoices: Invoice[] }> {
  return apiFetch("/billing/invoices");
}

// ---- Credits (pay-as-you-go, replaces the old subscription upsell on
// /generate — see backend routes/credits.ts + lib/mediaCost.ts) ----

export interface CreditPackage {
  credits: number;
  amountCents: number;
}

export async function getCreditsConfig(): Promise<{ enabled: boolean; packages: CreditPackage[] }> {
  return apiFetch("/credits/config");
}

export async function getCreditsBalance(): Promise<{ credits: number }> {
  return apiFetch("/credits/balance");
}

export async function createCreditsCheckout(amountCents: number): Promise<{ url: string }> {
  return apiFetch("/credits/checkout", { method: "POST", body: JSON.stringify({ amountCents }) });
}

// ---- Message rating (thumbs up/down) ----
export async function rateMessage(chatId: string, messageId: string, rating: 1 | -1 | null) {
  return apiFetch(`/chats/${chatId}/messages/${messageId}/rating`, {
    method: "POST",
    body: JSON.stringify({ rating }),
  });
}

// ---- Onboarding ----
export async function markOnboardingSeen() {
  return apiFetch("/auth/onboarding-seen", { method: "POST" });
}

// ---- Admin: wasted tokens ----
export async function adminGetWastedTokens(): Promise<{
  totalWastedTokens: number;
  topUsers: { id: string; email: string; name: string | null; wastedTokens: number }[];
}> {
  return apiFetch("/admin/analytics/wasted-tokens");
}

// ---- Admin: webhooks ----
export async function adminListWebhooks() {
  return apiFetch("/admin/webhooks");
}

export async function adminCreateWebhook(url: string, events: string[]) {
  return apiFetch("/admin/webhooks", { method: "POST", body: JSON.stringify({ url, events }) });
}

export async function adminUpdateWebhook(id: string, body: { url?: string; events?: string[]; enabled?: boolean }) {
  return apiFetch(`/admin/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function adminRotateWebhookSecret(id: string) {
  return apiFetch(`/admin/webhooks/${id}/rotate-secret`, { method: "POST" });
}

export async function adminDeleteWebhook(id: string) {
  return apiFetch(`/admin/webhooks/${id}`, { method: "DELETE" });
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: "SUCCESS" | "FAILED";
  statusCode: number | null;
  error: string | null;
  attempt: number;
  createdAt: string;
}

export async function adminListWebhookDeliveries(webhookId: string): Promise<{ deliveries: WebhookDelivery[] }> {
  return apiFetch(`/admin/webhooks/${webhookId}/deliveries`);
}

export async function adminClearWebhookDeliveries(webhookId: string) {
  return apiFetch(`/admin/webhooks/${webhookId}/deliveries`, { method: "DELETE" });
}

export async function adminCleanupWebhookDeliveries(days?: number): Promise<{ ok: boolean; deleted: number }> {
  return apiFetch(`/admin/webhook-deliveries${days ? `?days=${days}` : ""}`, { method: "DELETE" });
}

export async function adminCleanupQuotaUsage(days?: number): Promise<{ ok: boolean; deleted: number }> {
  return apiFetch(`/admin/quota-usage${days ? `?days=${days}` : ""}`, { method: "DELETE" });
}

// ---- Analytics ----

export interface AnalyticsSummary {
  days: number;
  messageCount: number;
  activeUserCount: number;
  activeChatCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AnalyticsTimeseriesRow {
  date: string;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AnalyticsModelRow {
  model: string;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number | null;
}

export interface AnalyticsUserRow {
  userId: string;
  email: string;
  name: string | null;
  role: "USER" | "ADMIN" | null;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastActive: string;
}

export async function getAnalyticsSummary(days: number): Promise<AnalyticsSummary> {
  return apiFetch(`/admin/analytics/summary?days=${days}`);
}

export async function getAnalyticsTimeseries(days: number): Promise<{ rows: AnalyticsTimeseriesRow[] }> {
  return apiFetch(`/admin/analytics/timeseries?days=${days}`);
}

export async function getAnalyticsByModel(days: number): Promise<{ rows: AnalyticsModelRow[] }> {
  return apiFetch(`/admin/analytics/by-model?days=${days}`);
}

export async function getAnalyticsByUser(days: number): Promise<{ rows: AnalyticsUserRow[] }> {
  return apiFetch(`/admin/analytics/by-user?days=${days}`);
}

export interface FunctionUsageRow {
  id: string;
  name: string;
  slug?: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

export async function getFunctionsUsage(): Promise<{ filters: FunctionUsageRow[]; pipes: FunctionUsageRow[]; actions: FunctionUsageRow[] }> {
  return apiFetch("/admin/analytics/functions");
}

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; resetToken?: string }> {
  return apiFetch("/auth/request-reset", { method: "POST", body: JSON.stringify({ email }) });
}

export async function resetPassword(token: string, newPassword: string) {
  return apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) });
}

export async function changePassword(currentPassword: string, newPassword: string) {
  return apiFetch("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function getSsoConfig(): Promise<{ enabled: boolean; providerName: string }> {
  const res = await fetch(`${API_URL}/auth/sso/config`);
  return res.json();
}

export interface PublicBanner {
  id: string;
  type: "info" | "warning" | "error" | "success";
  content: string;
  enabled: boolean;
}

export interface PublicFeatureFlags {
  playground: boolean;
  studio: boolean;
  arena: boolean;
  music: boolean;
  generate: boolean;
  channels: boolean;
  notes: boolean;
  automations: boolean;
  upgradeButton: boolean;
  documentUpload: boolean;
  imageUpload: boolean;
  toolsMenu: boolean;
  cameraCapture: boolean;
  screenShare: boolean;
  greetingLogo: boolean;
  aiFaceAvatar: boolean;
  notifyBanner: boolean;
  chatControlsButton: boolean;
  apiKeysTab: boolean;
}

export interface SsoProviderSummary {
  key: string;
  providerName: string;
}

export async function getPublicConfig(): Promise<{
  signupEnabled: boolean;
  sso: { providers: SsoProviderSummary[] };
  banners: PublicBanner[];
  terms: { required: boolean; content: string };
  features: PublicFeatureFlags;
  captcha: { enabled: boolean };
}> {
  const res = await fetch(`${API_URL}/auth/public-config`);
  return res.json();
}

export interface CaptchaChallenge {
  id: string;
  targetX: number;
  width: number;
  height: number;
  pieceSize: number;
  issuedAt: number;
  token: string;
}

export async function getCaptchaChallenge(): Promise<CaptchaChallenge> {
  const res = await fetch(`${API_URL}/auth/captcha/challenge`);
  return res.json();
}

// Sidebar and header components on every page each want the feature
// flags from public-config but shouldn't all refetch it independently —
// this in-memory cache (reset on full page load) means only the first
// caller in a given page lifetime actually hits the network.
let publicConfigCache: ReturnType<typeof getPublicConfig> | null = null;

export function getPublicConfigCached() {
  if (!publicConfigCache) publicConfigCache = getPublicConfig();
  return publicConfigCache;
}

export async function adminSetSignupEnabled(enabled: boolean) {
  return apiFetch("/admin/config/signup", { method: "POST", body: JSON.stringify({ enabled }) });
}

// ---- Instance settings (Settings > General) ----
export interface AppBanner {
  id: string;
  type: "info" | "warning" | "error" | "success";
  content: string;
  enabled: boolean;
}
export interface AppSettings {
  communitySharingEnabled: boolean;
  messageRatingEnabled: boolean;
  foldersEnabled: boolean;
  memoriesEnabled: boolean;
  memorySystemContextEnabled: boolean;
  notesEnabled: boolean;
  channelsEnabled: boolean;
  calendarEnabled: boolean;
  automationsEnabled: boolean;
  userWebhooksEnabled: boolean;
  userStatusEnabled: boolean;
  playgroundEnabled: boolean;
  studioEnabled: boolean;
  arenaEnabled: boolean;
  upgradeButtonEnabled: boolean;
  responseWatermark: string | null;
  webuiUrl: string | null;
  termsRequired: boolean;
  termsOfService: string | null;
  captchaEnabled: boolean;
  banners: AppBanner[];
  stripeSecretKey: string | null;
  stripePublishableKey: string | null;
  stripeWebhookSecret: string | null;
  musicGenEnabled: boolean;
  musicGenUrl: string | null;
  musicGenApiKey: string | null;
  musicGenModel: string | null;
  musicGenCallbackUrl: string | null;
  kieGenEnabled: boolean;
  kieGenUrl: string | null;
  kieGenApiKey: string | null;
  ssoEnabled: boolean | null;
  ssoProviderName: string | null;
  ssoIssuerUrl: string | null;
  ssoClientId: string | null;
  ssoClientSecret: string | null;
  ssoScopes: string | null;
  ssoRedirectUri: string | null;
  imageGenEnabled: boolean | null;
  imageGenProvider: "custom" | "selfhosted" | "openai" | "stability" | null;
  imageGenUrl: string | null;
  imageGenApiKey: string | null;
  stabilityApiKey: string | null;
  webSearchEnabled: boolean | null;
  webSearchProvider: "searxng" | null;
  webSearchUrl: string | null;
  webSearchApiKey: string | null;
  internetAccessEnabled: boolean | null;
  voiceSttEnabled: boolean | null;
  voiceTtsEnabled: boolean | null;
  voiceTtsProvider: "piper" | "coqui" | "kokoro" | "elevenlabs" | null;
  voiceTtsVoice: string | null;
  voiceTtsUrl: string | null;
  voiceTtsApiKey: string | null;
  defaultTokenQuota: number | null;
  quotaWindowHours: number | null;
  limitPopupTitle: string | null;
  limitPopupMessage: string | null;
  limitPopupButtonText: string | null;
  documentMaxUploadMb: number | null;
  voiceMaxUploadMb: number | null;
  avatarMaxUploadMb: number | null;
  documentUploadEnabled: boolean;
  imageUploadEnabled: boolean;
  toolsMenuEnabled: boolean;
  cameraCaptureEnabled: boolean;
  screenShareEnabled: boolean;
  greetingLogoEnabled: boolean;
  aiFaceAvatarEnabled: boolean;
  chatControlsButtonEnabled: boolean;
  apiKeysTabEnabled: boolean;
  notifyBannerEnabled: boolean;
  musicNavHidden: boolean;
}

export async function adminGetSettings(): Promise<{ settings: AppSettings }> {
  return apiFetch("/admin/settings");
}

export async function adminUpdateSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings }> {
  return apiFetch("/admin/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

export async function register(
  email: string,
  password: string,
  name?: string,
  acceptedTerms?: boolean,
  captcha?: { token: string; x: number; elapsedMs: number },
  inviteToken?: string
) {
  const data = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      name,
      acceptedTerms,
      captchaToken: captcha?.token,
      captchaX: captcha?.x,
      captchaElapsedMs: captcha?.elapsedMs,
      inviteToken,
    }),
  });
  localStorage.setItem("visiyon_token", data.token);
  return data.user;
}

// ---- Invites (public lookup, for the register page prefill) ----
export async function getInvite(token: string): Promise<{ email: string }> {
  const res = await fetch(`${API_URL}/auth/invites/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error("This invite link is invalid or has expired.");
  return res.json();
}

export function logout() {
  localStorage.removeItem("visiyon_token");
  useChatStore.getState().resetForLogout();
  // Fire-and-forget: clears the shared visiyon.com session cookie so
  // other subdomains (and this one, next time) don't stay logged in via
  // the cookie fallback in requireAuth after the user explicitly logged out.
  fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
}

export async function listModels() {
  const data = await apiFetch("/models");
  return data.models as {
    name: string;
    family?: string;
    parameterSize?: string;
    displayName?: string;
    description?: string | null;
    chatControlsEnabled?: boolean;
  }[];
}

// ---- Default chat model --------------------------------------------------
// Several places need *some* model to fall back to before the user has
// explicitly picked one (a brand-new chat, the prompt improver, the "new
// chat" button in the sidebar). This used to be hardcoded to "glm4:9b" —
// wrong, since that tag isn't necessarily pulled on a given deployment and
// silently broke every one of those flows.
//
// Just taking models[0] isn't good enough either: /models lists raw Ollama
// tags first and meta-models ("Jean") last, so models[0] can land on some
// individual pulled model that's broken/incompatible (e.g. errors with a
// 400 on an actual chat request) even though it shows up fine in the list.
// A meta-model is specifically built to race several real candidates with
// automatic failover, so it's the safer bet whenever one exists — prefer
// that, and only fall back to the first plain entry if there's no
// meta-model configured at all. Cached for the tab's lifetime since the
// available model list rarely changes mid-session; a hard refresh
// re-fetches it.
let cachedDefaultModel: string | null | undefined;
export async function getDefaultModel(): Promise<string | null> {
  if (cachedDefaultModel !== undefined) return cachedDefaultModel;
  try {
    const models = await listModels();
    const metaModel = models.find((m) => m.name.startsWith("meta:"));
    cachedDefaultModel = metaModel?.name ?? models[0]?.name ?? null;
  } catch {
    cachedDefaultModel = null;
  }
  return cachedDefaultModel;
}

// ---- Admin: per-model overrides (display name + the "Model Params"
// editor: system prompt, generation params, default feature toggles) ----
export interface ModelParams {
  temperature?: number;
  top_p?: number;
  num_ctx?: number;
  seed?: number;
  stop?: string;
  max_tokens?: number;
  // Hardware offload — Ollama's num_gpu (layers offloaded to GPU/NPU,
  // -1/unset = let Ollama decide, 0 = CPU only) and num_thread (CPU
  // threads for the rest). Local Ollama models only.
  num_gpu?: number;
  num_thread?: number;
}

export interface ModelDefaultFeatures {
  webSearch?: boolean;
  imageGeneration?: boolean;
  codeInterpreter?: boolean;
  // Whether regular users may open the Chat Controls panel (per-chat
  // temperature/context/max-tokens overrides, etc.) for this model.
  // Defaults to true when unset, so existing models keep working as
  // before until an admin explicitly turns it off.
  chatControlsEnabled?: boolean;
}

export interface ModelSetting {
  name: string;
  displayName: string | null;
  hidden: boolean;
  systemPrompt: string | null;
  params: ModelParams | null;
  defaultFeatures: ModelDefaultFeatures | null;
  // Tool.id[] — built-in/HTTP tools auto-attached to every new chat on
  // this model (Tools tab in the modal). See routes/chats.ts POST /chats.
  defaultToolIds: string[] | null;
  updatedAt: string;
}

export async function adminListModelSettings(): Promise<{ settings: ModelSetting[] }> {
  return apiFetch("/admin/models/settings");
}

export async function adminSetModelSetting(
  name: string,
  patch: {
    displayName?: string | null;
    hidden?: boolean;
    systemPrompt?: string | null;
    params?: ModelParams | null;
    defaultFeatures?: ModelDefaultFeatures | null;
    defaultToolIds?: string[] | null;
  }
): Promise<{ setting: ModelSetting }> {
  // name goes in the body, not the URL path — model names containing "/"
  // (bundle/provider models like "01-ai/yi-large") break as a path segment.
  return apiFetch(`/admin/models/settings`, {
    method: "PUT",
    body: JSON.stringify({ name, ...patch }),
  });
}

export async function adminDeleteModelSetting(name: string) {
  return apiFetch(`/admin/models/settings`, {
    method: "DELETE",
    body: JSON.stringify({ name }),
  });
}

// One request that hides/shows every model in `names` at once — used for
// "Hide all / Show all" on a provider bundle (avoids firing 90+ parallel
// PUT requests, which was failing under load).
export async function adminBulkSetModelHidden(
  names: string[],
  hidden: boolean
): Promise<{ ok: boolean; count: number }> {
  return apiFetch(`/admin/models/settings/bulk`, {
    method: "POST",
    body: JSON.stringify({ names, hidden }),
  });
}

// Raw Ollama model list (unfiltered by group access or hidden overrides) —
// used by the admin models page so a hidden model can still be found and
// un-hidden.
export async function adminGetVersion(): Promise<{ version: string }> {
  return apiFetch("/admin/version");
}

// ---- Self-update (Admin > Updates) ----
export interface UpdateCheckResult {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  checkedAt: string;
}

export interface UpdateStatus {
  state: "idle" | "running" | "success" | "failed";
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export async function adminCheckForUpdate(force = false): Promise<UpdateCheckResult> {
  return apiFetch(`/admin/updates/check${force ? "?force=true" : ""}`);
}

export async function adminGetUpdateStatus(): Promise<UpdateStatus> {
  return apiFetch("/admin/updates/status");
}

export async function adminApplyUpdate(): Promise<{ ok: boolean; message: string }> {
  return apiFetch("/admin/updates/apply", { method: "POST" });
}

export interface SystemStats {
  cpu: { cores: number; loadAvg1: number; loadAvg5: number; loadAvg15: number; usedPercent: number };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number };
  disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number } | null;
  gpus: {
    index: number;
    name: string;
    utilizationPercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    temperatureC: number | null;
  }[] | null;
}

export async function adminGetHealth(): Promise<{
  ollama: { up: boolean; models: string[] };
  searxng: { up: boolean };
  system: SystemStats;
}> {
  return apiFetch("/admin/health");
}

// Pull a model onto every configured Ollama instance. Ollama's own pull can
// take minutes for a large model, so this is fire-and-forget from the
// caller's point of view — the admin page polls /admin/health afterwards to
// see the new model show up in `ollama.models`.
export async function adminPullModel(name: string): Promise<{ ok: boolean; failed?: string[] }> {
  return apiFetch("/admin/models/pull", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function adminDeleteOllamaModel(name: string): Promise<{ ok: boolean; failed?: string[] }> {
  return apiFetch(`/admin/models/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export interface CatalogGpu {
  index: number;
  name: string;
  totalVramGB: number;
  freeVramGB: number;
  utilizationPercent: number;
}

export interface CatalogModel {
  tag: string;
  label: string;
  family: string;
  paramsB: number;
  quant: string;
  sizeGB: number;
  minVramGB: number;
  vision?: boolean;
  description: string;
  installed: boolean;
  fits: boolean | null;
  fitsNow: boolean | null;
}

// Scans the GPU(s) attached to the backend (nvidia-smi) and reports which
// popular models from the catalog would actually fit — shown above the raw
// pull box so an admin can see "will it run" before typing a tag by hand.
export async function adminGetModelCatalog(): Promise<{
  gpus: CatalogGpu[];
  gpuStatsAvailable: boolean;
  models: CatalogModel[];
}> {
  return apiFetch("/admin/models/catalog");
}

export async function listChats(q?: string, archived?: boolean) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (archived) params.set("archived", "true");
  const qs = params.toString();
  const data = await apiFetch(`/chats${qs ? `?${qs}` : ""}`);
  return data.chats;
}

export async function createChat(model: string) {
  const data = await apiFetch("/chats", { method: "POST", body: JSON.stringify({ model }) });
  return data.chat;
}

export async function getChat(chatId: string) {
  const data = await apiFetch(`/chats/${chatId}`);
  return data.chat;
}

export async function renameChat(chatId: string, title: string) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ title }) });
}

// Prompt improver: sends the short draft the user typed and gets back a
// fuller, more detailed prompt to show in the composer before sending.
export async function improvePrompt(text: string, model: string): Promise<{ improved: string }> {
  return apiFetch(`/prompts/improve`, { method: "POST", body: JSON.stringify({ text, model }) });
}

export async function describeImage(imageUrl: string, model: string): Promise<{ description: string }> {
  return apiFetch(`/prompts/describe-image`, { method: "POST", body: JSON.stringify({ imageUrl, model }) });
}

export async function pinChat(chatId: string, pinned: boolean) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ pinned }) });
}

export async function archiveChat(chatId: string, archived: boolean) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ archived }) });
}

// Agent mode: lets the model chain several tool calls in one turn
// (search, then read a page, then write a file, ...) instead of the
// normal one-call-then-answer limit. Own build, off by default, toggled
// per chat. See runAgentLoop in backend/src/routes/chats.ts.
export async function setChatAgentMode(chatId: string, agentMode: boolean) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ agentMode }) });
}

export async function deleteChat(chatId: string) {
  return apiFetch(`/chats/${chatId}`, { method: "DELETE" });
}

// ---- Documents (RAG) ----

export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  error?: string | null;
  createdAt: string;
  _count?: { chunks: number };
}

export async function uploadDocument(file: File): Promise<DocumentSummary> {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/documents`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    throw new Error(await uploadErrorMessage(res));
  }
  const data = await res.json();
  return data.document;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const data = await apiFetch("/documents");
  return data.documents;
}

export async function deleteDocument(documentId: string) {
  return apiFetch(`/documents/${documentId}`, { method: "DELETE" });
}

// Auth'd document download — a plain <a href> can't carry the
// Authorization header, so the JWT (when present) is appended as
// ?token=, the same fallback requireAuth already accepts for SSE. Falls
// back to the shared session cookie when there's no localStorage token
// (e.g. SSO login), same as apiFetch elsewhere.
export function documentDownloadUrl(documentId: string): string {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  return `${API_URL}/documents/${documentId}/download${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export async function listChatDocuments(chatId: string): Promise<DocumentSummary[]> {
  const data = await apiFetch(`/chats/${chatId}/documents`);
  return data.documents;
}

export async function attachDocument(chatId: string, documentId: string) {
  return apiFetch(`/chats/${chatId}/documents`, {
    method: "POST",
    body: JSON.stringify({ documentId }),
  });
}

export async function detachDocument(chatId: string, documentId: string) {
  return apiFetch(`/chats/${chatId}/documents/${documentId}`, { method: "DELETE" });
}

// ---- Prompt Library ----

export interface Prompt {
  id: string;
  title: string;
  content: string;
  description?: string | null;
  sharedWithAll: boolean;
  userId: string;
  user?: { id: string; name?: string | null; email: string };
}

export async function listPrompts(): Promise<Prompt[]> {
  const data = await apiFetch("/prompts");
  return data.prompts;
}

export async function createPrompt(input: {
  title: string;
  content: string;
  description?: string;
  sharedWithAll?: boolean;
}): Promise<Prompt> {
  const data = await apiFetch("/prompts", { method: "POST", body: JSON.stringify(input) });
  return data.prompt;
}

export async function updatePrompt(
  promptId: string,
  input: Partial<{ title: string; content: string; description: string; sharedWithAll: boolean }>
): Promise<Prompt> {
  const data = await apiFetch(`/prompts/${promptId}`, { method: "PATCH", body: JSON.stringify(input) });
  return data.prompt;
}

export async function deletePrompt(promptId: string) {
  return apiFetch(`/prompts/${promptId}`, { method: "DELETE" });
}

// Apply a prompt preset's content as the chat's persistent system prompt.
export async function setChatSystemPrompt(chatId: string, systemPrompt: string | null) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ systemPrompt }) });
}

export type ChatControlsFields = Partial<{
  model: string;
  systemPrompt: string | null;
  streamResponse: boolean | null;
  stopSequence: string | null;
  temperature: number | null;
  topP: number | null;
  minP: number | null;
  topK: number | null;
  frequencyPenalty: number | null;
  mirostat: number | null;
  mirostatEta: number | null;
  mirostatTau: number | null;
  tfsZ: number | null;
  seed: number | null;
  repeatLastN: number | null;
  numCtx: number | null;
  numBatch: number | null;
  numKeep: number | null;
  numPredict: number | null;
  useMmap: boolean | null;
  useMlock: boolean | null;
}>;

export async function setChatParameters(chatId: string, params: ChatControlsFields) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(params) });
}

// ---- Groups (permissions) ----

export interface Group {
  id: string;
  name: string;
  description?: string | null;
  modelAccess: string[];
  dailyTokenQuota?: number | null;
  isDefault?: boolean;
  _count?: { users: number };
}

export async function listGroups(): Promise<Group[]> {
  const data = await apiFetch("/admin/groups");
  return data.groups;
}

export async function createGroup(input: {
  name: string;
  description?: string;
  modelAccess?: string[];
  dailyTokenQuota?: number | null;
  isDefault?: boolean;
}) {
  const data = await apiFetch("/admin/groups", { method: "POST", body: JSON.stringify(input) });
  return data.group as Group;
}

export async function updateGroup(
  groupId: string,
  input: Partial<{
    name: string;
    description: string;
    modelAccess: string[];
    dailyTokenQuota: number | null;
    isDefault: boolean;
  }>
) {
  const data = await apiFetch(`/admin/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(input) });
  return data.group as Group;
}

export async function deleteGroup(groupId: string) {
  return apiFetch(`/admin/groups/${groupId}`, { method: "DELETE" });
}

export async function setUserGroup(userId: string, groupId: string | null) {
  return apiFetch(`/admin/users/${userId}/group`, { method: "PATCH", body: JSON.stringify({ groupId }) });
}

// ---- Invites (Admin > Users > Invite user) ----

export interface Invite {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  groupId?: string | null;
  group?: { id: string; name: string } | null;
  expiresAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

export async function listInvites(): Promise<Invite[]> {
  const data = await apiFetch("/admin/invites");
  return data.invites;
}

export async function createInvite(input: { email: string; role?: "USER" | "ADMIN"; groupId?: string | null }) {
  const data = await apiFetch("/admin/invites", { method: "POST", body: JSON.stringify(input) });
  return data.invite as Invite;
}

export async function resendInvite(inviteId: string) {
  const data = await apiFetch(`/admin/invites/${inviteId}/resend`, { method: "POST" });
  return data.invite as Invite;
}

export async function revokeInvite(inviteId: string) {
  return apiFetch(`/admin/invites/${inviteId}`, { method: "DELETE" });
}

// ---- AI memory (Admin > Users > a user > Memory) ----

export interface UserMemory {
  id: string;
  userId: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export async function listUserMemories(userId: string): Promise<{ memories: UserMemory[] }> {
  return apiFetch(`/admin/users/${userId}/memories`);
}

export async function addUserMemory(userId: string, content: string): Promise<{ memory: UserMemory }> {
  return apiFetch(`/admin/users/${userId}/memories`, { method: "POST", body: JSON.stringify({ content }) });
}

export async function updateUserMemory(userId: string, memoryId: string, content: string): Promise<{ memory: UserMemory }> {
  return apiFetch(`/admin/users/${userId}/memories/${memoryId}`, { method: "PATCH", body: JSON.stringify({ content }) });
}

export async function deleteUserMemory(userId: string, memoryId: string) {
  return apiFetch(`/admin/users/${userId}/memories/${memoryId}`, { method: "DELETE" });
}

export async function clearUserMemories(userId: string) {
  return apiFetch(`/admin/users/${userId}/memories`, { method: "DELETE" });
}

// ---- AI memory, self-service (Settings > Memory) — same shape as the
// admin-only functions above, scoped to the logged-in user via /auth/me/*.

export async function listMyMemories(): Promise<{ memories: UserMemory[] }> {
  return apiFetch(`/auth/me/memories`);
}

export async function addMyMemory(content: string): Promise<{ memory: UserMemory }> {
  return apiFetch(`/auth/me/memories`, { method: "POST", body: JSON.stringify({ content }) });
}

export async function updateMyMemory(memoryId: string, content: string): Promise<{ memory: UserMemory }> {
  return apiFetch(`/auth/me/memories/${memoryId}`, { method: "PATCH", body: JSON.stringify({ content }) });
}

export async function deleteMyMemory(memoryId: string) {
  return apiFetch(`/auth/me/memories/${memoryId}`, { method: "DELETE" });
}

export async function clearMyMemories() {
  return apiFetch(`/auth/me/memories`, { method: "DELETE" });
}

// ---- Tools (function calling) ----

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
}

export interface HttpToolConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  parameters: ToolParameter[];
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  type: "BUILTIN" | "HTTP" | "MCP";
  config: { parameters?: ToolParameter[] } & Partial<HttpToolConfig>;
  enabled: boolean;
}

export async function listTools(): Promise<Tool[]> {
  const data = await apiFetch("/tools");
  return data.tools;
}

export async function listAllTools(): Promise<Tool[]> {
  const data = await apiFetch("/tools/all");
  return data.tools;
}

export async function createHttpTool(input: {
  name: string;
  description: string;
  config: HttpToolConfig;
}): Promise<Tool> {
  const data = await apiFetch("/tools", { method: "POST", body: JSON.stringify(input) });
  return data.tool;
}

export async function updateTool(
  toolId: string,
  input: Partial<{ enabled: boolean; description: string; config: HttpToolConfig }>
): Promise<Tool> {
  const data = await apiFetch(`/tools/${toolId}`, { method: "PATCH", body: JSON.stringify(input) });
  return data.tool;
}

export async function deleteTool(toolId: string) {
  return apiFetch(`/tools/${toolId}`, { method: "DELETE" });
}

export async function listChatTools(chatId: string): Promise<Tool[]> {
  const data = await apiFetch(`/chats/${chatId}/tools`);
  return data.tools;
}

export async function attachTool(chatId: string, toolId: string) {
  return apiFetch(`/chats/${chatId}/tools`, { method: "POST", body: JSON.stringify({ toolId }) });
}

export async function detachTool(chatId: string, toolId: string) {
  return apiFetch(`/chats/${chatId}/tools/${toolId}`, { method: "DELETE" });
}

// ---- Folders ----

export interface Folder {
  id: string;
  name: string;
  _count?: { chats: number };
}

export async function listFolders(): Promise<Folder[]> {
  const data = await apiFetch("/folders");
  return data.folders;
}

export async function createFolder(name: string): Promise<Folder> {
  const data = await apiFetch("/folders", { method: "POST", body: JSON.stringify({ name }) });
  return data.folder;
}

export async function renameFolder(folderId: string, name: string): Promise<Folder> {
  const data = await apiFetch(`/folders/${folderId}`, { method: "PATCH", body: JSON.stringify({ name }) });
  return data.folder;
}

export async function deleteFolder(folderId: string) {
  return apiFetch(`/folders/${folderId}`, { method: "DELETE" });
}

export async function moveChatToFolder(chatId: string, folderId: string | null) {
  return apiFetch(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ folderId }) });
}

// ---- API keys ----

export interface ApiKeySummary {
  id: string;
  label?: string | null;
  masked: string;
  createdAt: string;
  lastUsed?: string | null;
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const data = await apiFetch("/api-keys");
  return data.keys;
}

// Returns the full key value — only available at creation time.
export async function createApiKey(label?: string): Promise<{ id: string; key: string; label?: string | null }> {
  return apiFetch("/api-keys", { method: "POST", body: JSON.stringify({ label }) });
}

export async function deleteApiKey(keyId: string) {
  return apiFetch(`/api-keys/${keyId}`, { method: "DELETE" });
}

// ---- Voice (STT/TTS) — fully local via self-hosted Whisper + Piper ----
export async function getVoiceConfig(): Promise<{ sttEnabled: boolean; ttsEnabled: boolean }> {
  return apiFetch("/voice/config");
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "recording.webm");
  const res = await fetch(`${API_URL}/voice/transcribe`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Transcription failed");
  }
  const data = await res.json();
  return data.text as string;
}

export async function speakText(text: string): Promise<string> {
  const res = await fetch(`${API_URL}/voice/speak`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Speech synthesis failed");
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ---- Pipelines (moderation/hooks) ----
export type Pipeline = {
  id: string;
  name: string;
  enabled: boolean;
  stage: "PRE" | "POST";
  matchType: "KEYWORD" | "REGEX" | "AI";
  pattern: string;
  action: "BLOCK" | "FLAG";
  message: string;
  order: number;
  aiModel?: string | null;
};

export type FlaggedMessage = {
  id: string;
  role: string;
  content: string;
  flagReason: string | null;
  createdAt: string;
  chat: { id: string; title: string; userId: string };
};

export async function listPipelines(): Promise<Pipeline[]> {
  const data = await apiFetch("/pipelines");
  return data.pipelines;
}

export async function createPipeline(input: Omit<Pipeline, "id" | "enabled"> & { enabled?: boolean }): Promise<Pipeline> {
  const data = await apiFetch("/pipelines", { method: "POST", body: JSON.stringify(input) });
  return data.pipeline;
}

export async function updatePipeline(id: string, input: Partial<Pipeline>): Promise<Pipeline> {
  const data = await apiFetch(`/pipelines/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  return data.pipeline;
}

export async function deletePipeline(id: string) {
  return apiFetch(`/pipelines/${id}`, { method: "DELETE" });
}

export async function listFlaggedMessages(): Promise<FlaggedMessage[]> {
  const data = await apiFetch("/pipelines/flagged");
  return data.messages;
}

// ---- Security alerts (24/7 background scanner) ----
export type SecurityAlertType = "DUPLICATE_CONTENT_BURST" | "MESSAGE_RATE_BURST" | "RAPID_SIGNUP";
export type SecurityAlertStatus = "OPEN" | "DISMISSED" | "ACTIONED";

export interface SecurityAlert {
  id: string;
  type: SecurityAlertType;
  status: SecurityAlertStatus;
  userId: string | null;
  user: { id: string; email: string; name: string | null } | null;
  summary: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

export async function listSecurityAlerts(status?: SecurityAlertStatus): Promise<SecurityAlert[]> {
  const data = await apiFetch(`/admin/security/alerts${status ? `?status=${status}` : ""}`);
  return data.alerts;
}

export async function updateSecurityAlert(alertId: string, status: SecurityAlertStatus): Promise<SecurityAlert> {
  const data = await apiFetch(`/admin/security/alerts/${alertId}`, { method: "PATCH", body: JSON.stringify({ status }) });
  return data.alert;
}

// ---- Admin: app event log ----
export type LogEntry = {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  source: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export async function listLogs(filters?: { level?: string; source?: string; limit?: number }): Promise<LogEntry[]> {
  const params = new URLSearchParams();
  if (filters?.level) params.set("level", filters.level);
  if (filters?.source) params.set("source", filters.source);
  if (filters?.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const data = await apiFetch(`/admin/logs${qs ? `?${qs}` : ""}`);
  return data.logs;
}

export async function clearLogs() {
  return apiFetch("/admin/logs", { method: "DELETE" });
}

// ---- Run Python — code-block "Run" button (see MarkdownMessage.tsx) ----
export type RunPythonResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
};

export async function runPythonSnippet(code: string): Promise<RunPythonResult> {
  return apiFetch("/tools/run-python", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

// ---- Chat sharing ----
export async function editMessage(chatId: string, messageId: string, content: string) {
  return apiFetch(`/chats/${chatId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

export async function shareChat(chatId: string): Promise<{ shareId: string }> {
  const data = await apiFetch(`/chats/${chatId}/share`, { method: "POST" });
  return data;
}

export async function unshareChat(chatId: string) {
  return apiFetch(`/chats/${chatId}/share`, { method: "DELETE" });
}

export async function getSharedChat(shareId: string) {
  const res = await fetch(`${API_URL}/public/chats/${shareId}`);
  if (!res.ok) throw new Error("Chat not found or no longer shared");
  return res.json();
}

// ---- Image generation ----
export type ImageSize = "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";

export async function generateImage(prompt: string, size?: ImageSize): Promise<{ url: string }> {
  const data = await apiFetch("/images/generate", { method: "POST", body: JSON.stringify({ prompt, size }) });
  return data;
}

export async function generateChatImage(
  chatId: string,
  prompt: string,
  size?: ImageSize
): Promise<{ message: { id: string; role: string; content: string } }> {
  return apiFetch(`/chats/${chatId}/image`, { method: "POST", body: JSON.stringify({ prompt, size }) });
}

export async function imageGenConfig(): Promise<{ enabled: boolean }> {
  return apiFetch("/images/config");
}

// ---- Music generation ----
export interface MusicTrack {
  id: string;
  title: string;
  audioUrl: string;
  coverUrl?: string;
  durationSeconds?: number;
}

export async function musicGenConfig(): Promise<{ enabled: boolean }> {
  return apiFetch("/music/config");
}

export async function startMusicGeneration(
  prompt: string,
  opts: { instrumental?: boolean; customMode?: boolean; title?: string; style?: string } = {}
): Promise<{ taskId: string }> {
  return apiFetch("/music/generate", { method: "POST", body: JSON.stringify({ prompt, ...opts }) });
}

export async function checkMusicGeneration(
  taskId: string
): Promise<{ status: "pending" | "complete" | "failed"; tracks?: MusicTrack[]; error?: string }> {
  return apiFetch(`/music/generate/${taskId}`);
}

// ---- Generate page (Kling-style image/video generation via kie.ai) ----

export type MediaModality = "image" | "video";

export interface MediaModel {
  key: string;
  label: string;
  modality: MediaModality;
  resolution?: string;
  recommended?: boolean;
  // Credits charged for one use of this model — flat cost for image
  // models, cost for a 5s clip for video models (real charge scales with
  // the chosen duration; see backend lib/mediaCost.ts).
  creditsPerUse?: number;
}

export interface MediaGeneration {
  id: string;
  taskId: string;
  modality: "IMAGE" | "VIDEO";
  modelKey: string;
  status: "PENDING" | "COMPLETE" | "FAILED";
  prompt: string;
  aspectRatio?: string | null;
  durationSeconds?: number | null;
  resultUrls?: string[] | null;
  error?: string | null;
  isPublic?: boolean;
  likeCount?: number;
  createdAt: string;
}

export interface ExploreFeedItem {
  id: string;
  taskId: string;
  modality: "IMAGE" | "VIDEO";
  modelKey: string;
  prompt: string;
  aspectRatio?: string | null;
  resultUrls?: string[] | null;
  likeCount: number;
  publishedAt: string | null;
  user: { id: string; name: string | null };
  // Whether the currently-logged-in account has already liked this item
  // — the backend now tracks likes per account (see MediaGenerationLike),
  // so this reflects real state instead of the feed always coming back
  // "not liked" after a refresh.
  likedByMe?: boolean;
}

export async function generateConfig(): Promise<{ enabled: boolean; models: MediaModel[] }> {
  return apiFetch("/generate/config");
}

// ---- Explore feed: publish/like a generation, fetch the public feed. ----

export async function publishGeneration(taskId: string, publish = true): Promise<{ generation: MediaGeneration }> {
  return apiFetch(`/generate/${encodeURIComponent(taskId)}/publish`, {
    method: "POST",
    body: JSON.stringify({ publish }),
  });
}

export async function likeGeneration(taskId: string, like = true): Promise<{ likeCount: number; liked?: boolean }> {
  return apiFetch(`/generate/${encodeURIComponent(taskId)}/like`, {
    method: "POST",
    body: JSON.stringify({ like }),
  });
}

export async function exploreFeed(cursor?: string): Promise<{ items: ExploreFeedItem[]; nextCursor: string | null }> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch(`/generate/explore/feed${qs}`);
}

export async function startImageGeneration(
  prompt: string,
  modelKey: string,
  opts: { aspectRatio?: string; imageUrl?: string; count?: number } = {}
): Promise<{ taskIds: string[] }> {
  return apiFetch("/generate/image", { method: "POST", body: JSON.stringify({ prompt, modelKey, ...opts }) });
}

export async function startVideoGeneration(
  prompt: string,
  modelKey: string,
  opts: {
    durationSeconds?: number;
    imageUrl?: string;
    nativeAudio?: boolean;
    elementNames?: string[];
    motionVideoUrl?: string;
    characterOrientation?: "image" | "video";
    audioUrl?: string;
  } = {}
): Promise<{ taskId: string }> {
  return apiFetch("/generate/video", { method: "POST", body: JSON.stringify({ prompt, modelKey, ...opts }) });
}

// Uploads a reference image or a motion-reference video and returns a real,
// publicly-fetchable URL — needed for Motion Control, since kie.ai fetches
// the file itself rather than accepting it inline.
export async function uploadMedia(file: File): Promise<{ url: string }> {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/generate/media-upload`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    // A non-JSON error body (e.g. the server's body-size limit rejecting
    // a too-large file before the route handler runs) used to fall back
    // to a bare "Upload failed" with no way to tell what actually went
    // wrong — surface the status so it's at least actionable.
    if (data?.error) throw new Error(data.error);
    if (res.status === 413) throw new Error("That file is too large to upload.");
    throw new Error(`Upload failed (${res.status})`);
  }
  return res.json();
}

export interface MediaElement {
  id: string;
  name: string;
  description?: string | null;
  imageUrls: string[];
  createdAt: string;
}

export async function listMediaElements(): Promise<MediaElement[]> {
  return apiFetch("/generate/elements");
}

export async function saveMediaElement(name: string, imageUrls: string[], description?: string): Promise<MediaElement> {
  return apiFetch("/generate/elements", { method: "POST", body: JSON.stringify({ name, description, imageUrls }) });
}

export async function deleteMediaElement(id: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/generate/elements/${id}`, { method: "DELETE" });
}

export async function startUpscale(imageUrl: string, factor: number = 2): Promise<{ taskId: string }> {
  return apiFetch("/generate/upscale", { method: "POST", body: JSON.stringify({ imageUrl, factor }) });
}

export async function checkMediaGeneration(
  taskId: string
): Promise<{ status: "PENDING" | "COMPLETE" | "FAILED"; resultUrls?: string[]; error?: string }> {
  return apiFetch(`/generate/${taskId}`);
}

export async function myGenerationHistory(): Promise<MediaGeneration[]> {
  return apiFetch("/generate/history/mine");
}

export async function deleteGeneration(taskId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/generate/${taskId}`, { method: "DELETE" });
}

export interface LibraryTrack {
  id: string;
  generationId: string;
  title: string;
  style: string | null;
  instrumental: boolean;
  audioUrl: string;
  coverUrl?: string;
  durationSeconds?: number;
  createdAt: string;
}

export async function musicLibrary(opts: { genre?: string; search?: string } = {}): Promise<{ tracks: LibraryTrack[] }> {
  const params = new URLSearchParams();
  if (opts.genre) params.set("genre", opts.genre);
  if (opts.search) params.set("search", opts.search);
  const qs = params.toString();
  return apiFetch(`/music/library${qs ? `?${qs}` : ""}`);
}

export async function musicLibraryGenres(): Promise<{ genres: string[] }> {
  return apiFetch("/music/library/genres");
}

// A plain `<a href=externalUrl download>` silently fails for cross-origin
// audio (the browser just opens/streams it instead of saving it) — the
// download attribute only works reliably for same-origin or blob: URLs.
// So we fetch the file through our own authenticated backend proxy
// (which sets Content-Disposition itself), turn the response into a blob,
// and trigger the save-as from that same-origin blob: URL instead.
export async function downloadMusicTrack(track: { audioUrl: string; title?: string }) {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const params = new URLSearchParams({ url: track.audioUrl, title: track.title || "track" });
  const res = await fetch(`${API_URL}/music/download?${params.toString()}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Download failed.");
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = `${track.title || "track"}.mp3`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// ---- Support chat ----
// Built-in "how do I use this platform" help chat. Stateless like
// Playground — the client keeps the short back-and-forth in memory and
// resends it each time. Runs on this deployment's own local Ollama, no
// external API involved.
export async function streamSupportChat(
  messages: { role: "user" | "assistant"; content: string }[],
  onToken: (token: string) => void,
  opts: { signal?: AbortSignal } = {}
) {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const res = await fetch(`${API_URL}/support/chat`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Support chat failed to start");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const json = JSON.parse(part.slice(6));
      if (json.token) onToken(json.token);
      if (json.error) throw new Error(json.error);
    }
  }
}

// ---- Playground ----
// Standalone streaming — nothing is persisted server-side. Same SSE shape
// as streamMessage so the two share the parsing logic conceptually.
export async function streamPlayground(
  input: {
    model: string;
    systemPrompt?: string;
    messages: { role: "user" | "assistant" | "system"; content: string }[];
    temperature?: number;
    top_p?: number;
    num_ctx?: number;
  },
  onToken: (token: string) => void,
  opts: { signal?: AbortSignal } = {}
) {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const res = await fetch(`${API_URL}/playground/stream`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Stream failed to start");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const json = JSON.parse(part.slice(6));
      if (json.token) onToken(json.token);
      if (json.error) throw new Error(json.error);
    }
  }
}

// Streams tokens via SSE. `onToken` fires per chunk; pass an AbortController
// signal to support the "Stop generating" button.
export interface ToolEvent {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface ThinkingStep {
  type: string;
  label: string;
  status: "start" | "done" | "error";
  detail?: string;
  at: string;
}

export async function streamMessage(
  chatId: string,
  content: string,
  onToken: (token: string) => void,
  opts: {
    regenerate?: boolean;
    continueGeneration?: boolean;
    webSearch?: boolean;
    images?: string[];
    // Snapshot of chat-attached docs that are being "sent" with this
    // message (i.e. still unsent in the composer) — persisted on the
    // USER message so a page reload can tell they're already shown on a
    // bubble instead of putting them back in the composer's chip row.
    documents?: { id: string; filename: string; status?: string }[];
    location?: { lat: number; lon: number };
    signal?: AbortSignal;
    onTool?: (event: ToolEvent) => void;
    onMeta?: (meta: { userMessageId: string | null; assistantMessageId: string | null }) => void;
    onUsage?: (usage: { promptTokens?: number | null; completionTokens?: number | null }) => void;
    // Fired for every RAG/websearch/tool action the backend takes while
    // producing this reply, in order — see the "Denken..." block in ChatWindow.
    onStep?: (step: ThinkingStep) => void;
    // Fired per chunk of the model's own chain-of-thought (only present
    // for reasoning-capable models like deepseek-r1/qwq/gpt-oss).
    onReasoning?: (token: string) => void;
  } = {}
) {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const res = await fetch(`${API_URL}/chats/${chatId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      content,
      regenerate: opts.regenerate,
      continueGeneration: opts.continueGeneration,
      webSearch: opts.webSearch,
      images: opts.images,
      documents: opts.documents,
      location: opts.location,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || "Stream failed to start") as Error & { status?: number; resetAt?: string | null };
    err.status = res.status;
    err.resetAt = body.resetAt ?? null;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Watchdog: if the model/provider connection silently wedges (no error,
  // no more bytes — seen with some local models mid-generation on a long
  // file), reader.read() below just awaits forever and the UI is stuck on
  // "Stop generating" with no way out. Race every read against a silence
  // timeout so a truly stalled stream surfaces as a normal, recoverable
  // error instead of hanging indefinitely. Reset on every chunk received,
  // so this only fires on actual silence, not on a slow-but-alive stream.
  const STALL_TIMEOUT_MS = 60_000;
  async function readWithTimeout() {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("De verbinding met het model reageert niet meer. Probeer het opnieuw.")),
        STALL_TIMEOUT_MS
      );
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  while (true) {
    let done: boolean, value: Uint8Array | undefined;
    try {
      ({ done, value } = await readWithTimeout());
    } catch (err) {
      // Stalled — stop waiting and cancel the underlying read so the
      // connection doesn't linger. Whatever content already streamed in
      // via onToken stays on screen (see ChatWindow's catch handler).
      reader.cancel().catch(() => {});
      throw err;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const json = JSON.parse(part.slice(6));
      if (json.meta) opts.onMeta?.(json.meta);
      if (json.tool) opts.onTool?.(json.tool as ToolEvent);
      if (json.step) opts.onStep?.(json.step as ThinkingStep);
      if (json.reasoning) opts.onReasoning?.(json.reasoning);
      if (json.token) onToken(json.token);
      if (json.usage) opts.onUsage?.(json.usage);
      if (json.error) throw new Error(json.error);
    }
  }
}

// EventSource can't set an Authorization header, so streamed GET endpoints
// (channel live updates) accept the JWT as ?token= instead — see
// requireAuth's query-string fallback in backend/src/lib/jwt.ts. Only used
// for GET/SSE; every other request keeps using the Bearer header above.
export function authedEventSource(path: string): EventSource {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_URL}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ""}`;
  // withCredentials so the shared session cookie is sent even without a
  // localStorage token (e.g. first visit to a different visiyon.com
  // subdomain than the one you logged in on) — requireAuth falls back to
  // it server-side.
  return new EventSource(url, { withCredentials: true });
}

// ---- Pipes / Filters / Actions (admin "Functions") ----
export const listFilters = () => apiFetch("/filters");
export const createFilter = (data: any) => apiFetch("/filters", { method: "POST", body: JSON.stringify(data) });
export const updateFilter = (id: string, data: any) => apiFetch(`/filters/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteFilter = (id: string) => apiFetch(`/filters/${id}`, { method: "DELETE" });

export const listPipes = () => apiFetch("/pipes");
export const createPipe = (data: any) => apiFetch("/pipes", { method: "POST", body: JSON.stringify(data) });
export const updatePipe = (id: string, data: any) => apiFetch(`/pipes/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deletePipe = (id: string) => apiFetch(`/pipes/${id}`, { method: "DELETE" });

export const listActions = () => apiFetch("/actions");
export const listAvailableActions = () => apiFetch("/actions/available");
export const createAction = (data: any) => apiFetch("/actions", { method: "POST", body: JSON.stringify(data) });
export const updateAction = (id: string, data: any) => apiFetch(`/actions/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteAction = (id: string) => apiFetch(`/actions/${id}`, { method: "DELETE" });
export const runAction = (actionId: string, content: string) =>
  apiFetch(`/actions/${actionId}/run`, { method: "POST", body: JSON.stringify({ content }) });

// ---- MCP servers ----
export const listMcpServers = () => apiFetch("/mcp/servers");
export const createMcpServer = (data: any) => apiFetch("/mcp/servers", { method: "POST", body: JSON.stringify(data) });
export const deleteMcpServer = (id: string) => apiFetch(`/mcp/servers/${id}`, { method: "DELETE" });
export const syncMcpServer = (id: string) => apiFetch(`/mcp/servers/${id}/sync`, { method: "POST" });

// ---- Channels ----
export const listChannels = () => apiFetch("/channels");
export const createChannel = (data: any) => apiFetch("/channels", { method: "POST", body: JSON.stringify(data) });
export const joinChannel = (id: string) => apiFetch(`/channels/${id}/join`, { method: "POST" });
export const leaveChannel = (id: string) => apiFetch(`/channels/${id}/leave`, { method: "POST" });
export const listChannelMessages = (id: string) => apiFetch(`/channels/${id}/messages`);
export const postChannelMessage = (id: string, content: string) =>
  apiFetch(`/channels/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) });
export const streamChannel = (id: string) => authedEventSource(`/channels/${id}/stream`);

// ---- Automations (recurring background agents, 24/7) ----
export interface Automation {
  id: string;
  name: string;
  prompt: string;
  model: string;
  intervalMinutes: number;
  enabled: boolean;
  chatId: string | null;
  lastRunAt: string | null;
  nextRunAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  status: "SUCCESS" | "FAILED";
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function listAutomations(): Promise<Automation[]> {
  const data = await apiFetch("/automations");
  return data.automations;
}

export async function createAutomation(input: {
  name: string;
  prompt: string;
  model: string;
  intervalMinutes: number;
  enabled?: boolean;
}): Promise<Automation> {
  const data = await apiFetch("/automations", { method: "POST", body: JSON.stringify(input) });
  return data.automation;
}

export async function updateAutomation(
  automationId: string,
  input: Partial<{ name: string; prompt: string; model: string; intervalMinutes: number; enabled: boolean }>
): Promise<Automation> {
  const data = await apiFetch(`/automations/${automationId}`, { method: "PATCH", body: JSON.stringify(input) });
  return data.automation;
}

export async function deleteAutomation(automationId: string) {
  return apiFetch(`/automations/${automationId}`, { method: "DELETE" });
}

export async function runAutomationNow(automationId: string) {
  return apiFetch(`/automations/${automationId}/run`, { method: "POST" });
}

export async function listAutomationRuns(automationId: string): Promise<AutomationRun[]> {
  const data = await apiFetch(`/automations/${automationId}/runs`);
  return data.runs;
}

// ---- Notes ----
export const listNotes = () => apiFetch("/notes");
export const createNote = (data: any = {}) => apiFetch("/notes", { method: "POST", body: JSON.stringify(data) });
export const updateNote = (id: string, data: any) => apiFetch(`/notes/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteNote = (id: string) => apiFetch(`/notes/${id}`, { method: "DELETE" });

// ---- Arena ----
export const arenaBattle = (prompt: string, modelA: string, modelB: string) =>
  apiFetch("/arena/battle", { method: "POST", body: JSON.stringify({ prompt, modelA, modelB }) });
export const arenaVote = (battle: { prompt: string; modelA: string; modelB: string; responseA: string; responseB: string }, winner: "A" | "B" | "TIE" | "BOTH_BAD") =>
  apiFetch("/arena/vote", { method: "POST", body: JSON.stringify({ ...battle, winner }) });
export const arenaLeaderboard = () => apiFetch("/arena/leaderboard");

// ---- AI Providers (open source "bring your own API key") ----
// Backed by routes/providers.ts + lib/providers.ts on the backend —
// lets an admin plug in OpenAI, Anthropic/Claude, or any OpenAI-compatible
// endpoint (Groq, Mistral, OpenRouter, Azure OpenAI, a local vLLM/LM
// Studio server, ...). Configured models show up in the model picker
// prefixed "provider:<id>:<model>".
export type AiProviderType = "openai" | "anthropic" | "openai_compatible";

export interface AiProvider {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string | null;
  // Masked preview only ("sk-a••••••ab12") — the real key never comes
  // back from the API once saved.
  apiKeyPreview: string;
  models: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestError: string | null;
}

export async function listProviders(): Promise<{ providers: AiProvider[] }> {
  return apiFetch("/admin/providers");
}

export async function createProvider(data: {
  name: string;
  type: AiProviderType;
  baseUrl?: string | null;
  apiKey: string;
  models?: string[];
  enabled?: boolean;
}): Promise<{ provider: AiProvider }> {
  return apiFetch("/admin/providers", { method: "POST", body: JSON.stringify(data) });
}

export async function updateProvider(
  id: string,
  patch: {
    name?: string;
    type?: AiProviderType;
    baseUrl?: string | null;
    // Omit to keep the currently-stored key.
    apiKey?: string;
    models?: string[];
    enabled?: boolean;
  }
): Promise<{ provider: AiProvider }> {
  return apiFetch(`/admin/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteProvider(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Verifies the stored key works, and — for OpenAI/compatible providers —
// auto-fills `models` from the provider's own /models endpoint if none
// are set yet.
export async function testProvider(
  id: string
): Promise<{ ok: boolean; error?: string; note?: string; provider: AiProvider }> {
  return apiFetch(`/admin/providers/${encodeURIComponent(id)}/test`, { method: "POST" });
}

// ---- SSO/OIDC login providers (Admin > Settings > Login providers) ----
// Backed by routes/sso-providers.ts + lib/oidc.ts on the backend. Each
// row here is its own "Continue with <providerName>" button on the login
// page — separate from, and in addition to, the original single-provider
// config still on Admin > Settings > Login itself (kept for backward
// compatibility; deployments that only ever configured that one still
// work exactly as before). Add a row here for every SSO provider beyond
// the first one, e.g. Google alongside an already-configured Microsoft.
export interface SsoProviderConfig {
  id: string;
  providerName: string;
  issuerUrl: string;
  clientId: string;
  // Masked preview only ("••••ab12") — the real secret never comes back
  // from the API once saved.
  clientSecretPreview: string;
  scopes: string | null;
  redirectUri: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listSsoProviderConfigs(): Promise<{ providers: SsoProviderConfig[] }> {
  return apiFetch("/admin/sso-providers");
}

export async function createSsoProviderConfig(data: {
  providerName: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string | null;
  redirectUri?: string | null;
  enabled?: boolean;
}): Promise<{ provider: SsoProviderConfig }> {
  return apiFetch("/admin/sso-providers", { method: "POST", body: JSON.stringify(data) });
}

export async function updateSsoProviderConfig(
  id: string,
  patch: {
    providerName?: string;
    issuerUrl?: string;
    clientId?: string;
    // Omit to keep the currently-stored secret.
    clientSecret?: string;
    scopes?: string | null;
    redirectUri?: string | null;
    enabled?: boolean;
  }
): Promise<{ provider: SsoProviderConfig }> {
  return apiFetch(`/admin/sso-providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteSsoProviderConfig(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/sso-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- Meta-models ("Jean") ----
// Backed by routes/meta-models.ts + lib/meta-model.ts on the backend. A
// meta-model bundles several real candidates (a local Ollama model on
// your own GPU, or an external AiProvider model) behind one name. Every
// message races the candidates for the first token; the fastest wins and
// the rest are aborted, and a candidate that errors or never responds is
// simply skipped in favor of the next one — all invisible to the end
// user, who just sees "Jean" answer. Shows up in the model picker
// prefixed "meta:<slug>".
export type MetaModelCandidateKind = "ollama" | "provider";

export interface MetaModelCandidate {
  id: string;
  order: number;
  enabled: boolean;
  kind: MetaModelCandidateKind;
  ollamaModel: string | null;
  providerId: string | null;
  providerName: string | null;
  providerModel: string | null;
}

export interface MetaModel {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  // ms between one candidate joining the race and the next — see
  // lib/meta-model.ts.
  hedgeDelayMs: number;
  createdAt: string;
  updatedAt: string;
  candidates: MetaModelCandidate[];
}

export interface MetaModelCandidateInput {
  order: number;
  enabled?: boolean;
  kind: MetaModelCandidateKind;
  ollamaModel?: string;
  providerId?: string;
  providerModel?: string;
}

export async function listMetaModels(): Promise<{ metaModels: MetaModel[] }> {
  return apiFetch("/admin/meta-models");
}

export async function createMetaModel(data: {
  slug: string;
  displayName: string;
  description?: string | null;
  enabled?: boolean;
  hedgeDelayMs?: number;
  candidates: MetaModelCandidateInput[];
}): Promise<{ metaModel: MetaModel }> {
  return apiFetch("/admin/meta-models", { method: "POST", body: JSON.stringify(data) });
}

export async function updateMetaModel(
  id: string,
  patch: {
    slug?: string;
    displayName?: string;
    description?: string | null;
    enabled?: boolean;
    hedgeDelayMs?: number;
    candidates?: MetaModelCandidateInput[];
  }
): Promise<{ metaModel: MetaModel }> {
  return apiFetch(`/admin/meta-models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteMetaModel(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/meta-models/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- Studio (in-browser code editor -> subdomain hosting) ----
export type StudioRole = "OWNER" | "EDITOR" | "VIEWER";

export interface StudioProjectUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

export interface StudioProjectMember {
  id: string;
  projectId: string;
  userId: string | null;
  email: string;
  role: "EDITOR" | "VIEWER";
  createdAt: string;
  user: StudioProjectUser | null;
}

export interface StudioProject {
  id: string;
  name: string;
  files: Record<string, string>;
  subdomain: string | null;
  publishedFiles: Record<string, string> | null;
  publishedAt: string | null;
  updatedAt: string;
  user: StudioProjectUser;
  members: StudioProjectMember[];
  role?: StudioRole;
}

// Every project the current user can open: ones they own, plus ones
// shared with them by other users. Powers the "Projects" list in the
// sidebar.
export async function listStudioProjects(): Promise<{ projects: StudioProject[] }> {
  return apiFetch("/studio/projects");
}

export async function getStudioProject(projectId?: string): Promise<{ project: StudioProject; role: StudioRole }> {
  return apiFetch(projectId ? `/studio/project/${encodeURIComponent(projectId)}` : "/studio/project");
}

// Creates a brand-new project owned by the current user (separate from
// their existing ones) — powers "New project" on the projects table.
export async function createStudioProject(name?: string): Promise<{ project: StudioProject; role: StudioRole }> {
  return apiFetch("/studio/projects", {
    method: "POST",
    body: JSON.stringify(name ? { name } : {}),
  });
}

// Owner-only — permanently deletes a project (and its published site, if
// any). Collaborators use removeStudioMember on themselves to leave
// instead.
export async function deleteStudioProject(projectId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export async function saveStudioFiles(
  projectId: string,
  files: Record<string, string>
): Promise<{ project: StudioProject }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/files`, {
    method: "PUT",
    body: JSON.stringify({ files }),
  });
}

export async function renameStudioProject(projectId: string, name: string): Promise<{ project: StudioProject }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/name`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function setStudioSubdomain(
  projectId: string,
  subdomain: string
): Promise<{ project: StudioProject }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/subdomain`, {
    method: "PATCH",
    body: JSON.stringify({ subdomain }),
  });
}

export async function publishStudioProject(projectId: string): Promise<{ project: StudioProject; url: string }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/publish`, { method: "POST" });
}

export async function unpublishStudioProject(projectId: string): Promise<{ project: StudioProject }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/unpublish`, { method: "POST" });
}

// ---- Studio collaborators / sharing ----

export async function listStudioMembers(
  projectId: string
): Promise<{ members: StudioProjectMember[]; owner: StudioProjectUser }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/members`);
}

// Invites a user to collaborate on a project by email. If they don't have
// an account yet, the share is kept pending and applied automatically the
// moment they register with that email.
export async function inviteStudioMember(
  projectId: string,
  email: string,
  role: "EDITOR" | "VIEWER" = "EDITOR"
): Promise<{ member: StudioProjectMember; pending: boolean }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function updateStudioMemberRole(
  projectId: string,
  memberId: string,
  role: "EDITOR" | "VIEWER"
): Promise<{ member: StudioProjectMember }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeStudioMember(projectId: string, memberId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/studio/project/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
  });
}

// ---- Server connection (let the AI read/write files on your own server) ----
export interface ServerConnectionSummary {
  id: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  baseDir: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  updatedAt: string;
}

export interface ServerConnectionInput {
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  baseDir?: string | null;
}

export async function getServerConnection(): Promise<{ connection: ServerConnectionSummary | null }> {
  return apiFetch("/server-connection");
}

export async function saveServerConnection(input: ServerConnectionInput): Promise<{ connection: ServerConnectionSummary }> {
  return apiFetch("/server-connection", { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteServerConnection(): Promise<{ ok: boolean }> {
  return apiFetch("/server-connection", { method: "DELETE" });
}

export async function testServerConnectionApi(): Promise<{ ok: boolean; error?: string }> {
  return apiFetch("/server-connection/test", { method: "POST" });
}

export interface RemoteFileEntry {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  modifyTime: number;
}

export async function browseServerFiles(path: string): Promise<{ path: string; entries: RemoteFileEntry[] }> {
  return apiFetch(`/server-connection/browse?path=${encodeURIComponent(path)}`);
}

// Drops a file the AI already generated (create_file tool) straight onto
// the connected server — see MarkdownMessage's draggable file chip, which
// is what supplies `token`/`filename` via the browser's drag-and-drop data.
export async function uploadGeneratedFileToServer(
  token: string,
  remoteDir: string
): Promise<{ ok: boolean; message: string; filename: string }> {
  return apiFetch("/server-connection/upload-from-generated", {
    method: "POST",
    body: JSON.stringify({ token, remoteDir }),
  });
}

// ---- Model training (Admin > Training) ----

export interface TrainingDataset {
  id: string;
  name: string;
  filename: string;
  sizeBytes: number;
  status: "PENDING" | "VALIDATING" | "READY" | "FAILED";
  exampleCount: number | null;
  error?: string | null;
  createdAt: string;
}

export interface TrainingBaseModel {
  tag: string;
  label: string;
  family: string;
  paramsB: number;
  hfRepo: string;
  installed: boolean;
}

export interface TrainingJob {
  id: string;
  name: string;
  baseModelTag: string;
  baseModelHfRepo: string;
  datasetId: string;
  dataset?: { name: string };
  epochs: number;
  learningRate: number;
  loraR: number;
  loraAlpha: number;
  status:
    | "QUEUED"
    | "PREPARING"
    | "TRAINING"
    | "CONVERTING"
    | "REGISTERING"
    | "COMPLETE"
    | "FAILED"
    | "CANCELLED";
  log: string;
  progressPercent: number;
  error?: string | null;
  resultModelTag?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export async function adminListTrainingBaseModels(): Promise<{ models: TrainingBaseModel[] }> {
  return apiFetch("/admin/training/base-models");
}

export async function adminListTrainingDatasets(): Promise<{ datasets: TrainingDataset[] }> {
  return apiFetch("/admin/training/datasets");
}

export async function adminUploadTrainingDataset(file: File, name?: string): Promise<TrainingDataset> {
  const token = typeof window !== "undefined" ? localStorage.getItem("visiyon_token") : null;
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);
  const res = await fetch(`${API_URL}/admin/training/datasets`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    throw new Error(await uploadErrorMessage(res));
  }
  const data = await res.json();
  return data.dataset;
}

export async function adminDeleteTrainingDataset(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/training/datasets/${id}`, { method: "DELETE" });
}

export async function adminListTrainingJobs(): Promise<{ jobs: TrainingJob[] }> {
  return apiFetch("/admin/training/jobs");
}

export async function adminGetTrainingJob(id: string): Promise<{ job: TrainingJob }> {
  return apiFetch(`/admin/training/jobs/${id}`);
}

export interface CreateTrainingJobInput {
  name: string;
  baseModelTag: string;
  datasetId: string;
  epochs?: number;
  learningRate?: number;
  loraR?: number;
  loraAlpha?: number;
}

export async function adminCreateTrainingJob(body: CreateTrainingJobInput): Promise<{ job: TrainingJob }> {
  return apiFetch("/admin/training/jobs", { method: "POST", body: JSON.stringify(body) });
}

export async function adminCancelTrainingJob(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/training/jobs/${id}/cancel`, { method: "POST" });
}

export async function adminDeleteTrainingJob(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/training/jobs/${id}`, { method: "DELETE" });
}

// ---- Notifications (in-app bell, synced with the account server-side —
// see lib/notificationPref.ts for the separate browser-permission desktop
// popup toggle, which is unrelated). ----
export type NotificationType = "GENERATION_COMPLETE" | "GENERATION_FAILED";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  sourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export async function getUnreadNotificationCount(): Promise<{ count: number }> {
  return apiFetch("/notifications/unread-count");
}

export async function listNotifications(): Promise<{ notifications: AppNotification[] }> {
  return apiFetch("/notifications");
}

export async function markNotificationRead(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/notifications/${id}/read`, { method: "POST" });
}

export async function markAllNotificationsRead(): Promise<{ ok: boolean }> {
  return apiFetch("/notifications/read-all", { method: "POST" });
}
