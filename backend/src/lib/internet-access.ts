// Gates the "browse_web" builtin tool (see lib/tools.ts) — managed from
// Admin > Settings > Web search > "Enable full internet access". Off by
// default (unlike web search, which only ever talks to the bundled
// self-hosted SearXNG instance), this lets the model fetch arbitrary public
// URLs, so an admin has to opt in explicitly. Same "DB wins, cached
// in-memory" pattern as lib/websearch.ts / lib/images.ts — admin.ts calls
// invalidateInternetAccessConfigCache() right after a save so the toggle
// takes effect immediately, no restart needed.

import type { PrismaClient } from "@prisma/client";

const CACHE_TTL_MS = 30_000;
let cache: { value: boolean; expiresAt: number } | null = null;

export function invalidateInternetAccessConfigCache(): void {
  cache = null;
}

export async function internetAccessEnabled(prisma?: PrismaClient): Promise<boolean> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let enabled = false;
  if (prisma) {
    try {
      const row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { internetAccessEnabled: true },
      });
      enabled = Boolean(row?.internetAccessEnabled);
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — default to
      // off rather than failing every browse_web call.
      enabled = false;
    }
  }

  cache = { value: enabled, expiresAt: Date.now() + CACHE_TTL_MS };
  return enabled;
}
