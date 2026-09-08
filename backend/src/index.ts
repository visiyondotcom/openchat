import "./otel.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";

import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";

import authRoutes from "./routes/auth.js";
import chatsRoutes from "./routes/chats.js";
import modelsRoutes from "./routes/models.js";
import adminRoutes from "./routes/admin.js";
import documentsRoutes from "./routes/documents.js";
import promptsRoutes from "./routes/prompts.js";
import playgroundRoutes from "./routes/playground.js";
import toolsRoutes from "./routes/tools.js";
import foldersRoutes from "./routes/folders.js";
import apiKeysRoutes from "./routes/api-keys.js";
import pipelinesRoutes from "./routes/pipelines.js";
import voiceRoutes from "./routes/voice.js";
import imagesRoutes from "./routes/images.js";
import musicRoutes from "./routes/music.js";
import generateRoutes from "./routes/generate.js";
import billingRoutes from "./routes/billing.js";
import creditsRoutes from "./routes/credits.js";
import filtersRoutes from "./routes/filters.js";
import pipesRoutes from "./routes/pipes.js";
import actionsRoutes from "./routes/actions.js";
import mcpRoutes from "./routes/mcp.js";
import trainingRoutes from "./routes/training.js";
import { reapOrphanedJobs } from "./lib/training.js";
import channelsRoutes from "./routes/channels.js";
import notesRoutes from "./routes/notes.js";
import studioRoutes from "./routes/studio.js";
import arenaRoutes from "./routes/arena.js";
import filesRoutes from "./routes/files.js";
import mediaResultsRoutes from "./routes/media-results.js";
import musicFilesRoutes from "./routes/music-files.js";
import automationsRoutes from "./routes/automations.js";
import securityRoutes from "./routes/security.js";
import providersRoutes from "./routes/providers.js";
import ssoProvidersRoutes from "./routes/sso-providers.js";
import metaModelsRoutes from "./routes/meta-models.js";
import serverConnectionRoutes from "./routes/server-connection.js";
import supportRoutes from "./routes/support.js";
import communityAiRoutes from "./routes/community-ai.js";
import cvmakerAiRoutes from "./routes/cvmaker-ai.js";
import notificationsRoutes from "./routes/notifications.js";
import { seedBuiltinTools } from "./lib/tools.js";
import { scheduleCleanup } from "./lib/cleanup.js";
import { scheduleAutomations } from "./lib/automation-scheduler.js";
import { scheduleSecurityScanner } from "./lib/security-scanner.js";
import { reportSiteEvent, heartbeatHook } from "./lib/fraudGuardReport.js";

// Fastify's default bodyLimit is 1MB — far too small for chat messages that
// include an image (pendingImages are sent as base64, which inflates the
// original file size by ~33%, so even a modest phone photo easily exceeds
// it). Raised to match nginx's client_max_body_size (20mb) so the two
// limits agree — otherwise nginx happily forwards a larger request only for
// fastify to reject it with a 413 anyway.
const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
await app.register(prismaPlugin);
await app.register(redisPlugin);

// Off by default globally — only routes that opt in via `config.rateLimit`
// (login, register, password-reset request) are actually throttled, so
// normal chat/API traffic is never affected.
// Backed by Redis (not the default in-memory store) so rate limits are
// shared across every backend replica.
await app.register(rateLimit, {
  global: false,
  redis: app.redis,
  // Fires for every route that opts into rateLimit (login, register,
  // password-reset) once a client trips it — reported to fraud-guard purely
  // for dashboard visibility, same as the failed-login reports in auth.ts.
  onExceeded: (req) => reportSiteEvent("rate_limited", req, { scope: req.routeOptions?.url || req.url }),
});
await app.register(jwt, {
  secret: process.env.JWT_SECRET || "change_me_in_env",
  // Session tokens expire and must be re-obtained via login/SSO. The
  // password-reset token overrides this with its own short-lived 30m
  // expiresIn at the call site, so this default only affects normal
  // session tokens.
  sign: { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
});
await app.register(multipart);

// Fires on (almost) every request so fraud-guard's LIVE VISITORS panel
// shows real ai.visiyon.com traffic (site: 'platform'). Needs jwt/cookie
// plugins already registered above for best-effort identity lookup.
app.addHook("onRequest", heartbeatHook);

// Preserve the raw request body alongside the parsed JSON. Only the Stripe
// webhook route needs this (to verify the signature over the exact bytes
// Stripe sent), but content-type parsers are global in Fastify, so every
// request pays a small, harmless cost of stashing the buffer.
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  (req as any).rawBody = body;
  if (body.length === 0) return done(null, undefined);
  try {
    done(null, JSON.parse(body.toString("utf8")));
  } catch (err) {
    (err as any).statusCode = 400;
    done(err as Error, undefined);
  }
});

await app.register(authRoutes);
await app.register(chatsRoutes);
await app.register(modelsRoutes);
await app.register(adminRoutes);
await app.register(documentsRoutes);
await app.register(promptsRoutes);
await app.register(playgroundRoutes);
await app.register(toolsRoutes);
await app.register(foldersRoutes);
await app.register(apiKeysRoutes);
await app.register(pipelinesRoutes);
await app.register(voiceRoutes);
await app.register(imagesRoutes);
await app.register(musicRoutes);
await app.register(generateRoutes);
await app.register(billingRoutes);
await app.register(creditsRoutes);
await app.register(filtersRoutes);
await app.register(pipesRoutes);
await app.register(actionsRoutes);
await app.register(mcpRoutes);
await app.register(channelsRoutes);
await app.register(notesRoutes);
await app.register(studioRoutes);
await app.register(arenaRoutes);
await app.register(filesRoutes);
await app.register(mediaResultsRoutes);
await app.register(musicFilesRoutes);
await app.register(automationsRoutes);
await app.register(securityRoutes);
await app.register(providersRoutes);
await app.register(ssoProvidersRoutes);
await app.register(metaModelsRoutes);
await app.register(serverConnectionRoutes);
await app.register(supportRoutes);
await app.register(communityAiRoutes);
await app.register(cvmakerAiRoutes);
await app.register(notificationsRoutes);
await app.register(trainingRoutes);

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT || 4000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(async () => {
    app.log.info(`Visiyon backend listening on :${port}`);
    try {
      await seedBuiltinTools(app.prisma);
    } catch (err) {
      app.log.error({ err }, "failed to seed built-in tools");
    }
    scheduleCleanup(app);
    scheduleAutomations(app);
    try {
      await reapOrphanedJobs(app.prisma);
    } catch (err) {
      app.log.error({ err }, "failed to reap orphaned training jobs");
    }
    scheduleSecurityScanner(app);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
