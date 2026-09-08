import type { PrismaClient } from "@prisma/client";
import { logEvent } from "./logger.js";

// Thin wrapper around Notification.create — fire-and-forget by convention
// (callers `.catch()` this, same as persist/refund calls in generate.ts)
// so a notification hiccup never blocks the actual generation result from
// reaching the user. Kept as its own module rather than inlined in
// generate.ts so any future event source (chat mentions, automations,
// etc.) can reuse it without duplicating the shape.
export async function createNotification(
  prisma: PrismaClient,
  params: { userId: string; type: "GENERATION_COMPLETE" | "GENERATION_FAILED"; title: string; body?: string; sourceId?: string }
) {
  try {
    return await prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        body: params.body,
        sourceId: params.sourceId,
      },
    });
  } catch (err) {
    logEvent(prisma, "ERROR", "notify", `Failed to create notification: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
