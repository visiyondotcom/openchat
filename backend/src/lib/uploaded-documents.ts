import fs from "node:fs/promises";

// Where the *original* bytes of a user-uploaded document (Settings →
// Documents / the composer's attach menu) are kept, so they can be
// downloaded again later. Previously only the extracted/chunked/embedded
// text was ever persisted (see lib/rag.ts) — the raw file itself was
// discarded right after processing, so there was nothing to download.
// Each file is stored under its Document.id (a cuid, so no path-safety
// concerns), independent of the original filename — that's read back from
// the Document row itself when serving the download.
export const UPLOADED_DOCUMENTS_DIR = process.env.UPLOADED_DOCUMENTS_DIR || "/app/uploads";

let ensured = false;
export async function ensureUploadedDocumentsDir(): Promise<void> {
  if (ensured) return;
  await fs.mkdir(UPLOADED_DOCUMENTS_DIR, { recursive: true });
  ensured = true;
}
