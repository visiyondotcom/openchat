// Reports platform activity (failed logins, rate-limit hits) to the
// self-hosted fraud-guard service so it shows up on its dashboard's SITE
// ACTIVITY panel, alongside blog and community. Observe-only: never
// awaited by callers, never used to block anything here — the real
// blocking (rate limiting, captcha, auth checks) already happened before
// this is called. Silently no-ops if fraud-guard isn't configured.
//
// Distinct from the withdrawal/purchase verdict flow in routes/billing.ts
// (which DOES await fraud-guard and can block a payout) — this is purely
// for dashboard visibility.

import type { FastifyRequest, FastifyReply } from "fastify";
import { SESSION_COOKIE_NAME } from "./session-cookie.js";

const FRAUD_GUARD_URL = (process.env.FRAUD_GUARD_URL || "").replace(/\/+$/, "");
const FRAUD_GUARD_API_KEY = process.env.FRAUD_GUARD_API_KEY || "";

function clientIp(req: FastifyRequest): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.ip || "unknown";
}

// eventType is prefixed with 'platform_' so fraud-guard's SITE ACTIVITY
// panel can tell it apart from blog/community and its own money-verdict flow.
export function reportSiteEvent(eventType: string, req: FastifyRequest, extra: Record<string, unknown> = {}) {
  if (!FRAUD_GUARD_URL || !FRAUD_GUARD_API_KEY) return;
  const identity = (req as any).user?.id || clientIp(req);
  const payload = { ip: clientIp(req), path: req.url, ...extra };
  fetch(`${FRAUD_GUARD_URL}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FRAUD_GUARD_API_KEY}` },
    body: JSON.stringify({ eventType: `platform_${eventType}`, userId: identity, payload, ts: new Date().toISOString() }),
  }).catch(() => { /* best-effort, never block the request on this */ });
}

// ---- Live visitor heartbeat (powers fraud-guard's LIVE VISITORS panel) ----
// Fires on (almost) every request so the dashboard shows real
// ai.visiyon.com traffic, tagged site: 'platform'. Best-effort identity
// check only — never throws, never blocks the request, unlike the real
// requireAuth preHandler in lib/jwt.ts.
function bestEffortUserId(req: FastifyRequest): string | null {
  try {
    const header = req.headers.authorization;
    let token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) token = (req as any).cookies?.[SESSION_COOKIE_NAME];
    if (!token || token.startsWith("vis_")) return null; // API-key traffic isn't a "visitor"
    const payload = req.server.jwt.verify(token) as any;
    return payload?.id || null;
  } catch {
    return null;
  }
}

export function reportHeartbeat(req: FastifyRequest, extra: Record<string, unknown> = {}) {
  if (!FRAUD_GUARD_URL || !FRAUD_GUARD_API_KEY) return;
  const userId = bestEffortUserId(req);
  fetch(`${FRAUD_GUARD_URL}/api/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FRAUD_GUARD_API_KEY}` },
    body: JSON.stringify({
      site: "platform",
      ip: clientIp(req),
      userId,
      type: userId ? "user" : "guest",
      page: (extra.page as string) || req.url,
      action: (extra.action as string) || "browsing",
    }),
  }).catch((err) => console.error("[fraud-guard] heartbeat failed:", err?.message));
}

// Register with `app.addHook("onRequest", heartbeatHook)` in index.ts.
// Skips static assets and its own polling routes so LIVE VISITORS reflects
// real navigation/API use, not every JS/CSS/SSE-keepalive request.
const SKIP_EXT = /\.(js|css|png|jpg|jpeg|svg|ico|woff2?|map)$/i;
export async function heartbeatHook(req: FastifyRequest, _reply: FastifyReply) {
  if (SKIP_EXT.test(req.url) || req.url.startsWith("/health")) return;
  reportHeartbeat(req);
}
