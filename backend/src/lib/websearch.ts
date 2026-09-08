// Web search supports SearXNG today (the bundled self-hosted meta search
// engine — see docker-compose.yml), managed from Admin > Settings > Web
// search. `provider` is kept as a field (rather than hardcoded) so a
// future provider (Brave Search API, SerpAPI, ...) can be added without a
// schema migration.
//
// ---- Config resolution ----
// Same "DB wins, falls back to env" pattern as lib/images.ts and
// lib/music.ts: config can come from Admin > Settings > Web search (the
// AppSettings singleton row) or from SEARXNG_* env vars. Cached in-memory
// for CACHE_TTL_MS; admin.ts calls invalidateWebSearchConfigCache() right
// after a save so a URL/toggle change takes effect immediately, no
// restart needed.

import type { PrismaClient } from "@prisma/client";

export type WebSearchProvider = "searxng";

type WebSearchConfig = {
  enabled: boolean;
  provider: WebSearchProvider;
  url: string;
  apiKey: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: WebSearchConfig; expiresAt: number } | null = null;

const DEFAULT_URL = "http://localhost:8080";

export function invalidateWebSearchConfigCache(): void {
  cache = null;
}

function normalizeProvider(value: string | null | undefined): WebSearchProvider {
  return "searxng";
}

async function loadConfig(prisma?: PrismaClient): Promise<WebSearchConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    webSearchEnabled: boolean | null;
    webSearchProvider: string | null;
    webSearchUrl: string | null;
    webSearchApiKey: string | null;
  } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          webSearchEnabled: true,
          webSearchProvider: true,
          webSearchUrl: true,
          webSearchApiKey: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every search call.
      row = null;
    }
  }

  const provider = normalizeProvider(row?.webSearchProvider);
  const url = row?.webSearchUrl || process.env.SEARXNG_URL || DEFAULT_URL;
  const apiKey = row?.webSearchApiKey || null;

  // A URL is always present (falls back to the default), so "configured"
  // really just means "an explicit URL was set" OR the admin has turned
  // it on anyway pointing at the default local instance. webSearchEnabled
  // is nullable: null means no explicit admin choice yet, so fall back to
  // "an explicit URL/env var was set" — same as the old always-on
  // behavior, so an existing deployment that only ever set SEARXNG_URL
  // isn't silently disabled after upgrading to this DB-backed config.
  const explicitlyConfigured = Boolean(row?.webSearchUrl || process.env.SEARXNG_URL);
  const value: WebSearchConfig = {
    enabled: row?.webSearchEnabled ?? explicitlyConfigured,
    provider,
    url,
    apiKey,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function webSearchEnabled(prisma?: PrismaClient): Promise<boolean> {
  const config = await loadConfig(prisma);
  return config.enabled;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

// Queries SearXNG's JSON API (must have `formats: [html, json]` enabled in
// searxng/settings.yml — see that file's comment). Returns the top `limit`
// results, trimmed to what's useful as LLM context.
export async function webSearch(query: string, limit = 5, prisma?: PrismaClient): Promise<WebSearchResult[]> {
  const config = await loadConfig(prisma);
  const url = `${config.url}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`SearXNG request failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    results?: { title: string; url: string; content?: string }[];
  };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content || "",
  }));
}

export async function searxngHealth(prisma?: PrismaClient): Promise<boolean> {
  try {
    const config = await loadConfig(prisma);
    const res = await fetch(`${config.url}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

// Formats results as a system-message block, same shape as the RAG context
// block so the model treats both consistently. Sources are numbered so the
// model can be asked to cite them (e.g. "[1]") in its answer.
export function buildSearchContextBlock(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return "";
  const items = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join("\n\n");
  return [
    `Live web search results for "${query}" (as of now). Use these to answer if relevant, and cite sources by their [n] number when you do:`,
    items,
  ].join("\n\n");
}
