"use client";

import { askConfirm } from "@/components/PromptDialog";
import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { adminCheckForUpdate, adminGetUpdateStatus, adminApplyUpdate, type UpdateCheckResult, type UpdateStatus } from "@/lib/api";
import { ArrowLeft, DownloadCloud, CheckCircle2, XCircle, ExternalLink, Loader2 } from "lucide-react";

export default function UpdatesAdminPage() {
  const ready = useRequireAdmin();
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refreshCheck(force = false) {
    setChecking(true);
    try {
      setCheck(await adminCheckForUpdate(force));
    } finally {
      setChecking(false);
    }
  }

  async function refreshStatus() {
    const s = await adminGetUpdateStatus();
    setStatus(s);
    return s;
  }

  useEffect(() => {
    refreshCheck();
    refreshStatus().then((s) => {
      if (s.state === "running") startPolling();
    });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const s = await refreshStatus();
      if (s.state !== "running") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        if (s.state === "success") refreshCheck(true);
      }
    }, 2000);
  }

  async function handleUpdate() {
    if (
      !(await askConfirm({
        title:
          "Update the platform now? This pulls the latest version and rebuilds/restarts the app — it normally takes a minute or two, and the app will briefly be unreachable while containers restart.",
        confirmLabel: "Update now",
      }))
    )
      return;
    setApplying(true);
    setError(null);
    try {
      const res = await adminApplyUpdate();
      if (!res.ok) {
        setError(res.message);
      } else {
        startPolling();
      }
    } finally {
      setApplying(false);
    }
  }

  if (!ready) return null;

  const running = status?.state === "running";

  return (
    <div className="h-full overflow-y-auto bg-visiyon-bg text-visiyon-text">
      <div className="p-6 max-w-3xl mx-auto">
        <Link href="/admin" className="text-sm text-visiyon-text-3 flex items-center gap-1 mb-4 hover:text-visiyon-text">
          <ArrowLeft size={14} /> Back to admin
        </Link>
        <h1 className="text-xl font-semibold mb-1 flex items-center gap-2">
          <DownloadCloud size={20} /> Updates
        </h1>
        <p className="text-xs text-visiyon-text-3 mb-6">
          Check for and apply platform updates. Applying an update pulls the latest release and rebuilds the Docker
          Compose stack in the background.
        </p>

        {!check?.enabled && !checking && (
          <div className="bg-visiyon-text/5 rounded-[6px] p-4 text-sm text-visiyon-text-3">
            Updates aren't configured for this deployment. Set the <code className="text-visiyon-text">UPDATE_REPO</code>{" "}
            environment variable (e.g. <code className="text-visiyon-text">yourname/your-repo</code>) and make sure the{" "}
            <code className="text-visiyon-text">updater</code> service in <code className="text-visiyon-text">docker-compose.yml</code>{" "}
            is running.
          </div>
        )}

        {check?.enabled && (
          <>
            <div className="bg-visiyon-text/5 rounded-[6px] p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm text-visiyon-text-3">Current version</div>
                  <div className="font-mono text-lg">{check.currentVersion}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-visiyon-text-3">Latest version</div>
                  <div className="font-mono text-lg">
                    {check.latestVersion ?? (checking ? "checking…" : "unknown")}
                  </div>
                </div>
              </div>

              {check.updateAvailable ? (
                <div className="flex items-center gap-2 text-emerald-400 text-sm mb-3">
                  <CheckCircle2 size={15} /> An update is available
                </div>
              ) : (
                <div className="text-sm text-visiyon-text-3 mb-3">You're up to date.</div>
              )}

              {check.releaseNotes && (
                <div className="text-xs text-visiyon-text-2 whitespace-pre-line bg-black/30 rounded-[6px] p-3 mb-3 max-h-40 overflow-y-auto">
                  {check.releaseNotes}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={() => refreshCheck(true)}
                  disabled={checking || running}
                  className="px-3 py-1.5 rounded-[6px] bg-visiyon-text/5 hover:bg-visiyon-text/10 text-xs disabled:opacity-40 transition-colors"
                >
                  {checking ? "Checking…" : "Check now"}
                </button>
                {check.releaseUrl && (
                  <a
                    href={check.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 rounded-[6px] bg-visiyon-text/5 hover:bg-visiyon-text/10 text-xs flex items-center gap-1 transition-colors"
                  >
                    Release notes <ExternalLink size={12} />
                  </a>
                )}
                <button
                  onClick={handleUpdate}
                  disabled={!check.updateAvailable || applying || running}
                  className="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-[6px] bg-visiyon-accent text-visiyon-bg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {running || applying ? <Loader2 size={13} className="animate-spin" /> : <DownloadCloud size={13} />}
                  {running ? "Updating…" : "Update now"}
                </button>
              </div>
              {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
            </div>

            {status && status.state !== "idle" && (
              <div className="bg-visiyon-text/5 rounded-[6px] p-4">
                <div className="flex items-center gap-2 text-sm mb-2">
                  {status.state === "running" && <Loader2 size={14} className="animate-spin text-visiyon-text-3" />}
                  {status.state === "success" && <CheckCircle2 size={14} className="text-emerald-400" />}
                  {status.state === "failed" && <XCircle size={14} className="text-red-400" />}
                  <span className="font-medium">
                    {status.state === "running" && "Update in progress"}
                    {status.state === "success" && "Update completed"}
                    {status.state === "failed" && "Update failed"}
                  </span>
                </div>
                <pre className="text-xs font-mono text-visiyon-text-2 bg-black/30 rounded-[6px] p-3 max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {status.log || "…"}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
