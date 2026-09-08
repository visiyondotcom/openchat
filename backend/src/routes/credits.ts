import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { billingEnabled, ensureStripeCustomer, createCreditsCheckoutSession } from "../lib/billing.js";
import { getCredits } from "../lib/credits.js";
import { logEvent } from "../lib/logger.js";

// Fixed packs, €1 = 100 credits (matches the €0.01/credit convention in
// lib/mediaCost.ts). Larger packs are priced very slightly cheaper per
// credit as a normal volume discount — still comfortably above cost for
// every model in mediaCost.ts.
export const CREDIT_PACKAGES: { credits: number; amountCents: number }[] = [
  { credits: 500, amountCents: 500 }, // €5.00
  { credits: 1200, amountCents: 1000 }, // €10.00 (small bonus)
  { credits: 3000, amountCents: 2000 }, // €20.00
  { credits: 8000, amountCents: 4000 }, // €40.00
];

export default async function creditsRoutes(app: FastifyInstance) {
  app.get("/credits/config", async () => {
    return { enabled: await billingEnabled(app.prisma), packages: CREDIT_PACKAGES };
  });

  app.get("/credits/balance", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    return { credits: await getCredits(app.prisma, userId) };
  });

  app.post("/credits/checkout", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Payments are not configured on this server yet." });
    const { id: userId, email } = req.user as { id: string; email: string };
    const { amountCents } = z.object({ amountCents: z.number() }).parse(req.body);

    const pack = CREDIT_PACKAGES.find((p) => p.amountCents === amountCents);
    if (!pack) return reply.code(400).send({ error: "Invalid credit package." });

    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "Not found" });

    try {
      const customerId = await ensureStripeCustomer(app.prisma, email, user.stripeCustomerId);
      if (customerId !== user.stripeCustomerId) {
        await app.prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
      }
      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost").replace(/\/$/, "");
      const url = await createCreditsCheckoutSession(app.prisma, {
        customerId,
        userId,
        amountCents: pack.amountCents,
        creditsAmount: pack.credits,
        successUrl: `${frontendUrl}/generate?credits=success&amount=${pack.credits}`,
        cancelUrl: `${frontendUrl}/generate?credits=cancelled`,
      });
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent(app.prisma, "ERROR", "credits", `Credits checkout failed for ${email}: ${message}`);
      return reply.code(502).send({ error: message });
    }
  });
}
