import { createHmac } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { logEvent } from "./logger.js";

// Fires an HMAC-signed POST to every enabled webhook subscribed to `event`.
// Fire-and-forget by design: webhook delivery must never slow down or fail
// the request that triggered it (a message send, a registration, etc.), so
// this is called without awaiting from route handlers and swallows its own
// errors (logging them instead).
//
// Each attempt (including the retry) is recorded as a WebhookDelivery row
// so the admin panel can show a per-webhook history of what fired and
// whether it eventually succeeded.
export async function dispatchWebhook(
  prisma: PrismaClient,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: { enabled: true, events: { has: event as any } },
    });
    if (webhooks.length === 0) return;

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    await Promise.all(webhooks.map((webhook) => deliverWithRetry(prisma, webhook, event, body)));
  } catch (err) {
    // Even looking up the webhook list must never throw into the caller.
    logEvent(prisma, "ERROR", "webhook", `dispatchWebhook failed for ${event}: ${err}`);
  }
}

// One attempt, then — if it failed — a single retry after a short backoff.
// Every attempt is logged to WebhookDelivery regardless of outcome.
async function deliverWithRetry(
  prisma: PrismaClient,
  webhook: { id: string; url: string; secret: string },
  event: string,
  body: string
): Promise<void> {
  const MAX_ATTEMPTS = 2;
  const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Visiyon-Event": event,
          "X-Visiyon-Signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        await logDelivery(prisma, webhook.id, event, "SUCCESS", res.status, null, attempt);
        return;
      }

      await logDelivery(prisma, webhook.id, event, "FAILED", res.status, `HTTP ${res.status}`, attempt);
      logEvent(prisma, "WARN", "webhook", `Webhook ${webhook.id} responded ${res.status} for ${event} (attempt ${attempt})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logDelivery(prisma, webhook.id, event, "FAILED", null, message, attempt);
      logEvent(prisma, "WARN", "webhook", `Webhook ${webhook.id} delivery failed for ${event} (attempt ${attempt}): ${message}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      // Brief backoff before the single retry — long enough to ride out a
      // transient blip on the receiving end, short enough not to matter
      // since this whole path is already fire-and-forget.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function logDelivery(
  prisma: PrismaClient,
  webhookId: string,
  event: string,
  status: "SUCCESS" | "FAILED",
  statusCode: number | null,
  error: string | null,
  attempt: number
): Promise<void> {
  try {
    await prisma.webhookDelivery.create({
      data: { webhookId, event: event as any, status, statusCode, error, attempt },
    });
  } catch (err) {
    // Logging the delivery must never throw into the retry loop.
    logEvent(prisma, "ERROR", "webhook", `Failed to record delivery for webhook ${webhookId}: ${err}`);
  }
}
