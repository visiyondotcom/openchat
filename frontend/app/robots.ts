import type { MetadataRoute } from "next";

// Almost everything under ai.visiyon.com sits behind a login (chat,
// generate, editor, assets, settings, admin, ...). Letting crawlers in
// there wastes crawl budget on pages they'll just get redirected away
// from, so only the public entry points are allowed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/login", "/register", "/forgot-password", "/reset-password"],
      disallow: [
        "/chat",
        "/generate",
        "/editor",
        "/video-editor",
        "/studio",
        "/assets",
        "/explore",
        "/arena",
        "/channels",
        "/music",
        "/notes",
        "/automations",
        "/playground",
        "/settings",
        "/admin",
        "/composer-popout",
        "/share",
        "/tools",
        "/policies",
        "/api",
      ],
    },
    sitemap: "https://ai.visiyon.com/sitemap.xml",
  };
}
