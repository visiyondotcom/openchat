// Deletes MusicGeneration rows where any track has no audioUrl at all
// (failed/empty generations that got marked COMPLETE anyway) — the
// "This track has no audio file yet" / 0:00 items in the UI.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function isEmpty(url) {
  return !url || typeof url !== "string" || url.trim() === "";
}

async function main() {
  const generations = await prisma.musicGeneration.findMany({
    where: { status: "COMPLETE" },
    select: { id: true, title: true, tracks: true },
  });

  const toDelete = [];
  for (const gen of generations) {
    const tracks = Array.isArray(gen.tracks) ? gen.tracks : [];
    const hasEmpty = tracks.length === 0 || tracks.some((t) => !t || isEmpty(t.audioUrl));
    if (hasEmpty) toDelete.push(gen);
  }

  console.log(`Found ${toDelete.length} empty/broken generation(s) to delete:`);
  for (const g of toDelete) console.log(`  ${g.id} :: ${g.title || "(untitled)"}`);

  if (toDelete.length > 0) {
    const res = await prisma.musicGeneration.deleteMany({
      where: { id: { in: toDelete.map((g) => g.id) } },
    });
    console.log(`\nDeleted ${res.count} row(s).`);
  }
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
