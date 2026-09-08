"use client";

import Link from "next/link";
import { useRequireAuth } from "@/lib/useAuth";
import { X, ShieldCheck } from "lucide-react";

const SECTIONS: Array<{ title: string; body: string[] }> = [
  {
    title: "Terms of Service",
    body: [
      "By using Visiyon you agree to use the platform only for lawful purposes and in line with the content rules described below. Accounts that repeatedly violate these terms may be suspended or terminated.",
      "Generated images, videos, and other media are produced by third-party AI models. Visiyon does not guarantee the accuracy, originality, or fitness for any particular purpose of generated content.",
    ],
  },
  {
    title: "Acceptable Use",
    body: [
      "Do not use Visiyon to generate content that is sexually explicit involving minors, that depicts real people without consent in a defamatory or non-consensual sexual way, or that promotes violence, self-harm, or unlawful activity.",
      "Do not attempt to circumvent moderation, rate limits, or account restrictions, or use automated tools to scrape or abuse the service.",
    ],
  },
  {
    title: "Content Ownership",
    body: [
      "You retain rights to the prompts you write. Subject to the underlying model providers' terms, you may use media you generate for personal or commercial purposes, provided it complies with these policies.",
      "Publishing a generation to Explore makes it visible to other users of the platform; you can unpublish it at any time from Assets or Generate.",
    ],
  },
  {
    title: "Privacy",
    body: [
      "We store your prompts, generated media, and account details (including an optional profile photo) to operate the service and show your history back to you. We do not sell your personal data.",
      "You can remove your profile photo at any time from Profile Settings, and can request account deletion by contacting support.",
    ],
  },
  {
    title: "Changes to These Policies",
    body: [
      "We may update these policies as the product evolves. Material changes will be reflected on this page with an updated date.",
    ],
  },
];

export default function PoliciesPage() {
  const { ready } = useRequireAuth();
  if (!ready) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-visiyon-bg text-visiyon-text">
      <header className="flex items-center gap-3 px-5 h-14 shrink-0 border-b border-visiyon-border">
        <Link href="/generate" className="text-visiyon-text-2 hover:text-visiyon-text transition-colors">
          <X size={18} />
        </Link>
        <h1 className="text-[15px] font-medium flex items-center gap-2">
          <ShieldCheck size={16} className="text-visiyon-accent" />
          Policies and Agreements
        </h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-8">
        <div className="max-w-2xl mx-auto space-y-8">
          <p className="text-[13px] text-visiyon-text-3">Last updated: September 2026</p>
          {SECTIONS.map((s) => (
            <section key={s.title} className="space-y-2">
              <h2 className="text-[14px] font-semibold">{s.title}</h2>
              {s.body.map((p, i) => (
                <p key={i} className="text-[13px] leading-relaxed text-visiyon-text-2">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
