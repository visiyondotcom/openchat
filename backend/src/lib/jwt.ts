import type { FastifyRequest, FastifyReply } from "fastify";
import { SESSION_COOKIE_NAME } from "./session-cookie.js";

// Attach this as a preHandler on any route that needs a logged-in user.
// Accepts either a JWT (normal browser session) or a "vis_"-prefixed API
// key (Authorization: Bearer vis_xxx) issued via /api-keys — both end up
// setting req.user in the same shape so downstream handlers never need to
// care which one was used.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  // Browser EventSource cannot set custom headers, so SSE endpoints (chat
  // streams, channel streams) accept the JWT as a `?token=` query param
  // instead. Restricted to GET — the only method EventSource ever uses —
  // so this fallback can't be used to sneak a token into a state-changing
  // request via URL (which would also leak it into server logs/history).
  if (!token && req.method === "GET") {
    const qsToken = (req.query as Record<string, string> | undefined)?.token;
    if (qsToken) token = qsToken;
  }

  // Falls back to the shared session cookie (set on login/register/SSO,
  // scoped to COOKIE_DOMAIN) so a session started on one visiyon.com
  // subdomain is also recognized on the others, without every caller of
  // apiFetch needing to know about it.
  if (!token) {
    token = req.cookies?.[SESSION_COOKIE_NAME];
  }

  if (token?.startsWith("vis_")) {
    const apiKey = await req.server.prisma.apiKey.findUnique({
      where: { key: token },
      include: { user: true },
    });
    if (!apiKey) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    // Fire-and-forget — don't hold up the request on this bookkeeping write.
    req.server.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } }).catch(() => {});
    (req as any).user = { id: apiKey.user.id, email: apiKey.user.email, role: apiKey.user.role };
    return;
  }

  try {
    if (token) {
      // Came from ?token=; verify it directly since @fastify/jwt's
      // req.jwtVerify() only ever looks at the Authorization header.
      (req as any).user = req.server.jwt.verify(token);
    } else {
      await req.jwtVerify();
    }
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  const userId = (req as any).user?.id as string | undefined;
  if (userId) {
    // Fire-and-forget, best-effort — never block the request on this.
    req.server.prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => {});
  }
}

// Attach after requireAuth on admin-only routes.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as { role?: string };
  if (user?.role !== "ADMIN") {
    reply.code(403).send({ error: "Forbidden" });
  }
}

// Like requireAuth, but never rejects the request — just resolves
// req.user if a valid session/token/API key is present, and leaves it
// undefined otherwise. For routes like the public Explore feed that must
// work logged-out but want to know "did *this* user already like item
// X" when a session does happen to be attached.
export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) {
    token = req.cookies?.[SESSION_COOKIE_NAME];
  }

  if (token?.startsWith("vis_")) {
    const apiKey = await req.server.prisma.apiKey.findUnique({ where: { key: token }, include: { user: true } });
    if (apiKey) {
      (req as any).user = { id: apiKey.user.id, email: apiKey.user.email, role: apiKey.user.role };
    }
    return;
  }

  try {
    if (token) {
      (req as any).user = req.server.jwt.verify(token);
    } else {
      await req.jwtVerify();
    }
  } catch {
    // No valid session — that's fine here, just proceed unauthenticated.
  }
}
