import fs from "node:fs/promises";
import path from "node:path";

// Root directory published Studio sites are written to. Mounted as a
// shared volume into the nginx container (read-only there) so its wildcard
// `*.visiyon.com` server block can serve these files directly off disk —
// see nginx/nginx.conf and docker-compose.yml (published_sites_data).
export const PUBLISHED_SITES_DIR = process.env.PUBLISHED_SITES_DIR || "/app/sites";

let ensured = false;
async function ensureRoot(): Promise<void> {
  if (ensured) return;
  await fs.mkdir(PUBLISHED_SITES_DIR, { recursive: true });
  ensured = true;
}

// Subdomains a user can never claim — either because nginx/the app already
// use them for something else, or because they'd be confusing/abusable
// (impersonating the platform itself). Checked case-insensitively.
export const RESERVED_SUBDOMAINS = new Set([
  "www", "api", "admin", "app", "mail", "smtp", "ftp", "ns1", "ns2",
  "staging", "dev", "test", "docs", "status", "blog", "cdn", "assets",
  "static", "support", "help", "billing", "auth", "login", "dashboard",
  "searxng", "backend", "frontend", "visiyon", "music", "community",
]);

// DNS-label-safe: lowercase letters, digits, hyphens, 3-63 chars, no
// leading/trailing hyphen. Deliberately conservative — this string ends up
// directly in a directory name and (via nginx) a hostname.
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

export function isValidSubdomain(subdomain: string): boolean {
  return (
    SUBDOMAIN_PATTERN.test(subdomain) &&
    !RESERVED_SUBDOMAINS.has(subdomain.toLowerCase())
  );
}

// Rejects any path that could escape the per-site directory (absolute
// paths, "..", null bytes) — the only thing allowed through is a plain
// relative file path made of normal path segments.
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || relPath.includes("\0")) return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) return false;
  return true;
}

function siteDir(subdomain: string): string {
  return path.join(PUBLISHED_SITES_DIR, subdomain);
}

// Writes out a full site as a clean replacement of whatever was there
// before (removes files that no longer exist in `files` — e.g. one that
// was deleted in the editor since the last publish).
export async function writeSiteFiles(subdomain: string, files: Record<string, string>): Promise<void> {
  if (!isValidSubdomain(subdomain)) throw new Error("Invalid subdomain");
  await ensureRoot();
  const dir = siteDir(subdomain);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  for (const [relPath, content] of Object.entries(files)) {
    if (!isSafeRelativePath(relPath)) continue; // silently skip, never write outside dir
    const dest = path.join(dir, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf-8");
  }

  // Guarantee something loads at the site root even if the project has no
  // index.html yet, rather than nginx just 404ing on the bare subdomain.
  try {
    await fs.access(path.join(dir, "index.html"));
  } catch {
    await fs.writeFile(
      path.join(dir, "index.html"),
      "<!doctype html><html><body><p>This site has no index.html yet.</p></body></html>",
      "utf-8"
    );
  }
}

export async function removeSite(subdomain: string): Promise<void> {
  if (!isValidSubdomain(subdomain)) return;
  await fs.rm(siteDir(subdomain), { recursive: true, force: true });
}
