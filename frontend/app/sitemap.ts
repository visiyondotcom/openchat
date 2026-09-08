import type { MetadataRoute } from "next";

// ai.visiyon.com is the logged-in app itself (chat, generate, editor,
// assets, etc.) — almost every route requires an account, so listing
// them here would just point search engines at pages they can't actually
// crawl. Only the handful of genuinely public routes belong in a
// sitemap; the real marketing/content site to index is studio.visiyon.com.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://ai.visiyon.com";
  const now = new Date();
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/register`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
  ];
}
