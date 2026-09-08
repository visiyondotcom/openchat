// Self-update system for self-hosted deployments.
//
// How it works end to end:
//   1. This backend checks GitHub Releases for the repo configured in
//      UPDATE_REPO ("owner/name") and compares the latest tag against the
//      running APP_VERSION (see admin.ts's GET /admin/version). Result is
//      cached in Redis for CHECK_CACHE_TTL_SEC so the admin panel polling
//      doesn't hammer GitHub's API.
//   2. When an admin clicks "Update now", this calls the small `updater`
//      sidecar container (see /updater in the repo root) over the internal
//      docker network. That container is the only thing with the docker
//      socket + repo checkout mounted into it, so this backend never needs
//      elevated access itself.
//   3. The updater runs `git pull` + `docker compose up -d --build` on the
//      host's compose project and streams its own status; this file just
//      proxies that status back to the admin UI, and keeps a short-lived
//      "an update is currently running" flag in Redis so two admins
//      clicking at once don't kick off two updates.
//
// None of this is wired up if UPDATE_REPO isn't set — existing deployments
// that don't want this feature (e.g. people running from a private fork)
// just never see the "Updates" nav item light up.

import type { FastifyInstance } from "fastify";

const UPDATE_REPO = process.env.UPDATE_REPO || ""; // e.g. "visiyon-ai/visiyon-studio"
const UPDATER_URL = process.env.UPDATER_URL || "http://updater:9000";
const CHECK_CACHE_TTL_SEC = 60 * 60; // 1 hour
const LOCK_KEY = "updates:lock";
const LOCK_TTL_SEC = 60 * 30; // safety net in case the updater dies mid-run
const CACHE_KEY = "updates:latest_check";

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

function getCurrentVersion(): string {
  return process.env.APP_VERSION || "2.0.0";
}

// Basic semver compare, good enough for "1.4.0" > "1.3.2" style tags.
// Falls back to string inequality for anything that isn't plain semver
// (e.g. a "nightly" or hash-based tag) so we still surface *something*
// changed rather than silently reporting no update.
function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
  const b = current.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return latest !== current;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

export async function checkForUpdate(app: FastifyInstance, force = false): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();

  if (!UPDATE_REPO) {
    return {
      enabled: false,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
      publishedAt: null,
      checkedAt: new Date().toISOString(),
    };
  }

  if (!force) {
    const cached = await app.redis.get(CACHE_KEY);
    if (cached) return JSON.parse(cached) as UpdateCheckResult;
  }

  let result: UpdateCheckResult;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "visiyon-studio-updater" },
    });
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
    const data: any = await res.json();
    const latestVersion = String(data.tag_name || "").replace(/^v/i, "");
    result = {
      enabled: true,
      currentVersion,
      latestVersion,
      updateAvailable: isNewer(latestVersion, currentVersion),
      releaseUrl: data.html_url || null,
      releaseNotes: typeof data.body === "string" ? data.body.slice(0, 4000) : null,
      publishedAt: data.published_at || null,
      checkedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    // Network hiccup / rate limit — report "enabled, but unknown" rather
    // than crashing the admin panel. The UI treats latestVersion: null as
    // "couldn't check right now".
    result = {
      enabled: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
      publishedAt: null,
      checkedAt: new Date().toISOString(),
    };
  }

  await app.redis.set(CACHE_KEY, JSON.stringify(result), "EX", CHECK_CACHE_TTL_SEC);
  return result;
}

export type UpdateRunState = "idle" | "running" | "success" | "failed";

export interface UpdateStatus {
  state: UpdateRunState;
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// Talks to the updater sidecar. If it's not deployed/reachable (e.g. this
// compose stack was started without the `updater` service) we report that
// clearly instead of a raw connection-refused error.
export async function getUpdateStatus(): Promise<UpdateStatus> {
  try {
    const res = await fetch(`${UPDATER_URL}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`updater responded ${res.status}`);
    return (await res.json()) as UpdateStatus;
  } catch {
    return { state: "idle", log: "Updater service is not reachable.", startedAt: null, finishedAt: null };
  }
}

export async function triggerUpdate(app: FastifyInstance): Promise<{ ok: boolean; message: string }> {
  const lock = await app.redis.set(LOCK_KEY, "1", "EX", LOCK_TTL_SEC, "NX");
  if (!lock) {
    return { ok: false, message: "An update is already running." };
  }

  try {
    const res = await fetch(`${UPDATER_URL}/run`, { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      await app.redis.del(LOCK_KEY);
      return { ok: false, message: `Updater refused to start (${res.status}).` };
    }
    // Lock is released once the frontend sees state !== "running" via
    // status polling calling releaseLockIfFinished() below, so a stuck
    // updater doesn't block retries forever either (LOCK_TTL_SEC).
    return { ok: true, message: "Update started." };
  } catch (err: any) {
    await app.redis.del(LOCK_KEY);
    return { ok: false, message: "Could not reach the updater service. Is the `updater` container running?" };
  }
}

// Called whenever the admin panel polls status — clears the lock as soon
// as the run finishes so the button re-enables without waiting for TTL.
export async function releaseLockIfFinished(app: FastifyInstance, status: UpdateStatus): Promise<void> {
  if (status.state !== "running") {
    await app.redis.del(LOCK_KEY);
  }
}

export function updatesEnabled(): boolean {
  return Boolean(UPDATE_REPO);
}
