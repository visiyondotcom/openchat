import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { chatOnce } from "../lib/ollama.js";

const DEFAULT_BOT_MODEL = process.env.CHANNEL_BOT_MODEL || "";

// Redis pub/sub channel-name prefix for live message fan-out. Using Redis
// (not an in-process EventEmitter) is what makes this work correctly
// across multiple backend replicas — a message posted on node A reaches
// an SSE client connected to node B. Same horizontal-scaling reasoning as
// the Redis-backed rate limiter in index.ts.
const CHANNEL_PREFIX = "visiyon:channel:";

export default async function channelsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/channels", async (req) => {
    const { id: userId } = req.user as { id: string };
    const channels = await app.prisma.channel.findMany({
      where: { OR: [{ isPrivate: false }, { members: { some: { userId } } }] },
      orderBy: { name: "asc" },
      include: { _count: { select: { members: true } } },
    });
    return { channels };
  });

  app.post("/channels", async (req) => {
    const { id: userId } = req.user as { id: string };
    const body = z.object({ name: z.string().min(1), description: z.string().optional(), isPrivate: z.boolean().optional() }).parse(req.body);
    const channel = await app.prisma.channel.create({
      data: { ...body, createdById: userId, members: { create: { userId } } },
    });
    return { channel };
  });

  app.post("/channels/:channelId/join", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { channelId } = req.params as { channelId: string };
    const channel = await app.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.code(404).send({ error: "Not found" });
    if (channel.isPrivate) return reply.code(403).send({ error: "This channel is private" });
    await app.prisma.channelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/channels/:channelId/leave", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { channelId } = req.params as { channelId: string };
    await app.prisma.channelMember.deleteMany({ where: { channelId, userId } });
    return { ok: true };
  });

  app.get("/channels/:channelId/messages", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { channelId } = req.params as { channelId: string };
    const channel = await app.prisma.channel.findUnique({ where: { id: channelId }, include: { members: true } });
    if (!channel) return reply.code(404).send({ error: "Not found" });
    if (channel.isPrivate && !channel.members.some((m) => m.userId === userId)) {
      return reply.code(403).send({ error: "Not a member of this channel" });
    }
    const messages = await app.prisma.channelMessage.findMany({
      where: { channelId },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return { messages };
  });

  // Post a message. If it @-mentions the assistant (`@assistant` at the
  // start or anywhere in the text) and CHANNEL_BOT_MODEL is configured,
  // a bot reply is generated once (non-streamed — channels are a room,
  // not a 1:1 stream) and posted as a second ChannelMessage with
  // isBot:true. Every posted message (human and bot) is published to
  // Redis so every connected SSE subscriber gets it immediately,
  // regardless of which backend node they're attached to.
  app.post("/channels/:channelId/messages", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { channelId } = req.params as { channelId: string };
    const { content } = z.object({ content: z.string().min(1) }).parse(req.body);

    const channel = await app.prisma.channel.findUnique({ where: { id: channelId }, include: { members: true } });
    if (!channel) return reply.code(404).send({ error: "Not found" });
    if (channel.isPrivate && !channel.members.some((m) => m.userId === userId)) {
      return reply.code(403).send({ error: "Not a member of this channel" });
    }

    const message = await app.prisma.channelMessage.create({
      data: { channelId, userId, content },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    await app.redis.publish(`${CHANNEL_PREFIX}${channelId}`, JSON.stringify({ message }));

    if (/@assistant\b/i.test(content) && DEFAULT_BOT_MODEL) {
      // Give the bot the last 20 messages as context instead of just the
      // single @-mention — without this it can't follow a back-and-forth
      // in the channel, only ever answer the literal mention in isolation.
      app.prisma.channelMessage
        .findMany({ where: { channelId }, orderBy: { createdAt: "desc" }, take: 20, include: { user: { select: { name: true, email: true } } } })
        .then((recent) => {
          const history = recent
            .reverse()
            .map((m) => ({
              role: m.isBot ? ("assistant" as const) : ("user" as const),
              content: m.isBot ? m.content : `${m.user?.name || m.user?.email || "user"}: ${m.content.replace(/@assistant/gi, "").trim()}`,
            }));
          return chatOnce({ model: DEFAULT_BOT_MODEL, messages: history });
        })
        .then(async (result) => {
          const botMessage = await app.prisma.channelMessage.create({
            data: { channelId, isBot: true, content: result.content },
          });
          await app.redis.publish(`${CHANNEL_PREFIX}${channelId}`, JSON.stringify({ message: botMessage }));
        })
        .catch((err) => app.log.warn({ err }, "channel bot reply failed"));
    }

    return { message };
  });

  // Live updates over SSE, backed by Redis pub/sub — subscribes this
  // connection to the channel's Redis topic and forwards every published
  // message as an SSE event, regardless of which backend node produced it.
  app.get("/channels/:channelId/stream", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { channelId } = req.params as { channelId: string };
    const channel = await app.prisma.channel.findUnique({ where: { id: channelId }, include: { members: true } });
    if (!channel) return reply.code(404).send({ error: "Not found" });
    if (channel.isPrivate && !channel.members.some((m) => m.userId === userId)) {
      return reply.code(403).send({ error: "Not a member of this channel" });
    }

    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

    const subscriber = app.redis.duplicate();
    await subscriber.subscribe(`${CHANNEL_PREFIX}${channelId}`);
    subscriber.on("message", (_topic, payload) => {
      reply.raw.write(`data: ${payload}\n\n`);
    });

    req.raw.on("close", () => {
      subscriber.unsubscribe().catch(() => {});
      subscriber.disconnect();
    });
  });
}
