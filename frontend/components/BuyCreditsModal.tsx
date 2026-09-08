"use client";

import { useEffect, useState } from "react";
import { X, Droplet } from "lucide-react";
import { getCreditsConfig, getCreditsBalance, createCreditsCheckout, CreditPackage } from "@/lib/api";

function formatEuro(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(cents / 100);
}

// Replaces the old subscription/"Upgrade" picker on /generate — this app
// is pay-as-you-go now: buy a pack of credits, spend them on generations
// (see the Generate button's "~N credits" label and backend
// lib/mediaCost.ts for the per-model price).
export default function BuyCreditsModal({
  onClose,
  insufficientAmount,
}: {
  onClose: () => void;
  // When set, the modal was opened because a generation was rejected for
  // not having enough credits — shows a short explanatory line instead of
  // opening silently on the plain picker.
  insufficientAmount?: { required: number; available: number } | null;
}) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [checkingOut, setCheckingOut] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [config, bal] = await Promise.all([getCreditsConfig(), getCreditsBalance().catch(() => null)]);
        if (cancelled) return;
        setEnabled(config.enabled);
        setPackages(config.packages || []);
        setBalance(bal?.credits ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(amountCents: number) {
    setError(null);
    setCheckingOut(amountCents);
    try {
      const { url } = await createCreditsCheckout(amountCents);
      window.location.href = url;
    } catch (err: any) {
      setError(err.message || "Failed to start checkout.");
      setCheckingOut(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md px-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-visiyon-bg rounded-[6px] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-5">
          <h2 className="text-[19px] font-medium text-visiyon-text">Buy credits</h2>
          <button onClick={onClose} className="text-visiyon-text-3 hover:text-visiyon-text transition-colors" title="Close">
            <X size={18} />
          </button>
        </div>

        {insufficientAmount && (
          <p className="text-[13px] leading-relaxed text-visiyon-text-2 mb-5">
            This generation needs <b>{insufficientAmount.required}</b> credits — you have{" "}
            <b>{insufficientAmount.available}</b>. Top up below to continue.
          </p>
        )}

        <div className="border border-visiyon-border rounded-[6px] px-4 py-3 flex items-center justify-between mb-6">
          <div className="text-[12.5px] text-visiyon-text-3">Current balance</div>
          <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-visiyon-text">
            <Droplet size={13} className="text-visiyon-accent" fill="currentColor" />
            {balance == null ? "—" : balance.toLocaleString()} credits
          </div>
        </div>

        {error && <p className="text-[12.5px] text-red-400 mb-4 animate-blink">{error}</p>}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {packages.map((pack) => (
            <div key={pack.amountCents} className="border border-visiyon-border rounded-[6px] p-4 flex flex-col items-center text-center">
              <Droplet size={18} className="text-visiyon-accent mb-2" fill="currentColor" />
              <div className="text-[16px] font-semibold text-visiyon-text">{pack.credits.toLocaleString()}</div>
              <div className="text-[11px] text-visiyon-text-3 mb-3">credits</div>
              <button
                disabled={loading || !enabled || checkingOut === pack.amountCents}
                onClick={() => choose(pack.amountCents)}
                className="w-full text-[12.5px] font-medium px-3 py-2 rounded-[6px] bg-white text-black hover:bg-visiyon-text/85 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {checkingOut === pack.amountCents ? "Redirecting…" : !enabled ? "Not available" : formatEuro(pack.amountCents)}
              </button>
            </div>
          ))}
        </div>

        {!loading && !enabled && (
          <p className="text-[12px] text-visiyon-text-3 mt-4">Payments aren't configured on this server yet.</p>
        )}
      </div>
    </div>
  );
}
