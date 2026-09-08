"use client";

import { useState } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";
import { requestPasswordReset } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await requestPasswordReset(email);
      setSent(true);
      // Only present when SMTP isn't configured on the backend — lets you
      // test the flow locally without a mail server.
      if (res.resetToken) setDevToken(res.resetToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo size={24} />
        </div>
        <h1 className="text-xl font-semibold text-center mb-6">Reset your password</h1>

        {sent ? (
          <div className="text-center space-y-3">
            <p className="text-[13.5px] text-visiyon-text-2">
              If an account exists for {email}, a reset link has been sent.
            </p>
            {devToken && (
              <div className="text-left text-[12px] bg-visiyon-text/[0.05] border border-visiyon-border rounded-xl p-3">
                <p className="text-visiyon-text-3 mb-1">
                  SMTP is not configured on this deployment — here's a dev link instead:
                </p>
                <Link href={`/reset-password?token=${encodeURIComponent(devToken)}`} className="text-visiyon-text underline break-all">
                  Reset your password
                </Link>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
            />
            {error && <p className="text-red-400 text-[13px]">{error}</p>}
            <button
              type="submit"
              className="w-full bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/85 visiyon-btn-primary transition-colors"
            >
              Send reset link
            </button>
          </form>
        )}

        <p className="text-center text-[13.5px] text-visiyon-text-2 mt-6">
          <Link href="/login" className="text-visiyon-text underline">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
