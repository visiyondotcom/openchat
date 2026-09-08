import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/jwt.js";
import {
  billingEnabled,
  verifyStripeSignature,
  listInvoices,
} from "../lib/billing.js";
import { logEvent } from "../lib/logger.js";

export default async function billingRoutes(app: FastifyInstance) {
  // ---- Whether billing is configured at all — the frontend uses this to
  // decide whether to show the "Buy credits" UI. ----
  app.get("/billing/config", async () => {
    const enabled = await billingEnabled(app.prisma);

    // Admin-customized "you reached the limit" popup copy (Admin >
    // Settings > Usage limits). Public/no-auth on purpose — the modal
    // that shows this text is seen by regular users, not just admins.
    // Null fields fall back to the frontend's hardcoded English defaults,
    // so an unconfigured deployment looks unchanged.
    let limitPopup: { title: string | null; message: string | null; buttonText: string | null } = {
      title: null,
      message: null,
      buttonText: null,
    };
    try {
      const row = await app.prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { limitPopupTitle: true, limitPopupMessage: true, limitPopupButtonText: true },
      });
      if (row) {
        limitPopup = {
          title: row.limitPopupTitle,
          message: row.limitPopupMessage,
          buttonText: row.limitPopupButtonText,
        };
      }
    } catch {
      // migration not run yet — just fall back to defaults
    }

    return { enabled, limitPopup };
  });

  app.get("/billing/status", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Billing is not configured on this server." });
    const { id: userId } = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "Not found" });
    return {
      hasCustomer: Boolean(user.stripeCustomerId),
    };
  });

  app.get("/billing/invoices", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Billing is not configured on this server." });
    const { id: userId } = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.stripeCustomerId) return { invoices: [] };
    try {
      const invoices = await listInvoices(app.prisma, user.stripeCustomerId);
      return { invoices };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  // ---- Stripe webhook receiver ----
  // Needs the raw request body (Buffer) to verify Stripe's signature; see
  // the global content-type parser in index.ts, which stashes it on
  // req.rawBody for every request before JSON-parsing it.
  //
  // Only handles one-time credits purchases (routes/credits.ts, mode:
  // "payment") now — the recurring-subscription plan system has been
  // removed, so subscription.* / invoice.payment_failed events are no
  // longer handled here.
  app.post("/billing/webhook", async (req, reply) => {
    const signature = req.headers["stripe-signature"] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!rawBody || !(await verifyStripeSignature(app.prisma, rawBody, signature))) {
      return reply.code(400).send({ error: "Invalid signature" });
    }

    const event = req.body as { type: string; data: { object: any } };
    const obj = event.data.object;

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          // sessionId is unique on CreditTopup so a duplicate webhook
          // delivery (Stripe retries on any non-2xx) can never credit the
          // same purchase twice.
          if (obj.metadata?.kind === "credits_topup") {
            const userId: string | undefined = obj.metadata?.userId;
            const creditsAmount = Number(obj.metadata?.creditsAmount);
            if (userId && Number.isFinite(creditsAmount) && creditsAmount > 0 && obj.payment_status === "paid") {
              const already = await app.prisma.creditTopup.findUnique({ where: { sessionId: obj.id } });
              if (!already) {
                await app.prisma.$transaction([
                  app.prisma.user.update({ where: { id: userId }, data: { credits: { increment: creditsAmount } } }),
                  app.prisma.creditTopup.create({
                    data: { sessionId: obj.id, userId, credits: creditsAmount, amountCents: obj.amount_total ?? 0 },
                  }),
                ]);
                logEvent(app.prisma, "INFO", "credits", `Credited ${creditsAmount} credits to user ${userId} (session ${obj.id})`);
              }
            }
          }
          break;
        }
        default:
          break; // ignore events we don't act on
      }
    } catch (err) {
      logEvent(app.prisma, "ERROR", "billing", `Webhook handling failed for ${event.type}: ${err}`);
    }

    return { received: true };
  });
}
