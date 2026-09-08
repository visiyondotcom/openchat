"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMe } from "@/lib/api";

// Module-level cache: once a session has been verified in this tab, every
// subsequent useRequireAuth() mount (e.g. clicking between chats — each
// /chat/[id] navigation remounts the page and re-runs this hook) can skip
// the network round trip and the ready=false flash that made switching
// chats feel like it needed several clicks before anything happened.
let cachedVerifiedUser: any = null;

// Every mounted useRequireAuth() consumer (Navbar/UserMenu/Sidebar/rail
// avatars, all across different pages) needs to see profile changes (e.g.
// a new avatar uploaded in /settings) immediately, not just after a full
// page reload. Plain module state doesn't re-render anyone by itself, so
// keep a small subscriber list and notify it on every update — this is
// the single source of truth the rest of the app should read from
// instead of caching its own copy of the logged-in user.
const listeners = new Set<(u: any) => void>();

function setCachedUser(u: any) {
  cachedVerifiedUser = u;
  listeners.forEach((fn) => fn(u));
}

/**
 * Call this anywhere the logged-in user's own profile changes (avatar
 * upload/remove, display name edit, etc.) so every other mounted
 * component using useRequireAuth() picks up the change instantly instead
 * of showing stale data until the page is refreshed.
 */
export function updateCachedUser(patch: Partial<any>) {
  if (!cachedVerifiedUser) return;
  setCachedUser({ ...cachedVerifiedUser, ...patch });
}

/**
 * Guards a client page behind login. Every protected route (chat, admin,
 * settings, notes, arena, channels, playground, ...) previously rendered
 * immediately with no check at all — visiting the URL directly (even in a
 * fresh, logged-out browser) landed straight on the page, including
 * /admin. This redirects to /login whenever there's no valid session, and
 * returns `ready=false` until the check has resolved so callers can avoid
 * flashing protected content first.
 */
export function useRequireAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(cachedVerifiedUser !== null);
  const [user, setUser] = useState<any>(cachedVerifiedUser);

  useEffect(() => {
    listeners.add(setUser);
    return () => {
      listeners.delete(setUser);
    };
  }, []);

  useEffect(() => {
    if (cachedVerifiedUser) return;
    let cancelled = false;
    // Don't gate on localStorage's "visiyon_token" here: if you logged in
    // on a different visiyon.com subdomain, this tab's localStorage is
    // empty even though the shared session cookie still proves you're
    // logged in. Always ask the backend — apiFetch sends the cookie
    // automatically — and only bounce to /login if that actually fails.
    getMe()
      .then((u) => {
        if (!cancelled) {
          setCachedUser(u);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return { ready, user };
}

/**
 * Same as useRequireAuth, but also requires the ADMIN role.
 *
 * This used to call getMe() fresh on every mount instead of sharing
 * cachedVerifiedUser like useRequireAuth does. Every single click between
 * /admin/* pages remounts the page and re-ran the check from scratch, so
 * each admin page briefly had no verified user in hand — a slow response,
 * a hiccuping request, or just normal network jitter during that window
 * was read as "not an admin" and bounced straight to "/", which is why
 * admin subpages looked like they didn't have their own page and kept
 * dumping back to the front page instead. Sharing the cache means the
 * check only actually hits the network once per tab.
 */
export function useRequireAdmin() {
  const router = useRouter();
  const [ready, setReady] = useState(cachedVerifiedUser?.role === "ADMIN");

  useEffect(() => {
    if (cachedVerifiedUser) {
      if (cachedVerifiedUser.role !== "ADMIN") router.replace("/");
      return;
    }
    let cancelled = false;
    getMe()
      .then((user) => {
        if (cancelled) return;
        cachedVerifiedUser = user;
        if (user?.role !== "ADMIN") {
          router.replace("/");
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return ready;
}
