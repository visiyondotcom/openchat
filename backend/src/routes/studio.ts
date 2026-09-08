import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../lib/jwt.js";
import { isValidSubdomain, isSafeRelativePath, writeSiteFiles, removeSite } from "../lib/sites.js";

// Used to build the full published URL returned to the frontend after a
// publish (e.g. "janspizza" -> https://janspizza.visiyon.com). Falls back
// to "localhost" for local/dev setups without a real domain configured.
const BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost";

// Studio projects — see prisma schema's Project + ProjectMember models.
// A user always has their own default project (created on first access),
// and can additionally be invited as a collaborator (EDITOR or VIEWER)
// onto projects owned by other users. All routes below take an explicit
// :id so both owned and shared projects work the same way. Newly
// registered accounts automatically claim any pending shares sent to
// their email before they signed up — see routes/auth.ts register.

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024; // 512KB per file — plenty for hand-written HTML/CSS/JS
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5MB total per project

const filesSchema = z
  .record(z.string(), z.string())
  .refine((files) => Object.keys(files).length <= MAX_FILES, {
    message: `A project can have at most ${MAX_FILES} files.`,
  })
  .refine((files) => Object.entries(files).every(([p]) => isSafeRelativePath(p)), {
    message: "One or more file paths are invalid.",
  })
  .refine((files) => Object.values(files).every((c) => Buffer.byteLength(c, "utf-8") <= MAX_FILE_BYTES), {
    message: "One or more files are too large (max 512KB each).",
  })
  .refine(
    (files) => Object.values(files).reduce((sum, c) => sum + Buffer.byteLength(c, "utf-8"), 0) <= MAX_TOTAL_BYTES,
    { message: "Project is too large (max 5MB total)." }
  );

const DEFAULT_FILES: Record<string, string> = {
  "index.html": [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>My site</title>",
    '  <link rel="stylesheet" href="style.css" />',
    "</head>",
    "<body>",
    "  <h1>Hello world</h1>",
    '  <script src="script.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n"),
  "style.css": "body {\n  font-family: sans-serif;\n  margin: 2rem;\n}\n",
  "script.js": "console.log('Hello from script.js');\n",
};

const PROJECT_INCLUDE = {
  members: {
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" as const },
  },
  user: { select: { id: true, name: true, email: true, avatarUrl: true } },
};

export default async function studioRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  async function getOrCreateOwnProject(userId: string) {
    const existing = await app.prisma.project.findFirst({ where: { userId } });
    if (existing) return existing;
    return app.prisma.project.create({ data: { userId, files: DEFAULT_FILES } });
  }

  // Loads a project the user is allowed to touch — either because they
  // own it or because they're an accepted collaborator — and returns
  // both the project and the caller's role ("OWNER", "EDITOR", "VIEWER").
  // Throws a { code, message } object the caller catches and turns into
  // an HTTP response, so every route below can just `await` this.
  async function loadAccessibleProject(projectId: string, userId: string) {
    const project = await app.prisma.project.findUnique({
      where: { id: projectId },
      include: PROJECT_INCLUDE,
    });
    if (!project) throw { code: 404, message: "Project not found" };
    if (project.userId === userId) return { project, role: "OWNER" as const };
    const membership = project.members.find((m) => m.userId === userId);
    if (!membership) throw { code: 403, message: "You don't have access to this project" };
    return { project, role: membership.role as "EDITOR" | "VIEWER" };
  }

  function handleAccessError(reply: any, err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      return reply.code((err as any).code).send({ error: (err as any).message });
    }
    throw err;
  }

  // List every project the user can see: their own + ones shared with them.
  app.get("/studio/projects", async (req) => {
    const { id: userId } = req.user as { id: string };
    await getOrCreateOwnProject(userId); // ensures at least one project exists
    const [owned, shared] = await Promise.all([
      app.prisma.project.findMany({ where: { userId }, include: PROJECT_INCLUDE, orderBy: { createdAt: "asc" } }),
      app.prisma.project.findMany({
        where: { members: { some: { userId } } },
        include: PROJECT_INCLUDE,
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const projects = [
      ...owned.map((p) => ({ ...p, role: "OWNER" as const })),
      ...shared.map((p) => ({
        ...p,
        role: (p.members.find((m) => m.userId === userId)?.role ?? "EDITOR") as "EDITOR" | "VIEWER",
      })),
    ];
    return { projects };
  });

  // Back-compat: the frontend's original single-project flow. Now just
  // resolves to the caller's own (first) project.
  app.get("/studio/project", async (req) => {
    const { id: userId } = req.user as { id: string };
    const own = await getOrCreateOwnProject(userId);
    const { project, role } = await loadAccessibleProject(own.id, userId);
    return { project, role };
  });

  app.get("/studio/project/:id", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    try {
      const { project, role } = await loadAccessibleProject(projectId, userId);
      return { project, role };
    } catch (err) {
      return handleAccessError(reply, err);
    }
  });

  app.put("/studio/project/:id/files", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    const parsed = filesSchema.safeParse((req.body as { files?: unknown })?.files);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message || "Invalid files" });
    }
    try {
      const { role } = await loadAccessibleProject(projectId, userId);
      if (role === "VIEWER") return reply.code(403).send({ error: "You only have view access to this project" });
    } catch (err) {
      return handleAccessError(reply, err);
    }
    const updated = await app.prisma.project.update({
      where: { id: projectId },
      data: { files: parsed.data },
      include: PROJECT_INCLUDE,
    });
    return { project: updated };
  });

  app.patch("/studio/project/:id/name", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid name" });
    try {
      const { role } = await loadAccessibleProject(projectId, userId);
      if (role === "VIEWER") return reply.code(403).send({ error: "You only have view access to this project" });
    } catch (err) {
      return handleAccessError(reply, err);
    }
    const updated = await app.prisma.project.update({
      where: { id: projectId },
      data: { name: body.data.name },
      include: PROJECT_INCLUDE,
    });
    return { project: updated };
  });

  app.patch("/studio/project/:id/subdomain", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    const body = z.object({ subdomain: z.string().min(1).max(63) }).parse(req.body);
    const subdomain = body.subdomain.trim().toLowerCase();
    if (!isValidSubdomain(subdomain)) {
      return reply.code(400).send({
        error: "Invalid subdomain: use 3-63 lowercase letters, digits, or hyphens, and no reserved name.",
      });
    }
    try {
      const { role } = await loadAccessibleProject(projectId, userId);
      if (role === "VIEWER") return reply.code(403).send({ error: "You only have view access to this project" });
    } catch (err) {
      return handleAccessError(reply, err);
    }
    const taken = await app.prisma.project.findUnique({ where: { subdomain } });
    if (taken && taken.id !== projectId) {
      return reply.code(409).send({ error: "This subdomain is already taken." });
    }
    const updated = await app.prisma.project.update({
      where: { id: projectId },
      data: { subdomain },
      include: PROJECT_INCLUDE,
    });
    return { project: updated };
  });

  app.post("/studio/project/:id/publish", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    let project;
    try {
      const loaded = await loadAccessibleProject(projectId, userId);
      if (loaded.role === "VIEWER") return reply.code(403).send({ error: "You only have view access to this project" });
      project = loaded.project;
    } catch (err) {
      return handleAccessError(reply, err);
    }
    if (!project.subdomain) {
      return reply.code(400).send({ error: "Choose a subdomain before publishing." });
    }
    const files = (project.files as Record<string, string>) ?? {};
    try {
      await writeSiteFiles(project.subdomain, files);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "Publish failed" });
    }
    const updated = await app.prisma.project.update({
      where: { id: projectId },
      data: { publishedFiles: files, publishedAt: new Date() },
      include: PROJECT_INCLUDE,
    });
    return { project: updated, url: `https://${project.subdomain}.${BASE_DOMAIN}` };
  });

  app.post("/studio/project/:id/unpublish", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    let project;
    try {
      const loaded = await loadAccessibleProject(projectId, userId);
      if (loaded.role === "VIEWER") return reply.code(403).send({ error: "You only have view access to this project" });
      project = loaded.project;
    } catch (err) {
      return handleAccessError(reply, err);
    }
    if (project.subdomain) await removeSite(project.subdomain);
    const updated = await app.prisma.project.update({
      where: { id: projectId },
      data: { publishedFiles: Prisma.JsonNull, publishedAt: null },
      include: PROJECT_INCLUDE,
    });
    return { project: updated };
  });

  // ---- Collaborators / sharing ----

  app.get("/studio/project/:id/members", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    try {
      const { project } = await loadAccessibleProject(projectId, userId);
      return { members: project.members, owner: project.user };
    } catch (err) {
      return handleAccessError(reply, err);
    }
  });

  app.post("/studio/project/:id/members", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    const body = z
      .object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["EDITOR", "VIEWER"]).default("EDITOR") })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a valid email address" });

    let project;
    try {
      const loaded = await loadAccessibleProject(projectId, userId);
      if (loaded.role !== "OWNER") return reply.code(403).send({ error: "Only the project owner can invite people" });
      project = loaded.project;
    } catch (err) {
      return handleAccessError(reply, err);
    }

    if (body.data.email === project.user.email.toLowerCase()) {
      return reply.code(400).send({ error: "That's already the project owner" });
    }

    const invitedUser = await app.prisma.user.findUnique({ where: { email: body.data.email } });
    const member = await app.prisma.projectMember.upsert({
      where: { projectId_email: { projectId, email: body.data.email } },
      update: { role: body.data.role },
      create: {
        projectId,
        email: body.data.email,
        role: body.data.role,
        userId: invitedUser?.id ?? null,
        invitedById: userId,
      },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    });
    return { member, pending: !invitedUser };
  });

  app.patch("/studio/project/:id/members/:memberId", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId, memberId } = req.params as { id: string; memberId: string };
    const body = z.object({ role: z.enum(["EDITOR", "VIEWER"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid role" });
    try {
      const loaded = await loadAccessibleProject(projectId, userId);
      if (loaded.role !== "OWNER") return reply.code(403).send({ error: "Only the project owner can change roles" });
    } catch (err) {
      return handleAccessError(reply, err);
    }
    const member = await app.prisma.projectMember.update({
      where: { id: memberId, projectId },
      data: { role: body.data.role },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    });
    return { member };
  });

  // Create an additional project owned by the caller — the schema always
  // supported one user owning several projects (see Project.userId
  // comment above); this is what actually exposes that as "New project"
  // in the projects table instead of always reusing the single default
  // "own" project from getOrCreateOwnProject.
  app.post("/studio/projects", async (req) => {
    const { id: userId } = req.user as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(80).optional() }).parse(req.body ?? {});
    const project = await app.prisma.project.create({
      data: { userId, name: body.name || "My site", files: DEFAULT_FILES },
      include: PROJECT_INCLUDE,
    });
    return { project, role: "OWNER" as const };
  });

  // Delete a project outright — owner only. Collaborators use the
  // existing "remove member" route above to leave instead.
  app.delete("/studio/project/:id", async (req, reply) => {
    const { id: userId } = req.user as { id: string };
    const { id: projectId } = req.params as { id: string };
    let loaded;
    try {
      loaded = await loadAccessibleProject(projectId, userId);
    } catch (err) {
      return handleAccessError(reply, err);
    }
    if (loaded.role !== "OWNER") {
      return reply.code(403).send({ error: "Only the owner can delete this project" });
    }
    if (loaded.project.subdomain) {
      await removeSite(loaded.project.subdomain).catch(() => {});
    }
    await app.prisma.project.delete({ where: { id: projectId } });
    return { ok: true };
  });
}
