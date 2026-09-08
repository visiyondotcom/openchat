import type { PrismaClient } from "@prisma/client";

// ---- Upload size limits (Admin > Settings > Uploads) ----
// Same "DB wins, falls back to a default" pattern as lib/quota.ts /
// lib/billing.ts: an admin can override any of these from
// Admin > Settings > Uploads (stored on the AppSettings singleton row);
// a field left empty in the DB falls back to the hardcoded default below.
// Cached in-memory for CACHE_TTL_MS; admin.ts calls
// invalidateUploadLimitsCache() right after a save so a change takes
// effect immediately.
export const DOCUMENT_MAX_UPLOAD_MB_DEFAULT = 100;
export const VOICE_MAX_UPLOAD_MB_DEFAULT = 25;
export const AVATAR_MAX_UPLOAD_MB_DEFAULT = 2;

export type UploadLimits = {
  documentMaxUploadBytes: number;
  voiceMaxUploadBytes: number;
  avatarMaxUploadBytes: number;
  documentUploadEnabled: boolean;
  imageUploadEnabled: boolean;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: UploadLimits; expiresAt: number } | null = null;

export function invalidateUploadLimitsCache(): void {
  cache = null;
}

function mbToBytes(mb: number): number {
  return mb * 1024 * 1024;
}

export async function loadUploadLimits(prisma?: PrismaClient): Promise<UploadLimits> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    documentMaxUploadMb: number | null;
    voiceMaxUploadMb: number | null;
    avatarMaxUploadMb: number | null;
    documentUploadEnabled: boolean;
    imageUploadEnabled: boolean;
  } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          documentMaxUploadMb: true,
          voiceMaxUploadMb: true,
          avatarMaxUploadMb: true,
          documentUploadEnabled: true,
          imageUploadEnabled: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to the hardcoded defaults entirely rather than failing every upload.
      row = null;
    }
  }

  const value: UploadLimits = {
    documentMaxUploadBytes: mbToBytes(row?.documentMaxUploadMb || DOCUMENT_MAX_UPLOAD_MB_DEFAULT),
    voiceMaxUploadBytes: mbToBytes(row?.voiceMaxUploadMb || VOICE_MAX_UPLOAD_MB_DEFAULT),
    avatarMaxUploadBytes: mbToBytes(row?.avatarMaxUploadMb || AVATAR_MAX_UPLOAD_MB_DEFAULT),
    // No row yet (fresh install, migration not run) = treat as enabled,
    // matching the schema default.
    documentUploadEnabled: row?.documentUploadEnabled ?? true,
    imageUploadEnabled: row?.imageUploadEnabled ?? true,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
