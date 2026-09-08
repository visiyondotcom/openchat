import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../lib/jwt.js";
import { setSessionCookie, clearSessionCookie } from "../lib/session-cookie.js";
import {
  listSsoProviders,
  ssoRedirectUriFor,
  generateState,
  buildAuthorizationUrl,
  exchangeCodeForProfile,
} from "../lib/oidc.js";
import { sendPasswordResetEmail, mailEnabled } from "../lib/mail.js";
import { logEvent } from "../lib/logger.js";
import { reportSiteEvent } from "../lib/fraudGuardReport.js";
import { dispatchWebhook } from "../lib/webhooks.js";
import { getTodayUsage, getUsageHistory } from "../lib/quota.js";
import { memoriesEnabled } from "../lib/memory.js";
import {
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
} from "../lib/totp.js";
import { generateCaptchaChallenge, verifyCaptcha } from "../lib/captcha.js";
import { loadUploadLimits } from "../lib/uploads.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  acceptedTerms: z.boolean().optional(),
  captchaToken: z.string().optional(),
  captchaX: z.number().optional(),
  captchaElapsedMs: z.number().optional(),
  // Present when registering from an admin-sent invite link
  // (/register?invite=...) — see GET /auth/invites/:token below. Its
  // email/role/group override the signup-enabled gate and captcha, since
  // the invite itself is the admin's approval.
  inviteToken: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  captchaToken: z.string().optional(),
  captchaX: z.number().optional(),
  captchaElapsedMs: z.number().optional(),
});

export default async function authRoutes(app: FastifyInstance) {
  // ---- Signup toggle: admins can disable public registration from the
  // admin panel without a redeploy. Stored in Redis (same pattern as the
  // SSO state tokens below) rather than the DB so there's no migration
  // needed; defaults to enabled when the key has never been set. ----
  const SIGNUP_FLAG_KEY = "config:signup_enabled";

  app.get("/auth/public-config", async () => {
    const flag = await app.redis.get(SIGNUP_FLAG_KEY);
    // Banners are admin-configured under Settings > General, but that
    // endpoint is admin-only, so unauthenticated/regular users never saw
    // them. Surface just the enabled ones (never the Stripe keys etc. that
    // live on the same settings row) here so every visitor can read them.
    const appSettings = await app.prisma.appSettings.findUnique({ where: { id: "singleton" } });
    const banners = ((appSettings?.banners as { id: string; type: string; content: string; enabled: boolean }[] | null) ?? [])
      .filter((b) => b.enabled && b.content?.trim());
    return {
      signupEnabled: flag !== "0",
      sso: { providers: await listSsoProviders(app.prisma) },
      banners,
      terms: {
        required: appSettings?.termsRequired ?? false,
        content: appSettings?.termsOfService ?? "",
      },
      // Sidebar/nav + header visibility toggles from Admin > Settings >
      // General ("Sidebar & navigation"). Booleans default to true (via
      // the Prisma column defaults) so an existing deployment shows
      // everything until an admin opts out; a fresh singleton row hasn't
      // been created yet on a brand-new deploy, hence the ?? true fallback
      // here too.
      features: {
        playground: appSettings?.playgroundEnabled ?? true,
        studio: appSettings?.studioEnabled ?? true,
        arena: appSettings?.arenaEnabled ?? true,
        music: (appSettings?.musicGenEnabled ?? false) && !(appSettings?.musicNavHidden ?? false),
        generate: appSettings?.kieGenEnabled ?? false,
        channels: appSettings?.channelsEnabled ?? true,
        notes: appSettings?.notesEnabled ?? true,
        automations: appSettings?.automationsEnabled ?? true,
        upgradeButton: appSettings?.upgradeButtonEnabled ?? true,
        documentUpload: appSettings?.documentUploadEnabled ?? true,
        imageUpload: appSettings?.imageUploadEnabled ?? true,
        toolsMenu: appSettings?.toolsMenuEnabled ?? true,
        cameraCapture: appSettings?.cameraCaptureEnabled ?? true,
        screenShare: appSettings?.screenShareEnabled ?? true,
        greetingLogo: appSettings?.greetingLogoEnabled ?? true,
        aiFaceAvatar: appSettings?.aiFaceAvatarEnabled ?? true,
        notifyBanner: appSettings?.notifyBannerEnabled ?? true,
        chatControlsButton: appSettings?.chatControlsButtonEnabled ?? true,
        apiKeysTab: appSettings?.apiKeysTabEnabled ?? true,
      },
      captcha: { enabled: appSettings?.captchaEnabled ?? false },
    };
  });

  // Public: issue a new puzzle-slider challenge. No auth required (it has
  // to be solvable before the user has an account/session) and no
  // rate-limit config here — each attempt at /auth/login or
  // /auth/register consumes exactly one challenge, so their existing
  // rate limits already cap how many of these get requested.
  app.get("/auth/captcha/challenge", async () => {
    // targetX is included in cleartext — the frontend needs it to draw
    // the notch the user drags the piece into, so hiding it would just
    // break the UI without adding security. What actually protects this
    // is the signed token (can't be forged), the single-use Redis guard,
    // and the elapsed-time bounds (see verifyCaptcha).
    return generateCaptchaChallenge();
  });

  app.post("/admin/config/signup", { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await app.redis.set(SIGNUP_FLAG_KEY, enabled ? "1" : "0");
    return { signupEnabled: enabled };
  });

  // ---- Public invite lookup — the register page hits this with the
  // ?invite= token from the email link to prefill/lock the email field
  // before the person submits anything. Deliberately returns only the
  // email, never the invite's role/group (those are applied server-side
  // during actual registration, not something the client should see). ----
  app.get("/auth/invites/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const invite = await app.prisma.invite.findUnique({ where: { token } });
    if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt < new Date()) {
      return reply.code(404).send({ error: "This invite link is invalid or has expired." });
    }
    return { email: invite.email };
  });

  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { email, password, name, acceptedTerms, captchaToken, captchaX, captchaElapsedMs, inviteToken } =
      parsed.data;

    // An invite is the admin's own approval to join, so a valid one
    // bypasses the signup-enabled gate, captcha, and terms gate below —
    // none of those exist to stop someone the admin explicitly invited.
    let invite: Awaited<ReturnType<typeof app.prisma.invite.findUnique>> = null;
    if (inviteToken) {
      invite = await app.prisma.invite.findUnique({ where: { token: inviteToken } });
      if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt < new Date()) {
        return reply.code(400).send({ error: "This invite link is invalid or has expired." });
      }
      if (invite.email !== email) {
        return reply.code(400).send({ error: "This invite was issued for a different email address." });
      }
    }

    if (!invite) {
      const flag = await app.redis.get(SIGNUP_FLAG_KEY);
      const userCountForGate = await app.prisma.user.count();
      // Always allow the very first account (bootstrapping a fresh install)
      // even if signup was somehow left disabled — otherwise no one could
      // ever create the initial admin user.
      if (flag === "0" && userCountForGate > 0) {
        return reply.code(403).send({ error: "Sign-ups are currently disabled by the administrator." });
      }
    }

    const appSettings = await app.prisma.appSettings.findUnique({ where: { id: "singleton" } });

    if (!invite && appSettings?.captchaEnabled) {
      const result = await verifyCaptcha(app.redis, captchaToken, captchaX, captchaElapsedMs);
      if (!result.ok) return reply.code(400).send({ error: result.reason || "Captcha verification failed" });
    }

    if (!invite && appSettings?.termsRequired && !acceptedTerms) {
      return reply.code(400).send({ error: "You must accept the Terms of Service to continue." });
    }

    const existing = await app.prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "Email already registered" });

    // First user ever created becomes admin automatically.
    const userCount = await app.prisma.user.count();
    const passwordHash = await bcrypt.hash(password, 12);
    const role = userCount === 0 ? "ADMIN" : invite ? invite.role : "USER";

    // Every other new signup lands in whichever group an admin has marked
    // as the default — otherwise a fresh account has no group at all and
    // gets unrestricted access until someone remembers to assign one by
    // hand. The first (bootstrap admin) account is deliberately excluded.
    // An invite's own groupId takes priority over the default when set.
    const defaultGroup =
      role === "USER" && !invite ? await app.prisma.group.findFirst({ where: { isDefault: true } }) : null;
    const groupId = invite ? invite.groupId : defaultGroup?.id;

    const user = await app.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          role,
          groupId,
          termsAcceptedAt: acceptedTerms ? new Date() : null,
        },
      });
      if (invite) {
        await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      }
      // Attach any Studio project shares that were sent to this email
      // before the account existed (see routes/studio.ts POST .../members).
      await tx.projectMember.updateMany({
        where: { email: created.email.toLowerCase(), userId: null },
        data: { userId: created.id },
      });
      return created;
    });

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    setSessionCookie(reply, token);
    dispatchWebhook(app.prisma, "USER_REGISTERED", { userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { email, password, captchaToken, captchaX, captchaElapsedMs } = parsed.data;

    const appSettings = await app.prisma.appSettings.findUnique({ where: { id: "singleton" } });
    if (appSettings?.captchaEnabled) {
      const result = await verifyCaptcha(app.redis, captchaToken, captchaX, captchaElapsedMs);
      if (!result.ok) return reply.code(400).send({ error: result.reason || "Captcha verification failed" });
    }

    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      logEvent(app.prisma, "WARN", "auth", `Failed login attempt for ${email}`);
      reportSiteEvent("login_failed", req, { email });
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      logEvent(app.prisma, "WARN", "auth", `Failed login attempt for ${email}`);
      reportSiteEvent("login_failed", req, { email });
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    if (user.twoFaEnabled) {
      // Short-lived, single-purpose token: proves the password step passed
      // without granting a real session. Only /auth/2fa/verify accepts it.
      const preAuthToken = app.jwt.sign({ id: user.id, purpose: "2fa" }, { expiresIn: "10m" });
      return { twoFaRequired: true, preAuthToken };
    }

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    setSessionCookie(reply, token);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  // Second step of login when the account has 2FA enabled. Accepts either
  // a current 6-digit TOTP code or a one-time backup code.
  app.post(
    "/auth/2fa/verify",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { preAuthToken, code } = z
        .object({ preAuthToken: z.string(), code: z.string() })
        .parse(req.body);

      let payload: { id: string; purpose: string };
      try {
        payload = app.jwt.verify(preAuthToken) as any;
        if (payload.purpose !== "2fa") throw new Error("bad token");
      } catch {
        return reply.code(400).send({ error: "Invalid or expired login session, please log in again" });
      }

      const user = await app.prisma.user.findUnique({ where: { id: payload.id } });
      if (!user || !user.twoFaEnabled || !user.twoFaSecret) {
        return reply.code(400).send({ error: "2FA is not enabled on this account" });
      }

      const validTotp = verifyTotpCode(user.twoFaSecret, code);
      const hashedInput = hashBackupCode(code);
      const backupIndex = user.twoFaBackupCodes.indexOf(hashedInput);

      if (!validTotp && backupIndex === -1) {
        logEvent(app.prisma, "WARN", "auth", `Failed 2FA verification for ${user.email}`);
        return reply.code(401).send({ error: "Invalid code" });
      }

      // Consume the backup code so it can't be reused.
      if (!validTotp && backupIndex !== -1) {
        const remaining = [...user.twoFaBackupCodes];
        remaining.splice(backupIndex, 1);
        await app.prisma.user.update({ where: { id: user.id }, data: { twoFaBackupCodes: remaining } });
      }

      const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
      setSessionCookie(reply, token);
      return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    }
  );

  // Clears the shared cookie server-side. Doesn't invalidate the JWT
  // itself (there's no server-side token blocklist), so a copy still held
  // in localStorage from before this change stays valid until it expires
  // — this only stops the cookie from re-authenticating future requests.
  app.post("/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (req) => {
    const jwtUser = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: jwtUser.id } });
    if (!user) return { user: null };
    // When ADMIN_2FA_REQUIRED is set, admins without 2FA enabled yet get
    // flagged here so the frontend can show a persistent "set up 2FA" nag.
    // Deliberately not enforced at the login step itself — locking an admin
    // out entirely the moment this env var is flipped (before they've had a
    // chance to enroll) would be a self-inflicted lockout with no recovery
    // path other than direct DB access.
    const twoFaSetupRequired =
      user.role === "ADMIN" && !user.twoFaEnabled && process.env.ADMIN_2FA_REQUIRED === "true";
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatarUrl: user.avatarUrl,
        twoFaEnabled: user.twoFaEnabled,
        twoFaSetupRequired,
        onboardingSeenAt: user.onboardingSeenAt,
      },
    };
  });

  // ---- Profile photo ----
  // Stored as a base64 data URL directly on the user row — same pattern
  // used for chat-attached images (lib/images.ts) — so no static file
  // server needs to be stood up just for this.
  const AVATAR_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

  app.post("/auth/me/avatar", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { avatarMaxUploadBytes } = await loadUploadLimits(app.prisma);
    const file = await req.file({ limits: { fileSize: avatarMaxUploadBytes } });
    if (!file) return reply.code(400).send({ error: "No file uploaded" });

    if (!AVATAR_ALLOWED_MIME.has(file.mimetype)) {
      return reply.code(415).send({ error: "Unsupported file type. Upload a PNG, JPEG, WEBP, or GIF." });
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "Empty file" });
    if (file.file.truncated) {
      return reply.code(413).send({
        error: `Image is too large. Max ${(avatarMaxUploadBytes / 1024 / 1024).toFixed(0)}MB.`,
      });
    }

    const avatarUrl = `data:${file.mimetype};base64,${buffer.toString("base64")}`;
    const user = await app.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return { avatarUrl: user.avatarUrl };
  });

  app.delete("/auth/me/avatar", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    await app.prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    return { ok: true };
  });

  // Marks the onboarding modal as dismissed so it never shows again for
  // this user. Idempotent — calling it twice just keeps the first timestamp.
  app.post("/auth/onboarding-seen", { preHandler: requireAuth }, async (req) => {
    const jwtUser = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: jwtUser.id } });
    if (user && !user.onboardingSeenAt) {
      await app.prisma.user.update({ where: { id: jwtUser.id }, data: { onboardingSeenAt: new Date() } });
    }
    return { ok: true };
  });

  // ---- AI memory, self-service (see lib/memory.ts) — lets a user see and
  // edit exactly what the AI has learned/remembers about them, add facts by
  // hand, or wipe their own memory entirely, from Settings > Memory. Same
  // shape as the admin-only /admin/users/:userId/memories endpoints, scoped
  // to the logged-in user instead of an arbitrary :userId param. Returns 403
  // when an admin has turned the feature off platform-wide.
  app.get("/auth/me/memories", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    if (!(await memoriesEnabled(app.prisma))) return reply.code(403).send({ error: "Memory is disabled on this server." });
    const memories = await app.prisma.userMemory.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return { memories };
  });

  app.post("/auth/me/memories", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    if (!(await memoriesEnabled(app.prisma))) return reply.code(403).send({ error: "Memory is disabled on this server." });
    const { content } = z.object({ content: z.string().min(1).max(500) }).parse(req.body);
    const memory = await app.prisma.userMemory.create({ data: { userId, content, source: "user" } });
    return { memory };
  });

  app.patch("/auth/me/memories/:memoryId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    if (!(await memoriesEnabled(app.prisma))) return reply.code(403).send({ error: "Memory is disabled on this server." });
    const { memoryId } = req.params as { memoryId: string };
    const { content } = z.object({ content: z.string().min(1).max(500) }).parse(req.body);
    const existing = await app.prisma.userMemory.findFirst({ where: { id: memoryId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const memory = await app.prisma.userMemory.update({ where: { id: memoryId }, data: { content } });
    return { memory };
  });

  app.delete("/auth/me/memories/:memoryId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    if (!(await memoriesEnabled(app.prisma))) return reply.code(403).send({ error: "Memory is disabled on this server." });
    const { memoryId } = req.params as { memoryId: string };
    const existing = await app.prisma.userMemory.findFirst({ where: { id: memoryId, userId } });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.userMemory.delete({ where: { id: memoryId } });
    return { ok: true };
  });

  app.delete("/auth/me/memories", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    if (!(await memoriesEnabled(app.prisma))) return reply.code(403).send({ error: "Memory is disabled on this server." });
    await app.prisma.userMemory.deleteMany({ where: { userId } });
    return { ok: true };
  });

  // Today's message/image counts plus the user's group quota (if any), for
  // the "Usage today" widget on the Settings page. Returns null limits when
  // the user has no group or the group has no quota set, so the frontend
  // can hide the widget entirely rather than show "0 / unlimited".
  app.get("/usage/today", { preHandler: requireAuth }, async (req) => {
    const { id: userId } = req.user as { id: string };
    return getTodayUsage(app.prisma, userId);
  });

  // Bucketed usage over time for the Usage & Analytics chart on the
  // Settings page — day (24x1h), month (30x1d), or year (12x1mo).
  app.get("/usage/history", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const q = z.object({ range: z.enum(["day", "month", "year"]).default("day") }).parse(req.query);
    return { range: q.range, buckets: await getUsageHistory(app.prisma, userId, q.range) };
  });

  // ---- 2FA enrollment (Settings page) ----
  // Step 1: generate a secret + otpauth URI for the authenticator app to
  // scan. Not yet enabled — nothing changes until /2fa/enable confirms a
  // code, so an abandoned setup never locks the account out.
  app.post("/auth/2fa/setup", { preHandler: requireAuth }, async (req) => {
    const { id: userId, email } = req.user as { id: string; email: string };
    const secret = generateTotpSecret();
    await app.prisma.user.update({ where: { id: userId }, data: { twoFaSecret: secret } });
    return { secret, otpauthUrl: buildTotpUri(secret, email) };
  });

  // Step 2: confirm the user's authenticator app is actually working by
  // verifying a live code, then flip twoFaEnabled and hand back backup codes.
  app.post("/auth/2fa/enable", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFaSecret) return reply.code(400).send({ error: "Call /auth/2fa/setup first" });
    if (!verifyTotpCode(user.twoFaSecret, code)) {
      return reply.code(400).send({ error: "Invalid code" });
    }
    const backupCodes = generateBackupCodes();
    await app.prisma.user.update({
      where: { id: userId },
      data: { twoFaEnabled: true, twoFaBackupCodes: backupCodes.map(hashBackupCode) },
    });
    logEvent(app.prisma, "INFO", "auth", `2FA enabled for ${user.email}`);
    return { ok: true, backupCodes };
  });

  // Issue a fresh set of backup codes, invalidating any old ones — for when
  // a user has used most of them up or lost the ones they saved. Requires
  // the current password (same safeguard as disabling 2FA) since this is a
  // security-relevant action; 2FA itself stays enabled throughout.
  app.post(
    "/auth/2fa/backup-codes/regenerate",
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFaEnabled) {
      return reply.code(400).send({ error: "2FA is not enabled on this account" });
    }
    if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(400).send({ error: "Incorrect password" });
    }
    const backupCodes = generateBackupCodes();
    await app.prisma.user.update({
      where: { id: userId },
      data: { twoFaBackupCodes: backupCodes.map(hashBackupCode) },
    });
    logEvent(app.prisma, "INFO", "auth", `2FA backup codes regenerated for ${user.email}`);
    return { ok: true, backupCodes };
  });

  // Disable 2FA. Requires the current password as a safeguard so a
  // hijacked session token alone can't turn off the account's 2FA.
  app.post("/auth/2fa/disable", { preHandler: requireAuth }, async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(400).send({ error: "Incorrect password" });
    }
    await app.prisma.user.update({
      where: { id: userId },
      data: { twoFaEnabled: false, twoFaSecret: null, twoFaBackupCodes: [] },
    });
    logEvent(app.prisma, "INFO", "auth", `2FA disabled for ${user.email}`);
    return { ok: true };
  });

  // Sends a real email when SMTP is configured. In dev without SMTP set
  // up, the token is echoed back in the response so you can still test
  // the flow end-to-end without standing up a mail server first.
  app.post(
    "/auth/request-reset",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user) return { ok: true }; // don't leak account existence
    const resetToken = app.jwt.sign({ id: user.id, purpose: "reset" }, { expiresIn: "30m" });

    if (mailEnabled()) {
      try {
        await sendPasswordResetEmail(user.email, resetToken);
      } catch (err) {
        app.log.error({ err }, "failed to send password reset email");
        logEvent(app.prisma, "ERROR", "auth", `Failed to send password reset email to ${user.email}: ${err}`);
      }
      return { ok: true };
    }
    return { ok: true, resetToken };
  });

  // Change password for an already-authenticated user (Settings page).
  // Distinct from /auth/reset-password, which is for the forgot-password
  // flow via emailed token and doesn't require knowing the old password.
  app.post(
    "/auth/change-password",
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { currentPassword, newPassword } = z
        .object({ currentPassword: z.string(), newPassword: z.string().min(8) })
        .parse(req.body);
      const jwtUser = req.user as { id: string };
      const user = await app.prisma.user.findUnique({ where: { id: jwtUser.id } });
      if (!user) return reply.code(404).send({ error: "User not found" });
      if (!user.passwordHash) {
        return reply.code(400).send({ error: "This account signs in via SSO and has no password to change" });
      }
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        logEvent(app.prisma, "WARN", "auth", `Failed password change attempt for ${user.email} (wrong current password)`);
        return reply.code(400).send({ error: "Current password is incorrect" });
      }
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await app.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
      logEvent(app.prisma, "INFO", "auth", `Password changed for ${user.email}`);
      return { ok: true };
    }
  );

  app.post("/auth/reset-password", async (req, reply) => {
    const { token, newPassword } = z
      .object({ token: z.string(), newPassword: z.string().min(8) })
      .parse(req.body);
    try {
      const payload = app.jwt.verify(token) as { id: string; purpose: string };
      if (payload.purpose !== "reset") throw new Error("bad token");
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await app.prisma.user.update({ where: { id: payload.id }, data: { passwordHash } });
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: "Invalid or expired token" });
    }
  });

  // ---- SSO (generic OIDC) ----
  // Every currently-enabled provider — the frontend renders one
  // "Continue with <provider>" button per entry (possibly Microsoft AND
  // Google AND ... at once).
  app.get("/auth/sso/config", async () => {
    return { providers: await listSsoProviders(app.prisma) };
  });

  app.get("/auth/sso/login", async (req, reply) => {
    const { provider } = req.query as { provider?: string };
    const providers = await listSsoProviders(app.prisma);
    // No ?provider= (an old bookmarked link, or a client that hasn't
    // been updated) falls back to the first configured provider so
    // existing single-provider setups keep working unchanged.
    const match = provider ? providers.find((p) => p.key === provider) : providers[0];
    if (!match) return reply.code(404).send({ error: "SSO is not configured" });

    const state = generateState();
    // 10 minutes is generous for a login redirect round-trip; state is
    // single-use and deleted on callback regardless of outcome. The
    // value stored is WHICH provider this attempt is for — the callback
    // is a separate request with no query params of its own beyond
    // code/state, so this is the only way it knows which of possibly
    // several configured providers the code it received belongs to.
    await app.redis.set(`sso:state:${state}`, match.key, "EX", 600);

    const redirectUri = await ssoRedirectUriFor(
      app.prisma,
      match.key,
      `${req.protocol}://${req.hostname}/api/auth/sso/callback`
    );
    const url = await buildAuthorizationUrl(app.prisma, match.key, state, redirectUri);
    return reply.redirect(url);
  });

  app.get("/auth/sso/callback", async (req, reply) => {
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost").replace(/\/$/, "");
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) return reply.redirect(`${frontendUrl}/login?sso_error=${encodeURIComponent(error)}`);
    if (!code || !state) return reply.redirect(`${frontendUrl}/login?sso_error=missing_code_or_state`);

    const stateKey = `sso:state:${state}`;
    const key = await app.redis.get(stateKey);
    await app.redis.del(stateKey);
    if (!key) return reply.redirect(`${frontendUrl}/login?sso_error=invalid_state`);

    try {
      const redirectUri = await ssoRedirectUriFor(
        app.prisma,
        key,
        `${req.protocol}://${req.hostname}/api/auth/sso/callback`
      );
      const profile = await exchangeCodeForProfile(app.prisma, key, code, redirectUri);
      const providers = await listSsoProviders(app.prisma);
      const match = providers.find((p) => p.key === key);
      // The legacy singleton provider keeps linking by its display name,
      // exactly as before this feature existed — so an account already
      // linked on a deployment that had a single provider configured
      // pre-multi-provider still resolves the same way. A provider added
      // via the new SsoProvider table links by its own stable row id
      // instead (immune to a later display-name rename, and safe even if
      // two providers happen to share a display name).
      const linkId = key === "legacy" ? match?.providerName || "SSO" : key;

      // Link to an existing account by (provider, sub) first, then fall
      // back to matching by email so a user who registered locally with
      // the same email gets their account linked instead of duplicated.
      let user = await app.prisma.user.findUnique({
        where: { ssoProvider_ssoSubject: { ssoProvider: linkId, ssoSubject: profile.sub } },
      });

      if (!user) {
        const byEmail = await app.prisma.user.findUnique({ where: { email: profile.email } });
        if (byEmail) {
          user = await app.prisma.user.update({
            where: { id: byEmail.id },
            data: { ssoProvider: linkId, ssoSubject: profile.sub },
          });
        } else {
          const userCount = await app.prisma.user.count();
          const role = userCount === 0 ? "ADMIN" : "USER";
          const defaultGroup =
            role === "USER" ? await app.prisma.group.findFirst({ where: { isDefault: true } }) : null;
          user = await app.prisma.user.create({
            data: {
              email: profile.email,
              name: profile.name,
              ssoProvider: linkId,
              ssoSubject: profile.sub,
              role,
              groupId: defaultGroup?.id,
            },
          });
        }
      }

      const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
      setSessionCookie(reply, token);
      return reply.redirect(`${frontendUrl}/login?sso_token=${encodeURIComponent(token)}`);
    } catch (err) {
      app.log.error({ err }, "SSO callback failed");
      logEvent(app.prisma, "ERROR", "sso", `SSO callback failed: ${err}`);
      return reply.redirect(`${frontendUrl}/login?sso_error=exchange_failed`);
    }
  });
}
