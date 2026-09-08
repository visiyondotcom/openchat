import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { encryptSecret, decryptSecret, maskSecret } from "../lib/crypto.js";
import { invalidateSsoConfigCache } from "../lib/oidc.js";

// Admin CRUD for the SsoProvider table — the "add another SSO login
// button (Microsoft AND Google AND ...)" feature. Deliberately mirrors
// routes/providers.ts (AiProvider CRUD) almost exactly, since it's the
// same shape of admin-managed external-credential record.

const providerBody = z.object({
  providerName: z.string().min(1),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().optional().nullable(),
  redirectUri: z.string().url().optional().nullable(),
  enabled: z.boolean().optional(),
});

// Partial update: clientSecret is optional here — omitting it keeps the
// currently-stored secret (so editing a provider's name doesn't force
// re-entering the secret every time).
const providerUpdateBody = providerBody.partial().extend({
  clientSecret: z.string().min(1).optional(),
});

function toPublic(provider: {
  id: string;
  providerName: string;
  issuerUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  scopes: string | null;
  redirectUri: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  let clientSecretPreview = "••••••••";
  try {
    clientSecretPreview = maskSecret(decryptSecret(provider.clientSecretEncrypted));
  } catch {
    // Leave the generic mask if decryption fails (e.g. key rotated) —
    // never throw just for a list view.
  }
  return {
    id: provider.id,
    providerName: provider.providerName,
    issuerUrl: provider.issuerUrl,
    clientId: provider.clientId,
    clientSecretPreview,
    scopes: provider.scopes,
    redirectUri: provider.redirectUri,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export default async function ssoProvidersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  // ---- List ----
  app.get("/admin/sso-providers", async () => {
    const providers = await app.prisma.ssoProvider.findMany({ orderBy: { providerName: "asc" } });
    return { providers: providers.map(toPublic) };
  });

  // ---- Create ----
  app.post("/admin/sso-providers", async (req, reply) => {
    const body = providerBody.parse(req.body);
    const existing = await app.prisma.ssoProvider.findUnique({ where: { providerName: body.providerName } });
    if (existing) return reply.code(409).send({ error: "A provider with this name already exists" });
    const provider = await app.prisma.ssoProvider.create({
      data: {
        providerName: body.providerName,
        issuerUrl: body.issuerUrl,
        clientId: body.clientId,
        clientSecretEncrypted: encryptSecret(body.clientSecret),
        scopes: body.scopes ?? null,
        redirectUri: body.redirectUri ?? null,
        enabled: body.enabled ?? true,
      },
    });
    invalidateSsoConfigCache();
    return { provider: toPublic(provider) };
  });

  // ---- Update ----
  app.patch("/admin/sso-providers/:providerId", async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const body = providerUpdateBody.parse(req.body);
    const existing = await app.prisma.ssoProvider.findUnique({ where: { id: providerId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const provider = await app.prisma.ssoProvider.update({
      where: { id: providerId },
      data: {
        ...(body.providerName !== undefined ? { providerName: body.providerName } : {}),
        ...(body.issuerUrl !== undefined ? { issuerUrl: body.issuerUrl } : {}),
        ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
        ...(body.clientSecret !== undefined ? { clientSecretEncrypted: encryptSecret(body.clientSecret) } : {}),
        ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
        ...(body.redirectUri !== undefined ? { redirectUri: body.redirectUri } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    });
    invalidateSsoConfigCache();
    return { provider: toPublic(provider) };
  });

  // ---- Delete ----
  app.delete("/admin/sso-providers/:providerId", async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const existing = await app.prisma.ssoProvider.findUnique({ where: { id: providerId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.ssoProvider.delete({ where: { id: providerId } });
    invalidateSsoConfigCache();
    return { ok: true };
  });
}
