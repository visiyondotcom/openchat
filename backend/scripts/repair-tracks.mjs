// One-off repair migration: downloads and permanently stores audio for
// every already-generated track whose audioUrl still points at the
// provider's temporary tempfile.* host, using the same storage scheme as
// lib/music.ts's persistTrackAudio() (sha1-of-source-URL filename under
// MUSIC_FILES_DIR, served via /music-files/:filename). Safe to re-run:
// tracks already migrated (audioUrl already under our own host) are
// skipped, and per-track download failures don't abort the run.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const prisma = new PrismaClient();
const MUSIC_FILES_DIR = process.env.MUSIC_FILES_DIR || "/app/music";
const PUBLIC_BASE_URL = (process.env.MUSIC_GEN_CALLBACK_URL || "").replace(/\/music\/callback\/?$/, "") || "";

function isAlreadyOurs(url) {
  return typeof url === "string" && url.includes("/music-files/");
}

async function persistTrackAudio(sourceUrl) {
  await fs.mkdir(MUSIC_FILES_DIR, { recursive: true });
  const hash = crypto.createHash("sha1").update(sourceUrl).digest("hex");
  const extMatch = sourceUrl.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  const ext = (extMatch?.[1] || "mp3").toLowerCase();
  const filename = `${hash}.${ext}`;
  const filePath = path.join(MUSIC_FILES_DIR, filename);

  let alreadyExists = true;
  try {
    await fs.access(filePath);
  } catch {
    alreadyExists = false;
  }

  if (!alreadyExists) {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(filePath, buf);
  }

  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/music-files/${filename}` : `/music-files/${filename}`;
}

async function main() {
  const generations = await prisma.musicGeneration.findMany({
    where: { status: "COMPLETE", tracks: { not: null } },
    select: { id: true, tracks: true },
  });

  let alreadyOk = 0;
  let repaired = 0;
  let lost = 0;

  for (const gen of generations) {
    const tracks = Array.isArray(gen.tracks) ? gen.tracks : [];
    let changed = false;

    for (const t of tracks) {
      if (!t || !t.audioUrl) continue;
      if (isAlreadyOurs(t.audioUrl)) {
        alreadyOk++;
        continue;
      }
      try {
        const newUrl = await persistTrackAudio(t.audioUrl);
        t.audioUrl = newUrl;
        changed = true;
        repaired++;
        console.log(`OK   ${gen.id} :: ${t.title || t.id}`);
      } catch (err) {
        lost++;
        console.log(`LOST ${gen.id} :: ${t.title || t.id} :: ${err.message}`);
      }
    }

    if (changed) {
      await prisma.musicGeneration.update({
        where: { id: gen.id },
        data: { tracks },
      });
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Already OK: ${alreadyOk}`);
  console.log(`Repaired:   ${repaired}`);
  console.log(`Lost:       ${lost}`);
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
