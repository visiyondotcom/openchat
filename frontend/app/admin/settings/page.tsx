"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// /admin/settings has no content of its own anymore — each section now
// lives at its own real URL (/admin/settings/general, /admin/settings/
// usagelimits, ...) so it survives a refresh and can be linked to
// directly. Visiting the bare /admin/settings URL sends you to General.
export default function AdminSettingsIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin/settings/general");
  }, [router]);
  return null;
}
