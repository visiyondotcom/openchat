import { NextRequest, NextResponse } from "next/server";
import { submitToIndexNow, INDEXNOW_HOST } from "@/lib/indexnow";

// Protects this from being used as an open ping-anything endpoint. Set
// INDEXNOW_ADMIN_SECRET in the environment and pass the same value as
// ?secret=... (or an "x-indexnow-secret" header) when calling it from an
// admin action or a deploy/publish script.
function isAuthorized(req: NextRequest): boolean {
  const configured = process.env.INDEXNOW_ADMIN_SECRET;
  if (!configured) return false; // fail closed if nothing is configured
  const provided = req.nextUrl.searchParams.get("secret") || req.headers.get("x-indexnow-secret");
  return provided === configured;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const urls: string[] = Array.isArray(body?.urls)
    ? body.urls
    : typeof body?.url === "string"
      ? [body.url]
      : [];

  if (urls.length === 0) {
    return NextResponse.json({ error: "Provide { url } or { urls: [...] }" }, { status: 400 });
  }

  const invalid = urls.filter((u) => {
    try {
      return new URL(u).host !== INDEXNOW_HOST;
    } catch {
      return true;
    }
  });
  if (invalid.length > 0) {
    return NextResponse.json({ error: "All urls must be absolute and on " + INDEXNOW_HOST, invalid }, { status: 400 });
  }

  const ok = await submitToIndexNow(urls);
  return NextResponse.json({ ok, submitted: urls.length });
}
