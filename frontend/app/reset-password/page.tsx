"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import { resetPassword } from "@/lib/api";

function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    if (!token) {
      setError("Missing or invalid reset link");
      return;
    }
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed — the link may have expired");
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo size={24} />
        </div>
        <h1 className="text-xl font-semibold text-center mb-6">Set a new password</h1>

        {done ? (
          <p className="text-center text-[13.5px] text-visiyon-text-2">
            Password updated. Redirecting to login…
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="password"
              required
              minLength={8}
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
            />
            {error && <p className="text-red-400 text-[13px]">{error}</p>}
            <button
              type="submit"
              className="w-full bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/85 transition-colors"
            >
              Update password
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
