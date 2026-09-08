import { createHmac, timingSafeEqual } from "crypto";
import type { PrismaClient } from "@prisma/client";

// Talks to Stripe's REST API directly with fetch rather than pulling in the
// stripe SDK — this is a handful of endpoints (checkout session, portal
// session, webhook signature check) and staying dependency-free keeps the
// backend's footprint small.

const STRIPE_API = "https://api.stripe.com/v1";

// ---- Config resolution ----
// Stripe config can come from Admin > Settings > Billing (stored on the
// AppSettings singleton row) or from STRIPE_* env vars. The DB value wins
// when set; a field left empty in the DB falls back to its env var, so an
// operator can mix — e.g. keys from env, plans from the admin UI.
//
// The DB read is cached in-memory for CACHE_TTL_MS so the hot paths
// (checkout, webhook verification, quota lookups) don't hit Postgres on
// every request. admin.ts calls invalidateBillingConfigCache() right
// after a save so a key rotation takes effect immediately instead of
// waiting out the TTL.

type BillingConfig = {
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: BillingConfig; expiresAt: number } | null = null;

export function invalidateBillingConfigCache(): void {
  cache = null;
}

async function loadConfig(prisma: PrismaClient): Promise<BillingConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    stripeSecretKey: string | null;
    stripePublishableKey: string | null;
    stripeWebhookSecret: string | null;
  } | null = null;
  try {
    row = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        stripeSecretKey: true,
        stripePublishableKey: true,
        stripeWebhookSecret: true,
      },
    });
  } catch {
    // Table/row not reachable (e.g. migration not run yet) — fall back
    // to env vars entirely rather than failing every billing call.
    row = null;
  }

  const value: BillingConfig = {
    secretKey: row?.stripeSecretKey || process.env.STRIPE_SECRET_KEY || null,
    publishableKey: row?.stripePublishableKey || process.env.STRIPE_PUBLISHABLE_KEY || null,
    webhookSecret: row?.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET || null,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function billingEnabled(prisma: PrismaClient): Promise<boolean> {
  const config = await loadConfig(prisma);
  return Boolean(config.secretKey);
}

async function secretKey(prisma: PrismaClient): Promise<string> {
  const config = await loadConfig(prisma);
  if (!config.secretKey) throw new Error("Billing is not configured (no Stripe secret key set in Admin > Settings or STRIPE_SECRET_KEY)");
  return config.secretKey;
}

async function stripeRequest(prisma: PrismaClient, path: string, params: Record<string, string>): Promise<any> {
  const key = await secretKey(prisma);
  const body = new URLSearchParams(params);
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe request to ${path} failed`);
  }
  return data;
}

async function stripeGet(prisma: PrismaClient, path: string, params: Record<string, string>): Promise<any> {
  const key = await secretKey(prisma);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${STRIPE_API}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe request to ${path} failed`);
  }
  return data;
}

// Recent invoices for a customer, for the Billing > Invoices tab. Mapped
// down to just what the UI needs rather than passing Stripe's full object
// through — keeps the frontend decoupled from Stripe's response shape.
export async function listInvoices(prisma: PrismaClient, customerId: string, limit = 24) {
  const data = await stripeGet(prisma, "/invoices", { customer: customerId, limit: String(limit) });
  return (data.data ?? []).map((inv: any) => ({
    id: inv.id as string,
    number: (inv.number as string | null) ?? null,
    status: inv.status as string,
    amountDue: inv.amount_due as number,
    amountPaid: inv.amount_paid as number,
    currency: inv.currency as string,
    created: inv.created as number,
    hostedInvoiceUrl: (inv.hosted_invoice_url as string | null) ?? null,
    invoicePdf: (inv.invoice_pdf as string | null) ?? null,
    periodStart: (inv.period_start as number | null) ?? null,
    periodEnd: (inv.period_end as number | null) ?? null,
  }));
}

export async function ensureStripeCustomer(prisma: PrismaClient, email: string, existingCustomerId?: string | null): Promise<string> {
  if (existingCustomerId) return existingCustomerId;
  const customer = await stripeRequest(prisma, "/customers", { email });
  return customer.id as string;
}

// One-time payment Checkout for buying a credits pack. amountCents is
// what the customer pays; creditsAmount is how many credits they receive
// (see routes/credits.ts CREDIT_PACKAGES for the actual €-per-credit rate).
export async function createCreditsCheckoutSession(prisma: PrismaClient, opts: {
  customerId: string;
  userId: string;
  amountCents: number;
  creditsAmount: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const session = await stripeRequest(prisma, "/checkout/sessions", {
    customer: opts.customerId,
    mode: "payment",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][product_data][name]": `${opts.creditsAmount} Visiyon credits`,
    "line_items[0][price_data][unit_amount]": String(opts.amountCents),
    "line_items[0][quantity]": "1",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    locale: "auto",
    billing_address_collection: "auto",
    // Read back out of the webhook (checkout.session.completed) to credit
    // the right account with the right amount — customer id alone isn't
    // enough since a customer can buy different-sized packs.
    "metadata[userId]": opts.userId,
    "metadata[creditsAmount]": String(opts.creditsAmount),
    "metadata[kind]": "credits_topup",
  });
  return session.url as string;
}

// Verifies Stripe's webhook signature manually (Stripe-Signature header is
// "t=<timestamp>,v1=<hex hmac>"). Avoids needing the SDK's crypto helper.
export async function verifyStripeSignature(prisma: PrismaClient, rawBody: Buffer, signatureHeader: string | undefined): Promise<boolean> {
  const config = await loadConfig(prisma);
  const secret = config.webhookSecret;
  if (!secret || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch {
    return false;
  }
}
