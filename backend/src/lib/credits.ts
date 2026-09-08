import type { PrismaClient } from "@prisma/client";

export class InsufficientCreditsError extends Error {
  constructor(public required: number, public available: number) {
    super(`Not enough credits: need ${required}, have ${available}`);
  }
}

// Atomically deducts `amount` credits from the user, throwing
// InsufficientCreditsError instead of going negative. Uses a conditional
// updateMany (WHERE credits >= amount) rather than a read-then-write so two
// concurrent generations from the same user can't both pass a balance
// check against a stale read and double-spend the same credits.
export async function chargeCredits(prisma: PrismaClient, userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const result = await prisma.user.updateMany({
    where: { id: userId, credits: { gte: amount } },
    data: { credits: { decrement: amount } },
  });
  if (result.count === 0) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
    throw new InsufficientCreditsError(amount, user?.credits ?? 0);
  }
}

// Called when a charged generation ends up FAILED, so a kie.ai-side error
// doesn't leave the user out of pocket for nothing.
export async function refundCredits(prisma: PrismaClient, userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await prisma.user.update({ where: { id: userId }, data: { credits: { increment: amount } } });
}

export async function getCredits(prisma: PrismaClient, userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
  return user?.credits ?? 0;
}
