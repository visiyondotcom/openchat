import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { randomBytes } from "crypto";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { listModels, ollamaHealth, pullModelEverywhere, deleteModelEverywhere } from "../lib/ollama.js";
import { searxngHealth, invalidateWebSearchConfigCache } from "../lib/websearch.js";
import { invalidateInternetAccessConfigCache } from "../lib/internet-access.js";
import { getAnalyticsSummary, getAnalyticsTimeseries, getAnalyticsByModel, getAnalyticsByUser, getFunctionsUsage } from "../lib/analytics.js";
import { invalidateBillingConfigCache } from "../lib/billing.js";
import { invalidateSsoConfigCache } from "../lib/oidc.js";
import { invalidateImageGenConfigCache } from "../lib/images.js";
import { invalidateMemorySettingsCache } from "../lib/memory.js";
import { invalidateUploadLimitsCache } from "../lib/uploads.js";
import { invalidateMusicConfigCache } from "../lib/music.js";
import { invalidateKieGenConfigCache } from "../lib/kieGen.js";
import { invalidateVoiceConfigCache } from "../lib/voice.js";
import { invalidateQuotaConfigCache } from "../lib/quota.js";
import { getSystemStats } from "../lib/system.js";
import { MODEL_CATALOG } from "../lib/model-catalog.js";
import { sendInviteEmail } from "../lib/mail.js";
import { checkForUpdate, getUpdateStatus, triggerUpdate, releaseLockIfFinished } from "../lib/updates.js";

const WEBHOOK_EVENTS = [
  "USER_REGISTERED",
  "MESSAGE_SENT",
  "MESSAGE_FLAGGED",
  "PIPELINE_BLOCKED",
  "IMAGE_GENERATED",
] as const;

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  // ---- Dashboard summary ----
  app.get("/admin/dashboard", async () => {
    const [userCount, chatCount, messageCount, ollamaUp] = await Promise.all([
      app.prisma.user.count(),
      app.prisma.chat.count(),
      app.prisma.message.count(),
      ollamaHealth(),
    ]);
    return { userCount, chatCount, messageCount, ollamaUp };
  });

  // ---- Analytics: usage/token/cost monitoring across users and models.
  // `days` bounds the lookback window (default 30, capped at 365 so a
  // typo like days=99999 can't trigger a full-table scan). ----
  function parseDays(req: any): number {
    const raw = Number((req.query as any)?.days);
    if (!Number.isFinite(raw) || raw <= 0) return 30;
    return Math.min(Math.floor(raw), 365);
  }

  app.get("/admin/analytics/summary", async (req) => {
    return getAnalyticsSummary(app.prisma, parseDays(req));
  });

  app.get("/admin/analytics/timeseries", async (req) => {
    const rows = await getAnalyticsTimeseries(app.prisma, parseDays(req));
    return { rows };
  });

  app.get("/admin/analytics/by-model", async (req) => {
    const rows = await getAnalyticsByModel(app.prisma, parseDays(req));
    return { rows };
  });

  app.get("/admin/analytics/by-user", async (req) => {
    const rows = await getAnalyticsByUser(app.prisma, parseDays(req));
    return { rows };
  });

  // Lifetime "wasted tokens" — tokens spent on ASSISTANT replies that were
  // later discarded (regenerated, made stale by an edit, or thumbs-downed).
  // Not windowed by `days`: wastedTokens is a running lifetime counter on
  // the user row, so this is always the all-time total.
  app.get("/admin/analytics/wasted-tokens", async () => {
    const [agg, topUsers] = await Promise.all([
      app.prisma.user.aggregate({ _sum: { wastedTokens: true } }),
      app.prisma.user.findMany({
        where: { wastedTokens: { gt: 0 } },
        select: { id: true, email: true, name: true, wastedTokens: true },
        orderBy: { wastedTokens: "desc" },
        take: 20,
      }),
    ]);
    return { totalWastedTokens: agg._sum.wastedTokens ?? 0, topUsers };
  });

  // Health/usage snapshot for Filters/Pipes/Actions — separate from the
  // token/message analytics above since it's not a time-window
  // aggregation, just current state (enabled?, last run, last error).
  app.get("/admin/analytics/functions", async () => {
    return getFunctionsUsage(app.prisma);
  });

  // ---- Users list / role change / delete ----
  app.get("/admin/users", async () => {
    const users = await app.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        lastActiveAt: true,
        groupId: true,
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return { users };
  });

  app.patch("/admin/users/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const { role } = z.object({ role: z.enum(["USER", "ADMIN"]) }).parse(req.body);
    const user = await app.prisma.user.update({ where: { id: userId }, data: { role } });
    return { user };
  });

  // ---- Assign a user to a group (null = no group / unrestricted) ----
  app.patch("/admin/users/:userId/group", async (req) => {
    const { userId } = req.params as { userId: string };
    const { groupId } = z.object({ groupId: z.string().nullable() }).parse(req.body);
    const user = await app.prisma.user.update({
      where: { id: userId },
      data: { groupId },
      include: { group: true },
    });
    return { user };
  });

  // ---- Groups: list / create / update / delete ----
  app.get("/admin/groups", async () => {
    let groups = await app.prisma.group.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { users: true } } },
    });
    // Backfill for deployments that created group(s) before "default" was
    // wired up — pick the oldest one automatically rather than leaving
    // every signup unrestricted until an admin notices and clicks it.
    if (groups.length > 0 && !groups.some((g) => g.isDefault)) {
      await app.prisma.group.update({ where: { id: groups[0].id }, data: { isDefault: true } });
      groups = groups.map((g, i) => (i === 0 ? { ...g, isDefault: true } : g));
    }
    return { groups };
  });

  app.post("/admin/groups", async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        modelAccess: z.array(z.string()).optional(),
        dailyTokenQuota: z.number().int().positive().nullable().optional(),
        isDefault: z.boolean().optional(),
      })
      .parse(req.body);
    const { isDefault, ...rest } = body;
    const group = await app.prisma.$transaction(async (tx) => {
      const existingDefault = await tx.group.findFirst({ where: { isDefault: true } });
      // No group has ever been marked default yet — make this one it
      // automatically, so a brand-new deployment doesn't leave every
      // signup unrestricted just because nobody clicked "make default".
      const noDefaultYet = !existingDefault;
      const makeDefault = isDefault ?? noDefaultYet;
      if (makeDefault) await tx.group.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      return tx.group.create({
        data: { ...rest, modelAccess: rest.modelAccess ?? [], isDefault: makeDefault },
      });
    });
    return { group };
  });

  app.patch("/admin/groups/:groupId", async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        modelAccess: z.array(z.string()).optional(),
        dailyTokenQuota: z.number().int().positive().nullable().optional(),
        isDefault: z.boolean().optional(),
      })
      .parse(req.body);
    const group = await app.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) return reply.code(404).send({ error: "Not found" });
    const updated = await app.prisma.$transaction(async (tx) => {
      // Only one group can be the default new-signup group at a time —
      // flipping this one on flips every other one off.
      if (body.isDefault) await tx.group.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      return tx.group.update({ where: { id: groupId }, data: body });
    });
    return { group: updated };
  });

  app.delete("/admin/groups/:groupId", async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const group = await app.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) return reply.code(404).send({ error: "Not found" });
    // Users in this group fall back to unrestricted access (groupId → null)
    // via the relation's onDelete: SetNull, so this is safe to run directly.
    await app.prisma.group.delete({ where: { id: groupId } });
    return { ok: true };
  });

  app.delete("/admin/users/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    await app.prisma.user.delete({ where: { id: userId } });
    return { ok: true };
  });

  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // ---- Invites: pending/accepted/revoked invitations, listed alongside
  // Users so an admin can see who's been invited but hasn't joined yet. ----
  app.get("/admin/invites", async () => {
    const invites = await app.prisma.invite.findMany({
      orderBy: { createdAt: "desc" },
      include: { group: { select: { id: true, name: true } } },
    });
    return { invites };
  });

  app.post("/admin/invites", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        role: z.enum(["USER", "ADMIN"]).optional(),
        groupId: z.string().nullable().optional(),
      })
      .parse(req.body);

    const existingUser = await app.prisma.user.findUnique({ where: { email: body.email } });
    if (existingUser) return reply.code(409).send({ error: "A user with this email already exists" });

    // A prior pending invite to the same address is superseded rather than
    // stacked — keeps the list from accumulating duplicate rows for the
    // same person if an admin clicks "Invite" twice.
    await app.prisma.invite.updateMany({
      where: { email: body.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const token = randomBytes(32).toString("hex");
    const invite = await app.prisma.invite.create({
      data: {
        email: body.email,
        token,
        role: body.role ?? "USER",
        groupId: body.groupId ?? null,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      include: { group: { select: { id: true, name: true } } },
    });

    await sendInviteEmail(invite.email, token);
    return { invite };
  });

  app.post("/admin/invites/:inviteId/resend", async (req, reply) => {
    const { inviteId } = req.params as { inviteId: string };
    const invite = await app.prisma.invite.findUnique({ where: { id: inviteId } });
    if (!invite) return reply.code(404).send({ error: "Not found" });
    if (invite.acceptedAt || invite.revokedAt) {
      return reply.code(400).send({ error: "This invite is no longer pending" });
    }
    // Resending also refreshes the expiry and token — otherwise a "resend"
    // 6 days in would just re-send a link that's about to die anyway.
    const token = randomBytes(32).toString("hex");
    const updated = await app.prisma.invite.update({
      where: { id: inviteId },
      data: { token, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      include: { group: { select: { id: true, name: true } } },
    });
    await sendInviteEmail(updated.email, token);
    return { invite: updated };
  });

  app.delete("/admin/invites/:inviteId", async (req, reply) => {
    const { inviteId } = req.params as { inviteId: string };
    const invite = await app.prisma.invite.findUnique({ where: { id: inviteId } });
    if (!invite) return reply.code(404).send({ error: "Not found" });
    await app.prisma.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  // ---- AI memory (see lib/memory.ts) — lets an admin see and edit
  // exactly what the AI has learned/remembers about a given user, add
  // facts by hand, or wipe a user's memory entirely. ----
  app.get("/admin/users/:userId/memories", async (req) => {
    const { userId } = req.params as { userId: string };
    const memories = await app.prisma.userMemory.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return { memories };
  });

  app.post("/admin/users/:userId/memories", async (req) => {
    const { userId } = req.params as { userId: string };
    const { content } = z.object({ content: z.string().min(1).max(500) }).parse(req.body);
    const memory = await app.prisma.userMemory.create({ data: { userId, content, source: "admin" } });
    return { memory };
  });

  app.patch("/admin/users/:userId/memories/:memoryId", async (req, reply) => {
    const { userId, memoryId } = req.params as { userId: string; memoryId: string };
    const { content } = z.object({ content: z.string().min(1).max(500) }).parse(req.body);
    const existing = await app.prisma.userMemory.findFirst({ where: { id: memoryId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const memory = await app.prisma.userMemory.update({ where: { id: memoryId }, data: { content } });
    return { memory };
  });

  app.delete("/admin/users/:userId/memories/:memoryId", async (req, reply) => {
    const { userId, memoryId } = req.params as { userId: string; memoryId: string };
    const existing = await app.prisma.userMemory.findFirst({ where: { id: memoryId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.userMemory.delete({ where: { id: memoryId } });
    return { ok: true };
  });

  // Wipes every stored fact for this user in one go — used for a full
  // "forget everything about me" reset rather than deleting rows one by
  // one from the UI.
  app.delete("/admin/users/:userId/memories", async (req) => {
    const { userId } = req.params as { userId: string };
    await app.prisma.userMemory.deleteMany({ where: { userId } });
    return { ok: true };
  });

  // ---- Server / Ollama health ----
  // ---- Platform version, shown at the bottom of the admin sidebar.
  // APP_VERSION overrides the baked-in default (npm_package_version is only
  // populated when the process is started via an npm/yarn script, so it's
  // not relied on here). ----
  app.get("/admin/version", async () => {
    return { version: process.env.APP_VERSION || "2.0.0" };
  });

  // ---- Platform self-update (Admin > Updates) ----
  // See lib/updates.ts for the full flow. `force` on the check endpoint
  // bypasses the 1h Redis cache (used by the "check now" button); the
  // sidebar's background poll never forces so it can't be used to hammer
  // GitHub's API from a browser.
  app.get("/admin/updates/check", async (req) => {
    const force = (req.query as any)?.force === "true";
    return checkForUpdate(app, force);
  });

  app.get("/admin/updates/status", async () => {
    const status = await getUpdateStatus();
    await releaseLockIfFinished(app, status);
    return status;
  });

  app.post("/admin/updates/apply", async () => {
    return triggerUpdate(app);
  });

  app.get("/admin/health", async () => {
    const ollamaUp = await ollamaHealth();
    const searxngUp = await searxngHealth(app.prisma);
    let models: string[] = [];
    try {
      models = (await listModels()).map((m) => m.name);
    } catch {
      /* ollama down */
    }
    const system = await getSystemStats();
    return {
      ollama: { up: ollamaUp, models },
      searxng: { up: searxngUp },
      uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(),
      system,
    };
  });

  // ---- "Will it run?" catalog: scan GPUs, then say which popular models
  // actually fit, before the admin commits to a pull ----
  // Mirrors what a tool like willitrunai.com does, but scoped to Ollama tags
  // and this server's real, live VRAM (via nvidia-smi — see lib/system.ts)
  // instead of a generic spec-sheet calculator. Read-only: it never pulls
  // anything itself, it just annotates the catalog so the pull panel can
  // show a fit/no-fit badge next to each suggested model.
  app.get("/admin/models/catalog", async () => {
    const system = await getSystemStats();
    const gpus = system.gpus ?? [];
    // Free VRAM per GPU right now (total - currently used). A model only
    // needs to fit on ONE GPU — this deployment runs each Ollama instance
    // pinned to a single card (see OLLAMA_URLS in lib/ollama.ts), it never
    // splits one model's layers across two GPUs.
    const freeVramGB = gpus.map((g) => (g.memoryTotalBytes - g.memoryUsedBytes) / 1024 ** 3);
    const bestFreeVramGB = freeVramGB.length ? Math.max(...freeVramGB) : null;
    const totalVramGB = gpus.length ? Math.max(...gpus.map((g) => g.memoryTotalBytes / 1024 ** 3)) : null;

    const alreadyInstalled = new Set(
      await listModels()
        .then((ms) => ms.map((m) => m.name))
        .catch(() => [] as string[])
    );

    const models = MODEL_CATALOG.map((m) => {
      const installed = alreadyInstalled.has(m.tag);
      // "fits" is based on the biggest single GPU's *total* VRAM (would it
      // ever fit on this card), "fitsNow" additionally checks currently
      // free VRAM (would it fit given what's loaded/used right now).
      const fits = totalVramGB === null ? null : m.minVramGB <= totalVramGB;
      const fitsNow = bestFreeVramGB === null ? null : m.minVramGB <= bestFreeVramGB;
      return { ...m, installed, fits, fitsNow };
    });

    return {
      gpus: gpus.map((g, i) => ({
        index: g.index,
        name: g.name,
        totalVramGB: Math.round((g.memoryTotalBytes / 1024 ** 3) * 10) / 10,
        freeVramGB: Math.round((freeVramGB[i] ?? 0) * 10) / 10,
        utilizationPercent: g.utilizationPercent,
      })),
      // null (not empty array) when nvidia-smi isn't reachable from this
      // container at all, so the frontend can tell "no GPUs detected" apart
      // from "GPU stats unavailable" — see lib/system.ts's module comment.
      gpuStatsAvailable: system.gpus !== null,
      models,
    };
  });

  // ---- Pull / delete models directly from the admin panel ----
  app.post("/admin/models/pull", async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.body);
    // Pulls onto every configured Ollama instance (both GPUs), so the model
    // is actually available wherever the load balancer might route a chat.
    const result = await pullModelEverywhere(name);
    if (!result.ok) return reply.code(502).send({ error: "Pull failed", failed: result.failed });
    return { ok: true };
  });

  app.delete("/admin/models/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = await deleteModelEverywhere(name);
    if (!result.ok) return reply.code(502).send({ error: "Delete failed", failed: result.failed });
    return { ok: true };
  });

  // ---- Model display-name overrides ----
  // Lets an admin rename how a model shows up in the picker (e.g. "glm4:9b"
  // -> "GLM-4 9B") and optionally hide it, without touching Ollama. Returns
  // every override row, keyed by the raw model name — merged onto /models
  // in routes/models.ts.
  app.get("/admin/models/settings", async () => {
    const settings = await app.prisma.modelSetting.findMany({ orderBy: { name: "asc" } });
    return { settings };
  });

  // Upsert-by-name so "rename this model" (or edit its params) is a single
  // call whether or not an override already exists yet. All fields are
  // optional/partial — the "Model Params" modal only sends what changed,
  // and undefined keys are left untouched by Prisma's upsert `update`.
  // Model names can contain "/" (e.g. bundle/provider models like
  // "01-ai/yi-large") which breaks when passed as a URL path segment
  // through some proxies even when percent-encoded — so name travels in
  // the body/query instead of the path.
  app.put("/admin/models/settings", async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        displayName: z.string().trim().min(1).nullable().optional(),
        hidden: z.boolean().optional(),
        systemPrompt: z.string().nullable().optional(),
        // Free-form: whatever key/value pairs the modal's "Advanced
        // Params" section has set to non-Default (temperature, top_p,
        // num_ctx, seed, stop, max_tokens, ...). null clears it.
        params: z.record(z.any()).nullable().optional(),
        // Which of the chat toggles (webSearch, imageGeneration,
        // codeInterpreter) default to ON for a new chat on this model.
        defaultFeatures: z
          .object({
            webSearch: z.boolean().optional(),
            imageGeneration: z.boolean().optional(),
            codeInterpreter: z.boolean().optional(),
          })
          .nullable()
          .optional(),
        // Tool.id[] — built-in/HTTP tools auto-attached to every brand-new
        // chat on this model (Tools tab in the modal). null clears it.
        defaultToolIds: z.array(z.string()).nullable().optional(),
      })
      .parse(req.body);
    const { name } = body;
    // Json? fields need Prisma.JsonNull to actually clear them — a plain
    // `null` here isn't assignable (and would otherwise be ambiguous with
    // "field not sent" for an optional field).
    const paramsValue = body.params === null ? Prisma.JsonNull : body.params;
    const featuresValue = body.defaultFeatures === null ? Prisma.JsonNull : body.defaultFeatures;
    const toolIdsValue = body.defaultToolIds === null ? Prisma.JsonNull : body.defaultToolIds;
    const setting = await app.prisma.modelSetting.upsert({
      where: { name },
      create: {
        name,
        displayName: body.displayName ?? null,
        hidden: body.hidden ?? false,
        systemPrompt: body.systemPrompt ?? null,
        params: paramsValue ?? undefined,
        defaultFeatures: featuresValue ?? undefined,
        defaultToolIds: toolIdsValue ?? undefined,
      },
      update: {
        displayName: body.displayName,
        hidden: body.hidden,
        systemPrompt: body.systemPrompt,
        params: paramsValue,
        defaultFeatures: featuresValue,
        defaultToolIds: toolIdsValue,
      },
    });
    return { setting };
  });

  // Bulk hide/show — flips every model in a provider's bundle (can be 90+
  // models) in one request instead of firing dozens of parallel PUTs,
  // which was tripping Prisma's connection pool / rate limiting under
  // load and surfacing as "Could not update all models in this bundle".
  app.post("/admin/models/settings/bulk", async (req) => {
    const body = z
      .object({
        names: z.array(z.string().min(1)).min(1),
        hidden: z.boolean(),
      })
      .parse(req.body);
    const existing = await app.prisma.modelSetting.findMany({
      where: { name: { in: body.names } },
    });
    const displayNameByName = new Map(existing.map((s) => [s.name, s.displayName]));
    await app.prisma.$transaction(
      body.names.map((name) =>
        app.prisma.modelSetting.upsert({
          where: { name },
          create: { name, hidden: body.hidden, displayName: displayNameByName.get(name) ?? null },
          update: { hidden: body.hidden },
        })
      )
    );
    return { ok: true, count: body.names.length };
  });

  // Drop the override entirely, reverting the model back to its raw name.
  // name comes from the body (see PUT above) for the same "/" reason.
  app.delete("/admin/models/settings", async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const existing = await app.prisma.modelSetting.findUnique({ where: { name } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.modelSetting.delete({ where: { name } });
    return { ok: true };
  });

  // ---- App event log (auth failures, SSO errors, tool/document failures,
  // pipeline blocks/flags — see lib/logger.ts for what writes here). Not a
  // replacement for container-level log shipping (Loki/Dozzle etc still
  // makes sense for infra-level debugging), but covers what an admin needs
  // day to day without standing up an extra service. ----
  app.get("/admin/logs", async (req) => {
    const query = z
      .object({
        level: z.enum(["INFO", "WARN", "ERROR"]).optional(),
        source: z.string().optional(),
        limit: z.coerce.number().min(1).max(500).default(100),
      })
      .parse(req.query);

    const logs = await app.prisma.log.findMany({
      where: {
        level: query.level,
        source: query.source,
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });
    return { logs };
  });

  // Clear old logs. Kept manual (no auto-retention) so an admin decides
  // when history is no longer useful rather than silently losing it.
  app.delete("/admin/logs", async () => {
    await app.prisma.log.deleteMany({});
    return { ok: true };
  });

  // ---- Outbound webhooks: CRUD ----
  app.get("/admin/webhooks", async () => {
    const webhooks = await app.prisma.webhook.findMany({ orderBy: { createdAt: "desc" } });
    return { webhooks, availableEvents: WEBHOOK_EVENTS };
  });

  app.post("/admin/webhooks", async (req) => {
    const body = z
      .object({
        url: z.string().url(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    // Auto-generated — shown to the admin once on creation so they can
    // configure signature verification on the receiving end.
    const secret = randomBytes(24).toString("hex");
    const webhook = await app.prisma.webhook.create({
      data: { url: body.url, events: body.events, enabled: body.enabled ?? true, secret },
    });
    return { webhook };
  });

  app.patch("/admin/webhooks/:webhookId", async (req, reply) => {
    const { webhookId } = req.params as { webhookId: string };
    const body = z
      .object({
        url: z.string().url().optional(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const existing = await app.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const webhook = await app.prisma.webhook.update({ where: { id: webhookId }, data: body });
    return { webhook };
  });

  // Issue a new secret without recreating the webhook (its id/config stay put).
  app.post("/admin/webhooks/:webhookId/rotate-secret", async (req, reply) => {
    const { webhookId } = req.params as { webhookId: string };
    const existing = await app.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const secret = randomBytes(24).toString("hex");
    const webhook = await app.prisma.webhook.update({ where: { id: webhookId }, data: { secret } });
    return { webhook };
  });

  app.delete("/admin/webhooks/:webhookId", async (req, reply) => {
    const { webhookId } = req.params as { webhookId: string };
    const existing = await app.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.webhook.delete({ where: { id: webhookId } });
    return { ok: true };
  });

  // ---- Webhook delivery log ----
  // Every attempt (including the automatic retry) is recorded by
  // lib/webhooks.ts; this just surfaces that history per webhook, most
  // recent first, for the "view deliveries" expander in the admin panel.
  app.get("/admin/webhooks/:webhookId/deliveries", async (req, reply) => {
    const { webhookId } = req.params as { webhookId: string };
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const existing = await app.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const deliveries = await app.prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return { deliveries };
  });

  // Clear delivery history for one webhook. Kept manual, same reasoning as
  // /admin/logs — history grows unbounded otherwise and there's no
  // automatic retention here.
  app.delete("/admin/webhooks/:webhookId/deliveries", async (req, reply) => {
    const { webhookId } = req.params as { webhookId: string };
    const existing = await app.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.webhookDelivery.deleteMany({ where: { webhookId } });
    return { ok: true };
  });

  // Bulk cleanup across every webhook — deletes delivery rows older than
  // `days` (default 30, deliberately shorter than the quota-usage retention
  // since delivery logs are higher-volume and less useful once stale).
  app.delete("/admin/webhook-deliveries", async (req) => {
    const { days } = z.object({ days: z.coerce.number().min(1).max(3650).default(30) }).parse(req.query);
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const { count } = await app.prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return { ok: true, deleted: count };
  });

  // ---- Instance settings (Settings > General) ----
  // Upsert-on-read so a fresh install returns the schema defaults instead
  // of a 404 before anyone has ever saved the form.
  // Secrets (stripeSecretKey, stripeWebhookSecret) are never returned in
  // full once saved — same convention as api-keys.ts. The form shows a
  // masked placeholder; leaving it untouched (or sending back the masked
  // value) keeps the stored secret, an empty string clears it, and any
  // other value replaces it.
  function maskSecret(value: string | null): string | null {
    if (!value) return null;
    return value.length <= 8 ? "•".repeat(value.length) : `${value.slice(0, 4)}${"•".repeat(12)}${value.slice(-4)}`;
  }

  app.get("/admin/settings", async () => {
    const settings = await app.prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton" },
      update: {},
    });
    return {
      settings: {
        ...settings,
        stripeSecretKey: maskSecret(settings.stripeSecretKey),
        stripeWebhookSecret: maskSecret(settings.stripeWebhookSecret),
        musicGenApiKey: maskSecret(settings.musicGenApiKey),
        kieGenApiKey: maskSecret(settings.kieGenApiKey),
        ssoClientSecret: maskSecret(settings.ssoClientSecret),
        imageGenApiKey: maskSecret(settings.imageGenApiKey),
        stabilityApiKey: maskSecret(settings.stabilityApiKey),
        webSearchApiKey: maskSecret(settings.webSearchApiKey),
        voiceTtsApiKey: maskSecret(settings.voiceTtsApiKey),
      },
    };
  });

  app.patch("/admin/settings", async (req) => {
    const body = z
      .object({
        communitySharingEnabled: z.boolean().optional(),
        messageRatingEnabled: z.boolean().optional(),
        foldersEnabled: z.boolean().optional(),
        memoriesEnabled: z.boolean().optional(),
        memorySystemContextEnabled: z.boolean().optional(),
        notesEnabled: z.boolean().optional(),
        channelsEnabled: z.boolean().optional(),
        calendarEnabled: z.boolean().optional(),
        automationsEnabled: z.boolean().optional(),
        userWebhooksEnabled: z.boolean().optional(),
        userStatusEnabled: z.boolean().optional(),
        playgroundEnabled: z.boolean().optional(),
        studioEnabled: z.boolean().optional(),
        arenaEnabled: z.boolean().optional(),
        upgradeButtonEnabled: z.boolean().optional(),
        captchaEnabled: z.boolean().optional(),
        responseWatermark: z.string().nullable().optional(),
        webuiUrl: z.string().nullable().optional(),
        termsRequired: z.boolean().optional(),
        termsOfService: z.string().nullable().optional(),
        banners: z.array(z.object({
          id: z.string(),
          type: z.enum(["info", "warning", "error", "success"]).default("info"),
          content: z.string(),
          enabled: z.boolean().default(true),
        })).optional(),
        stripeSecretKey: z.string().nullable().optional(),
        stripePublishableKey: z.string().nullable().optional(),
        stripeWebhookSecret: z.string().nullable().optional(),
        musicGenEnabled: z.boolean().optional(),
        musicGenUrl: z.string().nullable().optional(),
        musicGenApiKey: z.string().nullable().optional(),
        musicGenModel: z.string().nullable().optional(),
        musicGenCallbackUrl: z.string().nullable().optional(),
        kieGenEnabled: z.boolean().optional(),
        kieGenUrl: z.string().nullable().optional(),
        kieGenApiKey: z.string().nullable().optional(),
        ssoEnabled: z.boolean().nullable().optional(),
        ssoProviderName: z.string().nullable().optional(),
        ssoIssuerUrl: z.string().nullable().optional(),
        ssoClientId: z.string().nullable().optional(),
        ssoClientSecret: z.string().nullable().optional(),
        ssoScopes: z.string().nullable().optional(),
        ssoRedirectUri: z.string().nullable().optional(),
        imageGenEnabled: z.boolean().nullable().optional(),
        imageGenProvider: z.enum(["custom", "selfhosted", "openai", "stability"]).nullable().optional(),
        imageGenUrl: z.string().nullable().optional(),
        imageGenApiKey: z.string().nullable().optional(),
        stabilityApiKey: z.string().nullable().optional(),
        webSearchEnabled: z.boolean().nullable().optional(),
        webSearchProvider: z.enum(["searxng"]).nullable().optional(),
        webSearchUrl: z.string().nullable().optional(),
        webSearchApiKey: z.string().nullable().optional(),
        internetAccessEnabled: z.boolean().nullable().optional(),
        voiceSttEnabled: z.boolean().nullable().optional(),
        voiceTtsEnabled: z.boolean().nullable().optional(),
        voiceTtsProvider: z.enum(["piper", "coqui", "kokoro", "elevenlabs"]).nullable().optional(),
        voiceTtsVoice: z.string().nullable().optional(),
        voiceTtsUrl: z.string().nullable().optional(),
        voiceTtsApiKey: z.string().nullable().optional(),
        defaultTokenQuota: z.coerce.number().int().positive().nullable().optional(),
        quotaWindowHours: z.coerce.number().int().positive().nullable().optional(),
        limitPopupTitle: z.string().nullable().optional(),
        limitPopupMessage: z.string().nullable().optional(),
        limitPopupButtonText: z.string().nullable().optional(),
        documentMaxUploadMb: z.coerce.number().int().positive().nullable().optional(),
        voiceMaxUploadMb: z.coerce.number().int().positive().nullable().optional(),
        avatarMaxUploadMb: z.coerce.number().int().positive().nullable().optional(),
        documentUploadEnabled: z.boolean().optional(),
        imageUploadEnabled: z.boolean().optional(),
        toolsMenuEnabled: z.boolean().optional(),
        cameraCaptureEnabled: z.boolean().optional(),
        screenShareEnabled: z.boolean().optional(),
        chatControlsButtonEnabled: z.boolean().optional(),
        apiKeysTabEnabled: z.boolean().optional(),
        greetingLogoEnabled: z.boolean().optional(),
        aiFaceAvatarEnabled: z.boolean().optional(),
        musicNavHidden: z.boolean().optional(),
        notifyBannerEnabled: z.boolean().optional(),
      })
      .parse(req.body);

    // A masked value (contains the bullet char) or empty string for a
    // secret field means "leave it as-is" / "field wasn't touched" —
    // drop it from the update rather than overwriting the real secret
    // with its own mask. Send an explicit null to actually clear it.
    for (const key of ["stripeSecretKey", "stripeWebhookSecret", "musicGenApiKey", "kieGenApiKey", "ssoClientSecret", "imageGenApiKey", "stabilityApiKey", "webSearchApiKey", "voiceTtsApiKey"] as const) {
      const v = body[key];
      if (typeof v === "string" && (v === "" || v.includes("•"))) delete body[key];
    }

    // upsert (not update) so this also works as the very first save, before
    // /admin/settings GET has ever run to create the singleton row.
    const settings = await app.prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...body, banners: body.banners ?? [] },
      update: { ...body, banners: body.banners ?? undefined },
    });
    // Bust billing.ts's in-memory cache immediately so a Stripe key
    // change (or rotation) takes effect on the very next request instead
    // of waiting out the cache TTL.
    if (
      body.stripeSecretKey !== undefined ||
      body.stripePublishableKey !== undefined ||
      body.stripeWebhookSecret !== undefined
    ) {
      invalidateBillingConfigCache();
    }
    if (
      body.musicGenEnabled !== undefined ||
      body.musicGenUrl !== undefined ||
      body.musicGenApiKey !== undefined ||
      body.musicGenModel !== undefined ||
      body.musicGenCallbackUrl !== undefined
    ) {
      invalidateMusicConfigCache();
    }
    if (body.kieGenEnabled !== undefined || body.kieGenUrl !== undefined || body.kieGenApiKey !== undefined) {
      invalidateKieGenConfigCache();
    }
    if (
      body.ssoEnabled !== undefined ||
      body.ssoProviderName !== undefined ||
      body.ssoIssuerUrl !== undefined ||
      body.ssoClientId !== undefined ||
      body.ssoClientSecret !== undefined ||
      body.ssoScopes !== undefined ||
      body.ssoRedirectUri !== undefined
    ) {
      invalidateSsoConfigCache();
    }
    if (
      body.imageGenEnabled !== undefined ||
      body.imageGenProvider !== undefined ||
      body.imageGenUrl !== undefined ||
      body.imageGenApiKey !== undefined ||
      body.stabilityApiKey !== undefined
    ) {
      invalidateImageGenConfigCache();
    }
    if (
      body.webSearchEnabled !== undefined ||
      body.webSearchProvider !== undefined ||
      body.webSearchUrl !== undefined ||
      body.webSearchApiKey !== undefined
    ) {
      invalidateWebSearchConfigCache();
    }
    if (body.internetAccessEnabled !== undefined) {
      invalidateInternetAccessConfigCache();
    }
    if (
      body.voiceSttEnabled !== undefined ||
      body.voiceTtsEnabled !== undefined ||
      body.voiceTtsProvider !== undefined ||
      body.voiceTtsVoice !== undefined ||
      body.voiceTtsUrl !== undefined ||
      body.voiceTtsApiKey !== undefined
    ) {
      invalidateVoiceConfigCache();
    }
    if (body.memoriesEnabled !== undefined || body.memorySystemContextEnabled !== undefined) {
      invalidateMemorySettingsCache();
    }
    if (
      body.defaultTokenQuota !== undefined ||
      body.quotaWindowHours !== undefined ||
      body.limitPopupTitle !== undefined ||
      body.limitPopupMessage !== undefined ||
      body.limitPopupButtonText !== undefined
    ) {
      invalidateQuotaConfigCache();
    }
    if (
      body.documentMaxUploadMb !== undefined ||
      body.voiceMaxUploadMb !== undefined ||
      body.avatarMaxUploadMb !== undefined ||
      body.documentUploadEnabled !== undefined ||
      body.imageUploadEnabled !== undefined ||
      body.toolsMenuEnabled !== undefined ||
      body.cameraCaptureEnabled !== undefined ||
      body.screenShareEnabled !== undefined ||
      body.greetingLogoEnabled !== undefined ||
      body.aiFaceAvatarEnabled !== undefined ||
      body.musicNavHidden !== undefined ||
      body.chatControlsButtonEnabled !== undefined ||
      body.apiKeysTabEnabled !== undefined
    ) {
      invalidateUploadLimitsCache();
    }
    return {
      settings: {
        ...settings,
        stripeSecretKey: maskSecret(settings.stripeSecretKey),
        stripeWebhookSecret: maskSecret(settings.stripeWebhookSecret),
        musicGenApiKey: maskSecret(settings.musicGenApiKey),
        kieGenApiKey: maskSecret(settings.kieGenApiKey),
        ssoClientSecret: maskSecret(settings.ssoClientSecret),
        imageGenApiKey: maskSecret(settings.imageGenApiKey),
        stabilityApiKey: maskSecret(settings.stabilityApiKey),
        webSearchApiKey: maskSecret(settings.webSearchApiKey),
        voiceTtsApiKey: maskSecret(settings.voiceTtsApiKey),
      },
    };
  });

  // ---- QuotaEvent cleanup ----
  // One row per generation event accumulates forever otherwise. Deletes
  // rows older than `days` (default 90) — well past anything the
  // rolling-window quota check itself ever reads, since that only ever
  // looks back QUOTA_WINDOW_HOURS (a few hours, not days).
  app.delete("/admin/quota-usage", async (req) => {
    const { days } = z.object({ days: z.coerce.number().min(1).max(3650).default(90) }).parse(req.query);
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const { count } = await app.prisma.quotaEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return { ok: true, deleted: count };
  });
}
