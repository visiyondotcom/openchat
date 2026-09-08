import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

function fixUrl(url) {
  if (typeof url !== "string") return url;
  if (url.includes("/api/music-files/")) return url;
  if (url.includes("/music-files/")) return url.replace("/music-files/", "/api/music-files/");
  return url;
}

async function main() {
  const generations = await prisma.musicGeneration.findMany({
    where: { status: "COMPLETE", tracks: { not: null } },
    select: { id: true, title: true, tracks: true },
  });
  let fixed = 0;
  for (const gen of generations) {
    const tracks = Array.isArray(gen.tracks) ? gen.tracks : [];
    let changed = false;
    for (const t of tracks) {
      if (!t) continue;
      const newUrl = fixUrl(t.audioUrl);
      if (newUrl !== t.audioUrl) { t.audioUrl = newUrl; changed = true; }
    }
    if (changed) {
      await prisma.musicGeneration.update({ where: { id: gen.id }, data: { tracks } });
      fixed++;
      console.log(`Fixed ${gen.id} :: ${gen.title || "(untitled)"}`);
    }
  }
  console.log(`\nTotal fixed: ${fixed}`);
}
main().catch((err) => { console.error("FATAL:", err); process.exitCode = 1; }).finally(() => prisma.$disconnect());
