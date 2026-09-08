import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import { chatOnce } from "../lib/ollama.js";

// Standard ELO update, K=32. Both ratings default to 1500 on first
// appearance (ArenaRating.rating @default(1500)), same as chess ELO
// convention — no special-casing needed for "new model shows up".
function updateElo(ratingA: number, ratingB: number, outcome: "A" | "B" | "TIE"): [number, number] {
  const K = 32;
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const scoreA = outcome === "A" ? 1 : outcome === "B" ? 0 : 0.5;
  const newA = Math.round(ratingA + K * (scoreA - expectedA));
  const newB = Math.round(ratingB + K * ((1 - scoreA) - (1 - expectedA)));
  return [newA, newB];
}

export default async function arenaRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Runs the same prompt against two models in parallel and returns both
  // responses unlabeled-position-wise from the client's perspective (the
  // client is trusted to randomize which one it calls "A"/"B" in its UI
  // if it wants blind comparison — the API itself is honest about which
  // model produced which response since the vote endpoint needs the real
  // names to update ratings).
  app.post("/arena/battle", async (req) => {
    const { prompt, modelA, modelB } = z
      .object({ prompt: z.string().min(1), modelA: z.string().min(1), modelB: z.string().min(1) })
      .parse(req.body);

    const [resA, resB] = await Promise.all([
      chatOnce({ model: modelA, messages: [{ role: "user", content: prompt }] }),
      chatOnce({ model: modelB, messages: [{ role: "user", content: prompt }] }),
    ]);

    return {
      prompt,
      modelA,
      modelB,
      responseA: resA.content,
      responseB: resB.content,
    };
  });

  // Records the user's pick and updates ELO for both models. BOTH_BAD
  // still needs an outcome for the ELO formula — treated as a tie, since
  // neither answer earning a rating change in either direction is the
  // closest fit ("both equally failed" isn't asymmetric like a real win).
  app.post("/arena/vote", async (req) => {
    const { id: userId } = req.user as { id: string };
    const body = z
      .object({
        prompt: z.string().min(1),
        modelA: z.string().min(1),
        modelB: z.string().min(1),
        responseA: z.string(),
        responseB: z.string(),
        winner: z.enum(["A", "B", "TIE", "BOTH_BAD"]),
      })
      .parse(req.body);

    const [ratingA, ratingB] = await Promise.all([
      app.prisma.arenaRating.upsert({ where: { modelName: body.modelA }, create: { modelName: body.modelA }, update: {} }),
      app.prisma.arenaRating.upsert({ where: { modelName: body.modelB }, create: { modelName: body.modelB }, update: {} }),
    ]);

    const eloOutcome = body.winner === "A" ? "A" : body.winner === "B" ? "B" : "TIE";
    const [newA, newB] = updateElo(ratingA.rating, ratingB.rating, eloOutcome);

    await Promise.all([
      app.prisma.arenaRating.update({ where: { modelName: body.modelA }, data: { rating: newA, votes: { increment: 1 } } }),
      app.prisma.arenaRating.update({ where: { modelName: body.modelB }, data: { rating: newB, votes: { increment: 1 } } }),
      app.prisma.arenaVote.create({
        data: { userId, ...body, ratingAAfter: newA, ratingBAfter: newB },
      }),
    ]);

    return { ratingA: newA, ratingB: newB };
  });

  app.get("/arena/leaderboard", async () => {
    const ratings = await app.prisma.arenaRating.findMany({ orderBy: { rating: "desc" } });
    return { ratings };
  });
}
