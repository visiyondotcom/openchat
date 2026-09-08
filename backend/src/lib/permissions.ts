import type { PrismaClient } from "@prisma/client";

// Model access rule: a group with an empty modelAccess array can use every
// model (this is the default for new/legacy groups so upgrading a running
// deployment never silently locks users out). A non-empty array is an
// allowlist of exact Ollama model names (e.g. "llama3.1:8b").
//
// A user with no group at all (groupId null) is treated as unrestricted —
// groups are opt-in. Admins always bypass model access checks.

export async function getAllowedModels(
  prisma: PrismaClient,
  userId: string
): Promise<{ allowAll: boolean; models: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { group: true },
  });
  if (!user) return { allowAll: false, models: [] };
  if (user.role === "ADMIN") return { allowAll: true, models: [] };
  if (!user.group || user.group.modelAccess.length === 0) {
    return { allowAll: true, models: [] };
  }
  return { allowAll: false, models: user.group.modelAccess };
}

export async function canUseModel(
  prisma: PrismaClient,
  userId: string,
  model: string
): Promise<boolean> {
  const { allowAll, models } = await getAllowedModels(prisma, userId);
  return allowAll || models.includes(model);
}
