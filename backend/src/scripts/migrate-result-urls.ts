// One-off backfill for generations created before persistResultUrls() (see
// lib/persist-results.ts) started re-hosting kie.ai's results automatically.
// Those older rows still point at kie.ai's temporary hosting and can 404 at
// any time — this script downloads each one exactly once and rewrites the
// row to our own durable /api/media/:token URL, same as new generations get
// today.
//
// Run from backend/:
//   BASE_DOMAIN=ai.visiyon.com npx tsx src/scripts/migrate-result-urls.ts
//
// Safe to re-run: any row whose resultUrls already point at our own host
// (BASE_DOMAIN, /api/media/ or /api/files/) is skipped, so an interrupted
// run can just be started again.
import { PrismaClient } from "@prisma/client";
import { persistResultUrls } from "../lib/persist-results.js";

const BASE_DOMAIN = process.env.BASE_DOMAIN;
if (!BASE_DOMAIN) {
  console.error("Set BASE_DOMAIN (e.g. ai.visiyon.com) before running this script.");
  process.exit(1);
}
// TS doesn't narrow the module-level BASE_DOMAIN inside the functions below
// (a closure could theoretically run after a reassignment), so capture it
// once as a definitely-string constant right after the check above.
const DOMAIN: string = BASE_DOMAIN;

function isAlreadyPersisted(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === DOMAIN && (url.includes("/api/media/") || url.includes("/api/files/"));
  } catch {
    return false;
  }
}

async function main() {
  const prisma = new PrismaClient();
  // Prisma's typed JSON filters don't accept a plain `null` for "not" —
  // simpler to just fetch every COMPLETE row and skip empty ones in the
  // loop below (the `if (!urls.length ...)` check right after).
  const rows = await prisma.mediaGeneration.findMany({
    where: { status: "COMPLETE" },
    select: { id: true, taskId: true, resultUrls: true },
  });

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const urls = (row.resultUrls as string[] | null) || [];
    if (!urls.length || urls.every(isAlreadyPersisted)) {
      skipped++;
      continue;
    }
    try {
      const newUrls = await persistResultUrls(urls, DOMAIN);
      // persistResultUrls() falls back to the original URL per-file on
      // failure, so only count it a real migration if something changed.
      if (JSON.stringify(newUrls) === JSON.stringify(urls)) {
        failed++;
        console.warn(`[skip] ${row.taskId}: kie.ai URL(s) could not be downloaded (already expired?)`);
        continue;
      }
      await prisma.mediaGeneration.update({ where: { id: row.id }, data: { resultUrls: newUrls as any } });
      migrated++;
      console.log(`[ok] ${row.taskId}`);
    } catch (err) {
      failed++;
      console.error(`[error] ${row.taskId}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed} total=${rows.length}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
