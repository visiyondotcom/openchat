"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import CaptchaPuzzle, { CaptchaAnswer } from "@/components/CaptchaPuzzle";
import { register, getPublicConfig, getInvite } from "@/lib/api";

function RegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  const [terms, setTerms] = useState<{ required: boolean; content: string }>({
    required: false,
    content: "",
  });
  // "form" = the usual name/email/password fields; "terms" = the
  // Claude-style "review and accept before continuing" step, shown only
  // when an admin has turned on Settings > General > Terms of Service.
  const [step, setStep] = useState<"form" | "terms">("form");
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Admin-controlled — Admin > Settings > General > CAPTCHA. Defaults
  // to off so the form isn't gated while the one-time public-config
  // fetch below is in flight.
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState<CaptchaAnswer | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  // ?invite=<token> from an admin-sent invite email (Admin > Users >
  // Invite user). While it's being verified we don't know yet whether
  // signup is otherwise disabled etc., so the form stays hidden.
  const inviteToken = searchParams.get("invite") || undefined;
  const [inviteChecked, setInviteChecked] = useState(!inviteToken);
  const [inviteError, setInviteError] = useState("");
  const hasValidInvite = Boolean(inviteToken) && !inviteError;

  useEffect(() => {
    getPublicConfig()
      .then((cfg) => {
        setSignupEnabled(cfg.signupEnabled);
        setTerms(cfg.terms ?? { required: false, content: "" });
        setCaptchaEnabled(cfg.captcha.enabled);
      })
      .catch(() => setSignupEnabled(true));
  }, []);

  useEffect(() => {
    if (!inviteToken) return;
    getInvite(inviteToken)
      .then((inv) => setEmail(inv.email))
      .catch((err) => setInviteError(err instanceof Error ? err.message : "This invite link is invalid or has expired."))
      .finally(() => setInviteChecked(true));
  }, [inviteToken]);

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // An invite is the admin's own approval to join, so it skips the
    // captcha and terms-of-service steps entirely — those exist to
    // gate public, unapproved signups.
    if (hasValidInvite) {
      void doRegister(false);
      return;
    }
    if (captchaEnabled && !captchaAnswer) {
      setError("Please solve the puzzle to continue.");
      return;
    }
    if (terms.required) {
      setStep("terms");
    } else {
      void doRegister(false);
    }
  }

  async function doRegister(acceptedTerms: boolean) {
    setSubmitting(true);
    setError("");
    try {
      await register(email, password, name, acceptedTerms, captchaAnswer ?? undefined, inviteToken);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setStep("form");
      // A stale/used captcha answer can't be retried — force a fresh solve.
      setCaptchaAnswer(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full flex">
      <div className="relative hidden md:block md:w-1/2 lg:w-[45%] overflow-hidden">
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src="/video/login-bg.mp4"
          autoPlay
          muted
          loop
          playsInline
          poster="/login-bg.jpg"
        />
        <div className="absolute inset-0 bg-black/35" />
      </div>
      <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo size={24} />
        </div>

        {inviteToken && !inviteChecked ? (
          <p className="text-center text-[13.5px] text-visiyon-text-2">Checking your invite…</p>
        ) : inviteToken && inviteError ? (
          <>
            <h1 className="text-xl font-semibold text-center mb-6">Create your account</h1>
            <p className="text-center text-[13.5px] text-visiyon-text-2">
              {inviteError}{" "}
              <Link href="/login" className="text-visiyon-text underline">
                Back to login
              </Link>
            </p>
          </>
        ) : !hasValidInvite && signupEnabled === false ? (
          <>
            <h1 className="text-xl font-semibold text-center mb-6">Create your account</h1>
            <p className="text-center text-[13.5px] text-visiyon-text-2">
              Sign-ups are currently disabled by the administrator.{" "}
              <Link href="/login" className="text-visiyon-text underline">
                Back to login
              </Link>
            </p>
          </>
        ) : step === "terms" ? (
          <>
            <h1 className="text-xl font-semibold text-center mb-2">Terms of Service</h1>
            <p className="text-center text-[13px] text-visiyon-text-3 mb-5">
              Please review and accept our terms before continuing.
            </p>
            <div className="border border-visiyon-border rounded-xl p-4 h-64 overflow-y-auto text-[13px] leading-relaxed text-visiyon-text-2 whitespace-pre-wrap mb-4">
              {terms.content?.trim() || "No terms of service have been configured yet."}
            </div>
            <label className="flex items-start gap-2.5 text-[13px] text-visiyon-text-2 mb-4 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 accent-white"
              />
              I have read and agree to the Terms of Service.
            </label>
            {error && <p className="text-red-400 text-[13px] mb-3">{error}</p>}
            <button
              onClick={() => doRegister(true)}
              disabled={!agreed || submitting}
              className="w-full bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/85 visiyon-btn-primary transition-colors disabled:opacity-40 disabled:hover:bg-white"
            >
              {submitting ? "Creating account…" : "Continue"}
            </button>
            <button
              onClick={() => setStep("form")}
              disabled={submitting}
              className="w-full text-center text-[13px] text-visiyon-text-3 hover:text-visiyon-text mt-3 disabled:opacity-40"
            >
              Back
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-center mb-2">Create your account</h1>
            {hasValidInvite && (
              <p className="text-center text-[13px] text-visiyon-text-3 mb-4">
                You've been invited to join — just set a name and password.
              </p>
            )}
            <form onSubmit={handleFormSubmit} className="space-y-3 mt-4">
              <input
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
              />
              <input
                type="email"
                required
                readOnly={hasValidInvite}
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                title={hasValidInvite ? "Locked to the email this invite was sent to" : undefined}
                className={`w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none transition-colors ${
                  hasValidInvite ? "text-visiyon-text-2 cursor-not-allowed" : "focus:border-visiyon-text"
                }`}
              />
              <input
                type="password"
                required
                minLength={8}
                placeholder="Password (min. 8 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
              />
              {error && <p className="text-red-400 text-[13px]">{error}</p>}
              {!hasValidInvite && captchaEnabled && (
                <div className="pt-1">
                  <CaptchaPuzzle onSolved={setCaptchaAnswer} onReset={() => setCaptchaAnswer(null)} />
                </div>
              )}
              <button
                type="submit"
                disabled={submitting || (!hasValidInvite && captchaEnabled && !captchaAnswer)}
                className="w-full bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/85 visiyon-btn-primary transition-colors disabled:opacity-40 disabled:hover:bg-white"
              >
                {submitting ? "Creating account…" : !hasValidInvite && terms.required ? "Continue" : "Sign up"}
              </button>
            </form>
          </>
        )}

        {step === "form" && !(inviteToken && (!inviteChecked || inviteError)) && (
          <p className="text-center text-[13.5px] text-visiyon-text-2 mt-6">
            Already have an account?{" "}
            <Link href="/login" className="text-visiyon-text underline">
              Log in
            </Link>
          </p>
        )}
      </div>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
