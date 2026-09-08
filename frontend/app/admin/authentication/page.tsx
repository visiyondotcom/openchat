"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import { getPublicConfig, adminSetSignupEnabled } from "@/lib/api";

export default function AdminAuthenticationPage() {
  const ready = useRequireAdmin();
  const [signupEnabled, setSignupEnabled] = useState(true);

  useEffect(() => {
    getPublicConfig().then((cfg) => setSignupEnabled(cfg.signupEnabled)).catch(() => {});
  }, []);

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Authentication</h1>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[13px] text-visiyon-text-2">Public sign-ups</span>
          <button
            onClick={async () => {
              const next = !signupEnabled;
              setSignupEnabled(next);
              try {
                await adminSetSignupEnabled(next);
              } catch {
                setSignupEnabled(!next);
              }
            }}
            className={`relative w-10 h-[22px] rounded-full transition-colors ${
              signupEnabled ? "bg-visiyon-accent" : "bg-visiyon-text/15"
            }`}
            title={signupEnabled ? "Sign-ups are enabled — click to disable" : "Sign-ups are disabled — click to enable"}
          >
            <span
              className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-visiyon-bg transition-transform ${
                signupEnabled ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
              }`}
            />
          </button>
          <span className="text-[12px] text-visiyon-text-3">{signupEnabled ? "Enabled" : "Disabled"}</span>
        </div>
        <p className="text-[12px] text-visiyon-text-3 mt-2">
          When disabled, new visitors can no longer create an account — existing users can still sign in.
        </p>
      </div>
    </div>
  );
}
