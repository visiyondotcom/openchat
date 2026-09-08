"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import { askConfirm } from "@/components/PromptDialog";
import { copyToClipboard } from "@/lib/clipboard";
import {
  adminListWebhooks,
  adminCreateWebhook,
  adminUpdateWebhook,
  adminRotateWebhookSecret,
  adminDeleteWebhook,
  adminListWebhookDeliveries,
  adminClearWebhookDeliveries,
  adminCleanupWebhookDeliveries,
  adminCleanupQuotaUsage,
  WebhookDelivery,
} from "@/lib/api";
import { Plus, Trash2, Webhook as WebhookIcon, KeyRound, ChevronDown, ChevronUp } from "lucide-react";

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret: string;
  createdAt: string;
}

export default function AdminWebhooksPage() {
  const ready = useRequireAdmin();
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [availableEvents, setAvailableEvents] = useState<string[]>([]);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [expandedWebhookId, setExpandedWebhookId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [quotaCleanupMsg, setQuotaCleanupMsg] = useState<string | null>(null);

  function refreshWebhooks() {
    adminListWebhooks()
      .then((d) => {
        setWebhooks(d.webhooks);
        setAvailableEvents(d.availableEvents);
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshWebhooks();
  }, []);

  async function handleCreateWebhook() {
    if (!newWebhookUrl.trim() || newWebhookEvents.length === 0) return;
    const { webhook } = await adminCreateWebhook(newWebhookUrl.trim(), newWebhookEvents);
    setNewWebhookUrl("");
    setNewWebhookEvents([]);
    setRevealedSecret(webhook.secret);
    refreshWebhooks();
  }

  function toggleNewWebhookEvent(event: string) {
    setNewWebhookEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  async function toggleDeliveries(webhookId: string) {
    if (expandedWebhookId === webhookId) {
      setExpandedWebhookId(null);
      return;
    }
    setExpandedWebhookId(webhookId);
    setLoadingDeliveries(true);
    try {
      const { deliveries: rows } = await adminListWebhookDeliveries(webhookId);
      setDeliveries((prev) => ({ ...prev, [webhookId]: rows }));
    } catch {
      // leave whatever was there before, if anything
    } finally {
      setLoadingDeliveries(false);
    }
  }

  async function handleClearDeliveries(webhookId: string) {
    if (!(await askConfirm({ title: "Clear delivery history for this webhook?", confirmLabel: "Clear" }))) return;
    await adminClearWebhookDeliveries(webhookId);
    setDeliveries((prev) => ({ ...prev, [webhookId]: [] }));
  }

  async function handleCleanupQuotaUsage() {
    const { deleted } = await adminCleanupQuotaUsage(90);
    setQuotaCleanupMsg(`${deleted} oude quota-rij(en) opgeruimd.`);
    setTimeout(() => setQuotaCleanupMsg(null), 4000);
  }

  async function handleCleanupDeliveries() {
    const { deleted } = await adminCleanupWebhookDeliveries(30);
    setQuotaCleanupMsg(`${deleted} oude delivery-rij(en) opgeruimd.`);
    setTimeout(() => setQuotaCleanupMsg(null), 4000);
    setDeliveries({});
    if (expandedWebhookId) {
      const { deliveries: rows } = await adminListWebhookDeliveries(expandedWebhookId);
      setDeliveries((prev) => ({ ...prev, [expandedWebhookId]: rows }));
    }
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <WebhookIcon size={20} /> Webhooks
          </h1>
          <div className="flex items-center gap-3">
            {quotaCleanupMsg && <span className="text-[11px] text-visiyon-text-3">{quotaCleanupMsg}</span>}
            <button
              onClick={handleCleanupDeliveries}
              className="text-[11px] px-2.5 py-1 rounded-full border border-visiyon-border text-visiyon-text-3 hover:border-visiyon-text hover:text-visiyon-text transition-colors"
              title="Deletes delivery logs older than 30 days"
            >
              Oude deliveries opruimen
            </button>
            <button
              onClick={handleCleanupQuotaUsage}
              className="text-[11px] px-2.5 py-1 rounded-full border border-visiyon-border text-visiyon-text-3 hover:border-visiyon-text hover:text-visiyon-text transition-colors"
              title="Deletes old quota usage event rows (older than 90 days)"
            >
              Oude quota-data opruimen
            </button>
          </div>
        </div>
        <p className="text-[12px] text-visiyon-text-3 mb-4">
          Every webhook is sent with an HMAC-SHA256 signature in the <code>X-Visiyon-Signature</code> header,
          computed over the raw request body using the secret below. Every delivery (including automatic
          retries) is logged — click a webhook to see its history.
        </p>

        <div className="rounded-[6px] p-5 mb-4 space-y-3">
          <input
            value={newWebhookUrl}
            onChange={(e) => setNewWebhookUrl(e.target.value)}
            placeholder="https://example.com/webhooks/visiyon"
            className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
          />
          <div className="flex flex-wrap gap-2">
            {availableEvents.map((ev) => {
              const active = newWebhookEvents.includes(ev);
              return (
                <button
                  key={ev}
                  onClick={() => toggleNewWebhookEvent(ev)}
                  className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                    active ? "bg-white text-black border-visiyon-text" : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                  }`}
                >
                  {ev}
                </button>
              );
            })}
          </div>
          <button
            onClick={handleCreateWebhook}
            disabled={!newWebhookUrl.trim() || newWebhookEvents.length === 0}
            className="flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-[6px] bg-white text-black disabled:opacity-40"
          >
            <Plus size={14} /> Add webhook
          </button>
        </div>

        {revealedSecret && (
          <div className="border border-visiyon-text rounded-[6px] p-4 mb-4">
            <p className="text-[12.5px] text-visiyon-text-2 mb-2">
              Secret for the new webhook — copy it now, it won&apos;t be shown again:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[13px] bg-visiyon-text/[0.06] rounded-[6px] px-3 py-2 overflow-x-auto whitespace-nowrap">
                {revealedSecret}
              </code>
              <button
                onClick={() => copyToClipboard(revealedSecret)}
                className="p-2 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors shrink-0"
              >
                <KeyRound size={14} />
              </button>
            </div>
            <button
              onClick={() => setRevealedSecret(null)}
              className="mt-3 text-[12px] text-visiyon-text-3 hover:text-visiyon-text"
            >
              Close
            </button>
          </div>
        )}

        <div className="space-y-2">
          {webhooks.length === 0 && <p className="text-visiyon-text-3 text-sm">No webhooks configured yet.</p>}
          {webhooks.map((w) => (
            <div key={w.id} className="rounded-[6px] px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[13px] font-medium truncate max-w-md">{w.url}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={async () => {
                      await adminUpdateWebhook(w.id, { enabled: !w.enabled });
                      refreshWebhooks();
                    }}
                    className={`text-[11px] px-2.5 py-1 rounded-full border ${
                      w.enabled ? "border-visiyon-text" : "border-visiyon-border text-visiyon-text-3"
                    }`}
                  >
                    {w.enabled ? "Active" : "Off"}
                  </button>
                  <button
                    onClick={async () => {
                      const { webhook } = await adminRotateWebhookSecret(w.id);
                      setRevealedSecret(webhook.secret);
                      refreshWebhooks();
                    }}
                    className="text-visiyon-text-3 hover:text-visiyon-text"
                    title="Regenerate secret"
                  >
                    <KeyRound size={14} />
                  </button>
                  <button
                    onClick={async () => {
                      if (await askConfirm({ title: `Delete webhook to "${w.url}"?`, confirmLabel: "Delete", danger: true })) {
                        await adminDeleteWebhook(w.id);
                        refreshWebhooks();
                      }
                    }}
                    className="text-visiyon-text-3 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    onClick={() => toggleDeliveries(w.id)}
                    className="text-visiyon-text-3 hover:text-visiyon-text"
                    title="Deliveries bekijken"
                  >
                    {expandedWebhookId === w.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {w.events.map((ev) => (
                  <span key={ev} className="text-[11px] text-visiyon-text-3 border border-visiyon-border rounded-full px-2 py-0.5">
                    {ev}
                  </span>
                ))}
              </div>

              {expandedWebhookId === w.id && (
                <div className="mt-3 pt-3 border-t border-visiyon-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] text-visiyon-text-3">Laatste deliveries</span>
                    <button
                      onClick={() => handleClearDeliveries(w.id)}
                      className="text-[11px] text-visiyon-text-3 hover:text-red-400"
                    >
                      Clear history
                    </button>
                  </div>
                  {loadingDeliveries && !deliveries[w.id] && (
                    <p className="text-[11px] text-visiyon-text-3">Loading...</p>
                  )}
                  {deliveries[w.id]?.length === 0 && (
                    <p className="text-[11px] text-visiyon-text-3">No deliveries yet.</p>
                  )}
                  <div className="space-y-1">
                    {deliveries[w.id]?.map((d) => (
                      <div key={d.id} className="flex items-center justify-between text-[11px]">
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                              d.status === "SUCCESS" ? "bg-emerald-400" : "bg-red-400"
                            }`}
                          />
                          <span className="text-visiyon-text-2 truncate">{d.event}</span>
                          {d.attempt > 1 && <span className="text-visiyon-text-3">(poging {d.attempt})</span>}
                        </span>
                        <span className="text-visiyon-text-3 shrink-0 ml-2">
                          {d.statusCode ?? d.error ?? "—"} · {new Date(d.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
