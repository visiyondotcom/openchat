"use client";

import { useRequireAdmin } from "@/lib/useAuth";
import AnalyticsPanel from "@/components/AnalyticsPanel";

export default function AdminAnalyticsPage() {
  const ready = useRequireAdmin();
  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        </div>
        <AnalyticsPanel />
      </div>
    </div>
  );
}
