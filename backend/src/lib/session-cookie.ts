import type { FastifyReply } from "fastify";

// Same token that used to only ever live in the frontend's localStorage
// (which is why logging in on ai.visiyon.com didn't carry over to
// a.visiyon.com — localStorage is isolated per exact hostname). Setting it
// as a cookie scoped to COOKIE_DOMAIN (e.g. ".visiyon.com") instead makes
// the browser attach it to every request on every subdomain automatically,
// so requireAuth() below recognizes the session everywhere.
export const SESSION_COOKIE_NAME = "visiyon_session";

// 7 days, matching the default JWT_EXPIRES_IN — if that env var is
// overridden, the cookie will simply expire earlier than the JWT itself,
// which just means an earlier (safe) re-login rather than a security gap.
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
  });
}
