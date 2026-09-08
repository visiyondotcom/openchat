// Deletes MusicGeneration rows whose tracks still point at a non-local
// (dead) audioUrl — i.e. exactly the ones repair-tracks.mjs could not
// recover. Safe: only touches rows where NONE of the tracks were repaired.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function isOurs(url) {
  return typeof url === "string" && url.includes("/music-files/");
}

async function main() {
  const generations = await prisma.musicGeneration.findMany({
    where: { status: "COMPLETE", tracks: { not: null } },
    select: { id: true, title: true, tracks: true },
  });

  const toDelete = [];
  for (const gen of generations) {
    const tracks = Array.isArray(gen.tracks) ? gen.tracks : [];
    const hasBroken = tracks.some((t) => t && t.audioUrl && !isOurs(t.audioUrl));
    if (hasBroken) toDelete.push(gen);
  }

  console.log(`Found ${toDelete.length} broken generation(s) to delete:`);
  for (const g of toDelete) console.log(`  ${g.id} :: ${g.title || "(untitled)"}`);

  if (toDelete.length > 0) {
    const res = await prisma.musicGeneration.deleteMany({
      where: { id: { in: toDelete.map((g) => g.id) } },
    });
    console.log(`\nDeleted ${res.count} row(s).`);
  }
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
