import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";

const candidateBody = z.object({
  order: z.number().int().min(0),
  enabled: z.boolean().optional(),
  kind: z.enum(["ollama", "provider"]),
  ollamaModel: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  providerModel: z.string().min(1).optional(),
});

const metaModelBody = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "Only lowercase letters, numbers and hyphens"),
  displayName: z.string().min(1),
  description: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  // How long (ms) between one candidate joining the race and the next —
  // see MetaModel.hedgeDelayMs / lib/meta-model.ts.
  hedgeDelayMs: z.number().int().min(0).max(30_000).optional(),
  candidates: z.array(candidateBody).min(1),
});

const metaModelUpdateBody = metaModelBody.partial().extend({
  candidates: z.array(candidateBody).optional(),
});

function toPublic(meta: {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  hedgeDelayMs: number;
  createdAt: Date;
  updatedAt: Date;
  candidates: {
    id: string;
    order: number;
    enabled: boolean;
    kind: string;
    ollamaModel: string | null;
    providerId: string | null;
    providerModel: string | null;
    provider: { id: string; name: string } | null;
  }[];
}) {
  return {
    id: meta.id,
    slug: meta.slug,
    displayName: meta.displayName,
    description: meta.description,
    enabled: meta.enabled,
    hedgeDelayMs: meta.hedgeDelayMs,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    candidates: meta.candidates
      .sort((a, b) => a.order - b.order)
      .map((c) => ({
        id: c.id,
        order: c.order,
        enabled: c.enabled,
        kind: c.kind,
        ollamaModel: c.ollamaModel,
        providerId: c.providerId,
        providerName: c.provider?.name ?? null,
        providerModel: c.providerModel,
      })),
  };
}

function validateCandidate(c: z.infer<typeof candidateBody>): string | null {
  if (c.kind === "ollama" && !c.ollamaModel) return "ollamaModel is required for kind=ollama";
  if (c.kind === "provider" && (!c.providerId || !c.providerModel)) {
    return "providerId and providerModel are required for kind=provider";
  }
  return null;
}

export default async function metaModelsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  const include = { candidates: { include: { provider: { select: { id: true, name: true } } } } };

  // ---- List ----
  app.get("/admin/meta-models", async () => {
    const metaModels = await app.prisma.metaModel.findMany({ orderBy: { slug: "asc" }, include });
    return { metaModels: metaModels.map(toPublic) };
  });

  // ---- Create ----
  app.post("/admin/meta-models", async (req, reply) => {
    const body = metaModelBody.parse(req.body);
    for (const c of body.candidates) {
      const err = validateCandidate(c);
      if (err) return reply.code(400).send({ error: err });
    }
    const existing = await app.prisma.metaModel.findUnique({ where: { slug: body.slug } });
    if (existing) return reply.code(409).send({ error: "A meta-model with this slug already exists" });

    const meta = await app.prisma.metaModel.create({
      data: {
        slug: body.slug,
        displayName: body.displayName,
        description: body.description ?? null,
        enabled: body.enabled ?? true,
        hedgeDelayMs: body.hedgeDelayMs ?? 800,
        candidates: {
          create: body.candidates.map((c) => ({
            order: c.order,
            enabled: c.enabled ?? true,
            kind: c.kind,
            ollamaModel: c.kind === "ollama" ? c.ollamaModel : null,
            providerId: c.kind === "provider" ? c.providerId : null,
            providerModel: c.kind === "provider" ? c.providerModel : null,
          })),
        },
      },
      include,
    });
    return { metaModel: toPublic(meta) };
  });

  // ---- Update (candidates, when included, fully replace the old list —
  // simplest way to keep ordering/removal correct without a diff dance) ----
  app.patch("/admin/meta-models/:metaModelId", async (req, reply) => {
    const { metaModelId } = req.params as { metaModelId: string };
    const body = metaModelUpdateBody.parse(req.body);
    const existing = await app.prisma.metaModel.findUnique({ where: { id: metaModelId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    if (body.candidates) {
      for (const c of body.candidates) {
        const err = validateCandidate(c);
        if (err) return reply.code(400).send({ error: err });
      }
    }

    const meta = await app.prisma.$transaction(async (tx) => {
      if (body.candidates) {
        await tx.metaModelCandidate.deleteMany({ where: { metaModelId } });
      }
      return tx.metaModel.update({
        where: { id: metaModelId },
        data: {
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.hedgeDelayMs !== undefined ? { hedgeDelayMs: body.hedgeDelayMs } : {}),
          ...(body.candidates
            ? {
                candidates: {
                  create: body.candidates.map((c) => ({
                    order: c.order,
                    enabled: c.enabled ?? true,
                    kind: c.kind,
                    ollamaModel: c.kind === "ollama" ? c.ollamaModel : null,
                    providerId: c.kind === "provider" ? c.providerId : null,
                    providerModel: c.kind === "provider" ? c.providerModel : null,
                  })),
                },
              }
            : {}),
        },
        include,
      });
    });
    return { metaModel: toPublic(meta) };
  });

  // ---- Delete ----
  app.delete("/admin/meta-models/:metaModelId", async (req, reply) => {
    const { metaModelId } = req.params as { metaModelId: string };
    const existing = await app.prisma.metaModel.findUnique({ where: { id: metaModelId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.metaModel.delete({ where: { id: metaModelId } });
    return { ok: true };
  });
}
