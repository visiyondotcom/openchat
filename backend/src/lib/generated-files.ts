import fs from "node:fs/promises";

export const GENERATED_FILES_DIR = process.env.GENERATED_FILES_DIR || "/app/generated";

let ensured = false;
export async function ensureGeneratedFilesDir(): Promise<void> {
  if (ensured) return;
  await fs.mkdir(GENERATED_FILES_DIR, { recursive: true });
  ensured = true;
}
