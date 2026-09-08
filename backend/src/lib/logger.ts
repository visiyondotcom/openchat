import type { PrismaClient } from "@prisma/client";

// Thin wrapper around the Log table. Never throws — a logging failure should
// never take down the request that triggered it, so writes are fire-and-forget
// with a console fallback if the DB write itself fails.
export async function logEvent(
  prisma: PrismaClient,
  level: "INFO" | "WARN" | "ERROR",
  source: string,
  message: string,
  meta?: Record<string, unknown>
) {
  try {
    await prisma.log.create({
      data: { level, source, message, meta: meta ? (meta as any) : undefined },
    });
  } catch (err) {
    // Last resort so we don't lose the signal entirely if the DB write fails.
    console.error(`[logger fallback] ${level} ${source}: ${message}`, meta, err);
  }
}
