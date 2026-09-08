"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { askConfirm } from "@/components/PromptDialog";
import {
  getStudioProject,
  listStudioProjects,
  createStudioProject,
  deleteStudioProject,
  saveStudioFiles,
  setStudioSubdomain,
  publishStudioProject,
  unpublishStudioProject,
  renameStudioProject,
  inviteStudioMember,
  updateStudioMemberRole,
  removeStudioMember,
  type StudioProject,
  type StudioRole,
} from "@/lib/api";
import {
  ArrowLeft,
  FilePlus,
  Trash2,
  Save,
  Globe,
  Loader2,
  ExternalLink,
  Code2,
  Eye,
  Users,
  X,
  Mail,
  Crown,
  Pencil,
  EyeOff,
  Plus,
  FolderKanban,
  Share2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import Select from "@/components/Select";

// Monaco touches `window`/`navigator` at import time, so it can only ever
// run in the browser — loading it during SSR would crash the Next.js
// server render.
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

function languageForPath(path: string): string {
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".json")) return "json";
  return "plaintext";
}

// Builds a single self-contained HTML document for the preview iframe:
// inlines any local <link rel="stylesheet" href="..."> and
// <script src="..."> the entry HTML references, using the in-editor
// content of that file instead of fetching it (so the preview always
// reflects unsaved edits, not just what's on disk).
function buildPreviewDoc(files: Record<string, string>, entryPath: string): string {
  let html = files[entryPath] ?? "";
  html = html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (match, href) => {
      const content = files[href.replace(/^\.\//, "")];
      return content !== undefined ? `<style>\n${content}\n</style>` : match;
    }
  );
  html = html.replace(
    /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
    (match, src) => {
      const content = files[src.replace(/^\.\//, "")];
      return content !== undefined ? `<script>\n${content}\n</script>` : match;
    }
  );
  return html;
}

// Share modal: lists current collaborators (owner always shown first,
// read-only) and lets the project owner invite people by email or change
// / revoke access. Non-owners can only see the list and leave.
function ShareModal({
  project,
  role,
  onClose,
  onChanged,
}: {
  project: StudioProject;
  role: StudioRole;
  onClose: () => void;
  onChanged: (project: StudioProject) => void;
}) {
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"EDITOR" | "VIEWER">("EDITOR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(projectId: string) {
    const { project: fresh } = await getStudioProject(projectId);
    onChanged(fresh);
  }

  async function handleInvite() {
    const value = email.trim().toLowerCase();
    if (!value) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { pending } = await inviteStudioMember(project.id, value, inviteRole);
      setEmail("");
      setNotice(pending ? `Invite sent — ${value} will get access once they sign up.` : `${value} now has access.`);
      await refresh(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send invite");
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleChange(memberId: string, next: "EDITOR" | "VIEWER") {
    setBusy(true);
    try {
      await updateStudioMemberRole(project.id, memberId, next);
      await refresh(project.id);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(memberId: string) {
    setBusy(true);
    try {
      await removeStudioMember(project.id, memberId);
      await refresh(project.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-visiyon-bg border border-visiyon-border shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-visiyon-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Users size={16} /> Share &ldquo;{project.name}&rdquo;
          </h2>
          <button onClick={onClose} className="text-visiyon-text-2 hover:text-visiyon-text">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {role === "OWNER" && (
            <div className="space-y-2">
              <label className="text-xs text-visiyon-text-2">Invite by email</label>
              <div className="flex items-center gap-1.5">
                <div className="flex-1 min-w-0 flex items-center gap-1.5 bg-visiyon-text/[0.06] rounded-lg px-2.5 py-1.5">
                  <Mail size={13} className="text-visiyon-text-2 shrink-0" />
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                    placeholder="teammate@example.com"
                    className="flex-1 min-w-0 bg-transparent text-sm outline-none"
                  />
                </div>
                <Select
                  value={inviteRole}
                  onChange={(v) => setInviteRole(v as "EDITOR" | "VIEWER")}
                  options={[
                    { value: "EDITOR", label: "Can edit" },
                    { value: "VIEWER", label: "Can view" },
                  ]}
                  className="w-28 shrink-0"
                  buttonClassName="border-transparent bg-visiyon-text/[0.06] py-1.5 text-xs"
                />
              </div>
              <button
                onClick={handleInvite}
                disabled={busy || !email.trim()}
                className="w-full text-sm font-medium px-3 py-1.5 rounded-lg bg-white text-black hover:bg-visiyon-text/90 disabled:opacity-50 transition-colors"
              >
                Send invite
              </button>
              {error && <p className="text-xs text-red-400">{error}</p>}
              {notice && <p className="text-xs text-emerald-400">{notice}</p>}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-visiyon-text-2">People with access</label>
            <div className="flex items-center justify-between rounded-lg px-2.5 py-2 bg-visiyon-text/[0.04]">
              <div className="flex items-center gap-2 min-w-0">
                <Crown size={13} className="text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm truncate">{project.user.name || project.user.email}</p>
                  <p className="text-[11px] text-visiyon-text-2 truncate">{project.user.email}</p>
                </div>
              </div>
              <span className="text-[11px] text-visiyon-text-2 shrink-0">Owner</span>
            </div>

            {project.members.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg px-2.5 py-2 bg-visiyon-text/[0.04]">
                <div className="flex items-center gap-2 min-w-0">
                  {m.role === "EDITOR" ? (
                    <Pencil size={13} className="text-visiyon-text-2 shrink-0" />
                  ) : (
                    <EyeOff size={13} className="text-visiyon-text-2 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm truncate">{m.user?.name || m.email}</p>
                    <p className="text-[11px] text-visiyon-text-2 truncate">
                      {m.email}
                      {!m.userId && " · invite pending"}
                    </p>
                  </div>
                </div>
                {role === "OWNER" ? (
                  <div className="flex items-center gap-2 shrink-0">
                  <Select
                    value={m.role}
                    onChange={(v) => handleRoleChange(m.id, v as "EDITOR" | "VIEWER")}
                    disabled={busy}
                    options={[
                      { value: "EDITOR", label: "Can edit" },
                      { value: "VIEWER", label: "Can view" },
                    ]}
                    className="w-24 shrink-0"
                    buttonClassName="border-transparent bg-visiyon-text/[0.06] text-visiyon-text-2 py-1 text-[11px]"
                  />
                    <button onClick={() => handleRemove(m.id)} disabled={busy} className="text-visiyon-text-2 hover:text-red-400">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ) : (
                  <span className="text-[11px] text-visiyon-text-2 shrink-0">
                    {m.role === "EDITOR" ? "Can edit" : "Can view"}
                  </span>
                )}
              </div>
            ))}
            {project.members.length === 0 && (
              <p className="text-xs text-visiyon-text-2 px-1">Not shared with anyone yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioPageInner />
    </Suspense>
  );
}

function StudioPageInner() {
  const { ready } = useRequireAuth();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project") || undefined;

  if (!ready) return null;
  // No project selected — show the projects table instead of silently
  // dropping straight into the code editor for the user's default site.
  if (!projectId) return <ProjectsLanding />;
  return <StudioEditor projectId={projectId} />;
}

// ---- Projects table (the "Projects" landing) ----
// Lists every project the user owns or collaborates on, with room to
// create new ones and manage sharing per row — this is what used to be
// skipped entirely in favor of jumping straight into a code editor.
function ProjectsLanding() {
  const router = useRouter();
  const [projects, setProjects] = useState<StudioProject[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharingProject, setSharingProject] = useState<StudioProject | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function refresh() {
    return listStudioProjects()
      .then(({ projects }) => setProjects(projects))
      .catch(() => setError("Couldn't load your projects."));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const { project } = await createStudioProject();
      router.push(`/studio?project=${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the project.");
      setCreating(false);
    }
  }

  async function handleDelete(p: StudioProject) {
    const ok = await askConfirm({
      title: `Delete "${p.name}"? This permanently removes it and unpublishes its site, if any.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeletingId(p.id);
    try {
      await deleteStudioProject(p.id);
      setProjects((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the project.");
    } finally {
      setDeletingId(null);
    }
  }

  const isLoading = projects === null;
  const isEmpty = projects !== null && projects.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-visiyon-bg text-visiyon-text">
      {sharingProject && (
        <ShareModal
          project={sharingProject}
          role={sharingProject.role ?? "OWNER"}
          onClose={() => setSharingProject(null)}
          onChanged={(p) => {
            setSharingProject(p);
            setProjects((prev) => (prev ? prev.map((x) => (x.id === p.id ? { ...p, role: x.role } : x)) : prev));
          }}
        />
      )}

      <div className="px-4 py-6 sm:px-8 sm:py-8 max-w-[1200px] mx-auto">
        <div className="flex items-start sm:items-center justify-between gap-4 mb-6 flex-col sm:flex-row">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/" className="p-2 -ml-2 rounded-full text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.08] transition-colors shrink-0">
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">Projects</h1>
              <p className="text-[13px] text-visiyon-text-3 mt-0.5">
                Build and publish small sites, and work on them with other people.
              </p>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-white text-black hover:bg-visiyon-text/80 transition-colors disabled:opacity-50 shrink-0"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            New project
          </button>
        </div>

        {error && (
          <div className="mb-4 border border-red-400/30 bg-red-400/10 rounded-xl px-4 py-2.5 text-[13px] text-red-300">
            {error}
          </div>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-24 text-visiyon-text-3">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {isEmpty && (
          <div className="flex flex-col items-center justify-center text-center py-24 border border-dashed border-visiyon-border rounded-2xl">
            <FolderKanban size={40} className="text-visiyon-text-3 mb-4" strokeWidth={1.25} />
            <h2 className="text-[15px] font-medium mb-1.5">No projects yet</h2>
            <p className="text-[13px] text-visiyon-text-3 max-w-sm mb-5">
              Create a project to start building a site — you can invite others to edit or view it once it exists.
            </p>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-white text-black hover:bg-visiyon-text/80 transition-colors disabled:opacity-50"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create your first project
            </button>
          </div>
        )}

        {!isLoading && !isEmpty && (
          <div className="border border-visiyon-border rounded-2xl overflow-hidden">
            {/* Column header — hidden on mobile, where each row becomes a stacked card instead. */}
            <div className="hidden sm:grid grid-cols-[1fr_140px_120px_130px_88px] gap-4 px-4 py-2.5 border-b border-visiyon-border text-[11px] uppercase tracking-wide text-visiyon-text-3">
              <div>Name</div>
              <div>Role</div>
              <div>Collaborators</div>
              <div>Updated</div>
              <div />
            </div>
            <div className="divide-y divide-visiyon-border">
              {projects!.map((p) => {
                const isOwner = (p.role ?? "OWNER") === "OWNER";
                return (
                  <div
                    key={p.id}
                    className="group grid grid-cols-1 sm:grid-cols-[1fr_140px_120px_130px_88px] gap-1.5 sm:gap-4 px-4 py-3.5 items-center hover:bg-visiyon-text/[0.03] transition-colors cursor-pointer"
                    onClick={() => router.push(`/studio?project=${p.id}`)}
                  >
                    <div className="min-w-0 flex items-center gap-2.5">
                      <FolderKanban size={16} className="text-visiyon-text-3 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium truncate">{p.name}</div>
                        {p.subdomain && (
                          <div className="text-[11.5px] text-visiyon-text-3 truncate flex items-center gap-1">
                            {p.publishedAt ? (
                              <span className="inline-flex items-center gap-1 text-emerald-400/90">
                                <Globe size={10} /> Published
                              </span>
                            ) : (
                              "Draft"
                            )}
                            <span className="truncate">· {p.subdomain}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-[12.5px] text-visiyon-text-2 sm:block flex items-center gap-1.5">
                      <span className="sm:hidden text-visiyon-text-3">Role: </span>
                      {isOwner ? (
                        <span className="inline-flex items-center gap-1"><Crown size={11} className="text-amber-400/80" /> Owner</span>
                      ) : (
                        p.role === "EDITOR" ? "Editor" : "Viewer"
                      )}
                    </div>
                    <div className="text-[12.5px] text-visiyon-text-2">
                      <span className="sm:hidden text-visiyon-text-3">Collaborators: </span>
                      {p.members.length === 0 ? "—" : `${p.members.length} ${p.members.length === 1 ? "person" : "people"}`}
                    </div>
                    <div className="text-[12.5px] text-visiyon-text-2">
                      <span className="sm:hidden text-visiyon-text-3">Updated: </span>
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </div>
                    <div
                      className="flex items-center gap-1 justify-end sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => setSharingProject(p)}
                        title="Share"
                        className="p-1.5 rounded-lg text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/[0.08] transition-colors"
                      >
                        <Share2 size={14} />
                      </button>
                      {isOwner && (
                        <button
                          onClick={() => handleDelete(p)}
                          disabled={deletingId === p.id}
                          title="Delete"
                          className="p-1.5 rounded-lg text-visiyon-text-3 hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-40"
                        >
                          {deletingId === p.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StudioEditor({ projectId }: { projectId: string }) {
  const router = useRouter();

  const [project, setProject] = useState<StudioProject | null>(null);
  const [role, setRole] = useState<StudioRole>("OWNER");
  const [activeFile, setActiveFile] = useState<string>("index.html");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [subdomainInput, setSubdomainInput] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Below `lg` the three columns (files / editor / preview) don't fit side
  // by side, so only one is shown at a time, switched via tabs.
  const [mobilePane, setMobilePane] = useState<"files" | "editor" | "preview">("editor");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // VS Code-style top menu bar (File/Edit/View/Run/Help) — editorRef gives
  // the menu access to Monaco's own commands (undo/redo/find/format)
  // instead of reimplementing them.
  const editorRef = useRef<any>(null);
  const [openMenu, setOpenMenu] = useState<null | "file" | "edit" | "view" | "run" | "help">(null);
  const [wordWrap, setWordWrap] = useState(false);
  const [minimapEnabled, setMinimapEnabled] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  // Sidebar can collapse to a slim icon rail — more room for the editor,
  // which is the actual point of this screen. Preview and Publish used to
  // sit in a permanent third column; they're now on-demand overlays
  // (opened from the tab bar / Run menu) so the editor gets full width by
  // default, like a real code editor rather than a 3-pane website builder.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);

  useEffect(() => {
    if (!openMenu) return;
    function onClick(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-studio-menu]")) setOpenMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const canEdit = role !== "VIEWER";

  // Ctrl/Cmd+S saves immediately instead of triggering the browser's
  // "Save page" dialog — standard editor behavior.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveNow();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, canEdit]);

  useEffect(() => {
    getStudioProject(projectId).then(({ project, role }) => {
      setProject(project);
      setRole(role);
      setNameDraft(project.name);
      setSubdomainInput(project.subdomain ?? "");
      const firstHtml = Object.keys(project.files).find((f) => f.endsWith(".html"));
      if (firstHtml) setActiveFile(firstHtml);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const fileNames = useMemo(() => (project ? Object.keys(project.files).sort() : []), [project]);
  const entryFile = useMemo(
    () => fileNames.find((f) => f === "index.html") ?? fileNames.find((f) => f.endsWith(".html")) ?? "",
    [fileNames]
  );
  const previewDoc = useMemo(
    () => (project && entryFile ? buildPreviewDoc(project.files, entryFile) : ""),
    [project, entryFile]
  );

  function scheduleSave(files: Record<string, string>) {
    if (!project || !canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await saveStudioFiles(project.id, files);
        setSavedAt(new Date());
      } finally {
        setSaving(false);
      }
    }, 800); // debounced — saves shortly after typing stops, not on every keystroke
  }

  // Immediate save (skips the debounce) — used by the File menu's "Save"
  // item and Ctrl/Cmd+S, so it behaves like a real editor's save command
  // instead of just resetting the same 800ms timer.
  async function handleSaveNow() {
    if (!project || !canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    try {
      await saveStudioFiles(project.id, project.files);
      setSavedAt(new Date());
    } finally {
      setSaving(false);
    }
  }

  function updateFileContent(path: string, content: string) {
    if (!canEdit) return;
    setProject((prev) => {
      if (!prev) return prev;
      const files = { ...prev.files, [path]: content };
      scheduleSave(files);
      return { ...prev, files };
    });
  }

  function handleNewFile() {
    if (!canEdit) return;
    const name = window.prompt("File name (e.g. about.html or css/extra.css):");
    if (!name || !project) return;
    if (project.files[name] !== undefined) return;
    const files = { ...project.files, [name]: "" };
    setProject({ ...project, files });
    setActiveFile(name);
    scheduleSave(files);
  }

  function handleDeleteFile(path: string) {
    if (!project || !canEdit) return;
    if (!window.confirm(`Delete "${path}"?`)) return;
    const files = { ...project.files };
    delete files[path];
    setProject({ ...project, files });
    if (activeFile === path) {
      const next = Object.keys(files)[0];
      if (next) setActiveFile(next);
    }
    scheduleSave(files);
  }

  // File > Download active file — a lightweight "Save As" since there's
  // no zip-export pipeline here; grabs whatever's currently in the editor
  // (project.files, kept in sync via updateFileContent) for the active tab.
  function handleDownloadFile() {
    if (!project) return;
    const content = project.files[activeFile] ?? "";
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeFile;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleRenameProject() {
    if (!project || !canEdit) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === project.name) {
      setNameDraft(project.name);
      return;
    }
    const { project: updated } = await renameStudioProject(project.id, trimmed);
    setProject(updated);
  }

  async function handleSetSubdomain() {
    if (!project || !canEdit) return;
    setPublishError(null);
    try {
      const { project: updated } = await setStudioSubdomain(project.id, subdomainInput.trim().toLowerCase());
      setProject(updated);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Could not set subdomain");
    }
  }

  async function handlePublish() {
    if (!project || !canEdit) return;
    setPublishing(true);
    setPublishError(null);
    try {
      if (project.subdomain !== subdomainInput.trim().toLowerCase()) {
        await handleSetSubdomain();
      }
      const { project: updated } = await publishStudioProject(project.id);
      setProject(updated);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    if (!project || !canEdit) return;
    const { project: updated } = await unpublishStudioProject(project.id);
    setProject(updated);
  }

  if (!project) return null;

  return (
    <div className="flex flex-col h-full bg-visiyon-bg text-visiyon-text">
      {shareOpen && (
        <ShareModal
          project={project}
          role={role}
          onClose={() => setShareOpen(false)}
          onChanged={(p) => setProject(p)}
        />
      )}

      {/* VS Code-style top menu bar — File/Edit/View/Run/Help, each with
          real commands (backed by the same handlers as the rest of the
          page, plus Monaco's own undo/redo/find/format via editorRef).
          Desktop only — there's no room for it in the tabbed mobile
          layout below. */}
      <div className="hidden lg:flex h-8 shrink-0 items-center gap-0.5 border-b border-visiyon-border px-2 text-[12.5px] bg-visiyon-panel relative">
        <div className="pointer-events-none absolute left-0 right-0 -bottom-px h-px bg-gradient-to-r from-transparent via-emerald-400/50 to-transparent" />
        <div className="flex items-center gap-1.5 pr-3 mr-1 border-r border-visiyon-border text-visiyon-text-2">
          <Code2 size={13} />
          <span className="font-medium text-visiyon-text">{project.name}</span>
        </div>
        {(
          [
            {
              key: "file" as const,
              label: "File",
              items: [
                { label: "New file…", shortcut: "", onClick: handleNewFile, disabled: !canEdit },
                { label: "Save", shortcut: "⌘S", onClick: handleSaveNow, disabled: !canEdit },
                { label: "Download active file", shortcut: "", onClick: handleDownloadFile },
                { divider: true },
                { label: "Rename project…", shortcut: "", onClick: () => { const el = document.getElementById("studio-project-name") as HTMLInputElement | null; el?.focus(); el?.select(); }, disabled: !canEdit },
                { divider: true },
                { label: "Back to chat", shortcut: "", onClick: () => router.push("/") },
              ],
            },
            {
              key: "edit" as const,
              label: "Edit",
              items: [
                { label: "Undo", shortcut: "⌘Z", onClick: () => editorRef.current?.trigger("menu", "undo", null), disabled: !canEdit },
                { label: "Redo", shortcut: "⇧⌘Z", onClick: () => editorRef.current?.trigger("menu", "redo", null), disabled: !canEdit },
                { divider: true },
                { label: "Find", shortcut: "⌘F", onClick: () => editorRef.current?.getAction("actions.find")?.run() },
                { label: "Replace", shortcut: "⌥⌘F", onClick: () => editorRef.current?.getAction("editor.action.startFindReplaceAction")?.run(), disabled: !canEdit },
                { divider: true },
                { label: "Format document", shortcut: "⇧⌥F", onClick: () => editorRef.current?.getAction("editor.action.formatDocument")?.run(), disabled: !canEdit },
              ],
            },
            {
              key: "view" as const,
              label: "View",
              items: [
                { label: "Files panel", shortcut: "", onClick: () => setMobilePane("files") },
                { label: previewOpen ? "Hide preview" : "Show preview", shortcut: "", onClick: () => setPreviewOpen((v) => !v) },
                { divider: true },
                { label: minimapEnabled ? "Hide minimap" : "Show minimap", shortcut: "", onClick: () => setMinimapEnabled((v) => !v) },
                { label: wordWrap ? "Disable word wrap" : "Enable word wrap", shortcut: "⌥Z", onClick: () => setWordWrap((v) => !v) },
                { divider: true },
                { label: "Zoom in", shortcut: "⌘+", onClick: () => setFontSize((s) => Math.min(s + 1, 24)) },
                { label: "Zoom out", shortcut: "⌘-", onClick: () => setFontSize((s) => Math.max(s - 1, 10)) },
                { label: "Reset zoom", shortcut: "", onClick: () => setFontSize(13) },
              ],
            },
            {
              key: "run" as const,
              label: "Run",
              items: project.publishedAt
                ? [
                    { label: "Open published site", shortcut: "", onClick: () => window.open(`https://${project.subdomain}.visiyon.com`, "_blank") },
                    { label: "Unpublish", shortcut: "", onClick: handleUnpublish, disabled: !canEdit },
                  ]
                : [{ label: "Publish…", shortcut: "", onClick: () => setPublishModalOpen(true), disabled: !canEdit }],
            },
            {
              key: "help" as const,
              label: "Help",
              items: [
                { label: "Share this project…", shortcut: "", onClick: () => setShareOpen(true) },
                { label: "Keyboard shortcuts", shortcut: "", onClick: () => editorRef.current?.getAction("editor.action.quickCommand")?.run() },
              ],
            },
          ] as const
        ).map((menu) => (
          <div key={menu.key} className="relative" data-studio-menu>
            <button
              onClick={() => setOpenMenu((m) => (m === menu.key ? null : menu.key))}
              className={`px-2.5 py-1 rounded transition-colors ${
                openMenu === menu.key ? "bg-visiyon-text/[0.12] text-visiyon-text" : "text-visiyon-text-2 hover:bg-visiyon-text/[0.08] hover:text-visiyon-text"
              }`}
            >
              {menu.label}
            </button>
            {openMenu === menu.key && (
              <div className="absolute left-0 top-full mt-1 w-64 py-1 bg-visiyon-panel border border-visiyon-border rounded-lg visiyon-elevated-lg z-30 overflow-visible">
                {menu.items.map((item, i) =>
                  "divider" in item ? (
                    <div key={i} className="my-1 border-t border-visiyon-border" />
                  ) : (
                    <button
                      key={item.label}
                      disabled={"disabled" in item ? item.disabled : false}
                      onClick={() => {
                        item.onClick();
                        setOpenMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-4 px-3 py-1.5 text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.08] hover:text-visiyon-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-visiyon-text-2 transition-colors"
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <span className="text-[11px] text-visiyon-text-3">{item.shortcut}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2 text-visiyon-text-3 text-[11.5px] pl-3">
          {saving ? "Saving…" : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : ""}
        </div>
      </div>

      {/* Below `lg` the three columns don't fit side by side, so only one
          shows at a time, switched via these tabs. */}
      <div className="lg:hidden h-11 shrink-0 flex items-center border-b border-visiyon-border px-2 gap-1">
        <Link href="/" className="p-2 text-visiyon-text-2 hover:text-visiyon-text shrink-0">
          <ArrowLeft size={16} />
        </Link>
        {[
          { key: "files" as const, label: "Files", icon: FilePlus },
          { key: "editor" as const, label: "Editor", icon: Code2 },
          { key: "preview" as const, label: "Preview", icon: Eye },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setMobilePane(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium ${
              mobilePane === key ? "bg-white text-black" : "text-visiyon-text-2 hover:bg-visiyon-text/[0.06]"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
        <button
          onClick={() => setShareOpen(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-visiyon-text-2 hover:bg-visiyon-text/[0.06] shrink-0"
        >
          <Users size={14} /> Share
        </button>
      </div>

      <div className="flex flex-1 min-h-0 relative">
      {/* File tree — collapsible: a slim icon rail when collapsed, giving
          the editor the room it deserves instead of a fixed 224px column
          eating into it permanently. */}
      <div
        className={`${mobilePane === "files" ? "flex" : "hidden"} lg:flex ${
          sidebarCollapsed ? "lg:w-11" : "lg:w-56"
        } w-full lg:shrink-0 border-r border-visiyon-border flex-col transition-[width] duration-150 bg-visiyon-panel/40`}
      >
        {sidebarCollapsed ? (
          <div className="hidden lg:flex flex-col items-center gap-3 pt-4">
            <button
              onClick={() => setSidebarCollapsed(false)}
              title="Expand sidebar"
              className="p-1.5 rounded-lg text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.08]"
            >
              <PanelLeftOpen size={16} />
            </button>
            <div className="w-full border-t border-visiyon-border" />
            {canEdit && (
              <button onClick={handleNewFile} title="New file" className="p-1.5 rounded-lg text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.08]">
                <FilePlus size={15} />
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="hidden lg:flex items-center justify-between px-4 pt-4 pb-2">
              <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
                <ArrowLeft size={14} /> Back to chat
              </Link>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShareOpen(true)}
                  title="Share this project"
                  className="flex items-center gap-1 text-[13px] text-visiyon-text-2 hover:text-visiyon-text"
                >
                  <Users size={14} />
                  {project.members.length > 0 && <span>{project.members.length}</span>}
                </button>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  title="Collapse sidebar"
                  className="p-1 rounded text-visiyon-text-2 hover:text-visiyon-text hover:bg-visiyon-text/[0.08]"
                >
                  <PanelLeftClose size={15} />
                </button>
              </div>
            </div>
            <div className="hidden lg:block px-4 pb-2">
              <input
                id="studio-project-name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={handleRenameProject}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                disabled={!canEdit}
                className="w-full bg-transparent text-sm font-medium outline-none border-b border-transparent focus:border-visiyon-border disabled:opacity-70"
              />
              {role !== "OWNER" && (
                <p className="text-[11px] text-visiyon-text-2 mt-0.5">
                  Shared by {project.user.name || project.user.email} · {role === "EDITOR" ? "you can edit" : "view only"}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-xs font-medium text-visiyon-text-2 uppercase tracking-wide flex items-center gap-1.5">
                <FolderKanban size={12} /> Files
              </span>
              {canEdit && (
                <button onClick={handleNewFile} title="New file" className="text-visiyon-text-2 hover:text-visiyon-text p-1">
                  <FilePlus size={15} />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-1.5 space-y-0.5">
              {fileNames.map((name) => (
                <div
                  key={name}
                  className={`group flex items-center justify-between rounded-lg pl-2.5 pr-2.5 py-1.5 text-sm cursor-pointer border-l-2 transition-colors ${
                    activeFile === name
                      ? "bg-visiyon-text/10 text-visiyon-text border-emerald-400"
                      : "text-visiyon-text-2 hover:bg-visiyon-text/[0.06] border-transparent"
                  }`}
                  onClick={() => {
                    setActiveFile(name);
                    setMobilePane("editor");
                  }}
                >
                  <span className="truncate font-mono text-[12.5px]">{name}</span>
                  {canEdit && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteFile(name);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-visiyon-text-2 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="px-3 py-2 text-[11px] text-visiyon-text-2 flex items-center gap-1.5">
              {saving ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Saving...
                </>
              ) : savedAt ? (
                <>
                  <Save size={12} /> Saved {savedAt.toLocaleTimeString("en-US")}
                </>
              ) : !canEdit ? (
                <span>View only</span>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* Editor — takes the full remaining width now that preview/publish
          are on-demand overlays instead of a permanent third column. */}
      <div className={`${mobilePane === "editor" ? "flex" : "hidden"} lg:flex flex-1 min-w-0 flex-col`}>
        <div className="h-10 border-b border-visiyon-border flex items-center px-4 gap-3">
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              title="Show files"
              className="hidden lg:block text-visiyon-text-2 hover:text-visiyon-text -ml-1"
            >
              <PanelLeftOpen size={15} />
            </button>
          )}
          <span className="text-sm text-visiyon-text-2 font-mono flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]" />
            {activeFile}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setPreviewOpen((v) => !v)}
              title="Toggle live preview"
              className={`hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12.5px] transition-colors ${
                previewOpen ? "bg-visiyon-text/[0.12] text-visiyon-text" : "text-visiyon-text-2 hover:bg-visiyon-text/[0.08] hover:text-visiyon-text"
              }`}
            >
              <Eye size={13} /> Preview
            </button>
            <button
              onClick={() => setPublishModalOpen(true)}
              title="Publish this site"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12.5px] text-visiyon-text-2 hover:bg-visiyon-text/[0.08] hover:text-visiyon-text transition-colors"
            >
              <Globe size={13} />
              {project.publishedAt ? "Published" : "Publish"}
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <MonacoEditor
            key={activeFile}
            height="100%"
            theme="vs-dark"
            path={activeFile}
            language={languageForPath(activeFile)}
            value={project.files[activeFile] ?? ""}
            onChange={(value) => updateFileContent(activeFile, value ?? "")}
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            options={{
              minimap: { enabled: minimapEnabled },
              fontSize,
              wordWrap: wordWrap ? "on" : "off",
              automaticLayout: true,
              readOnly: !canEdit,
              // Polish pass: smooth cursor + caret animation, a subtly
              // highlighted current line, visible indent/bracket guides,
              // and a monospace stack that prefers ligature-friendly fonts
              // when installed — reads as a real, modern editor instead of
              // Monaco's bare defaults.
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "on",
              smoothScrolling: true,
              renderLineHighlight: "all",
              fontLigatures: true,
              fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
              padding: { top: 14 },
              guides: { indentation: true, bracketPairs: true },
              bracketPairColorization: { enabled: true },
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </div>

      {/* Live preview — on-demand overlay (not a permanent column): a
          right-hand slide-over on desktop when toggled from the tab bar
          above, or a full-pane swap on mobile via the tab strip. */}
      {(previewOpen || mobilePane === "preview") && (
        <div
          className={`${
            mobilePane === "preview" ? "flex" : "hidden"
          } lg:flex ${
            previewOpen ? "lg:flex" : "lg:hidden"
          } w-full lg:absolute lg:right-0 lg:top-0 lg:bottom-0 lg:w-[420px] lg:z-20 border-l border-visiyon-border flex-col bg-visiyon-bg lg:shadow-2xl`}
        >
          <div className="h-10 border-b border-visiyon-border flex items-center px-4 text-sm text-visiyon-text-2 gap-2">
            <Eye size={13} /> Preview
            <button
              onClick={() => {
                setPreviewOpen(false);
                if (mobilePane === "preview") setMobilePane("editor");
              }}
              className="ml-auto text-visiyon-text-2 hover:text-visiyon-text"
            >
              <X size={15} />
            </button>
          </div>
          <div className="flex-1 min-h-0 bg-white">
            <iframe title="preview" className="w-full h-full" sandbox="allow-scripts" srcDoc={previewDoc} />
          </div>
        </div>
      )}
      </div>

      {/* Publish modal — subdomain + publish/unpublish, opened on demand
          from the tab bar's Publish button or the Run menu, instead of
          permanently occupying screen space. */}
      {publishModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4" onClick={() => setPublishModalOpen(false)}>
          <div
            className="w-full max-w-sm bg-visiyon-panel border border-visiyon-border rounded-2xl visiyon-elevated-lg p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold flex items-center gap-2">
                <Globe size={15} /> Publish
              </h3>
              <button onClick={() => setPublishModalOpen(false)} className="text-visiyon-text-2 hover:text-visiyon-text">
                <X size={16} />
              </button>
            </div>
            <div>
              <label className="text-xs text-visiyon-text-2 block mb-1">Subdomain</label>
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={subdomainInput}
                  onChange={(e) => setSubdomainInput(e.target.value)}
                  placeholder="mysite"
                  disabled={!canEdit}
                  className="flex-1 min-w-0 bg-visiyon-text/[0.06] rounded-lg px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-white/30 disabled:opacity-60"
                />
                <span className="text-xs text-visiyon-text-2 whitespace-nowrap">.visiyon.com</span>
              </div>
            </div>
            {publishError && <p className="text-xs text-red-400">{publishError}</p>}
            {canEdit && (
              <button
                onClick={handlePublish}
                disabled={publishing || !subdomainInput.trim()}
                className="w-full flex items-center justify-center gap-2 text-sm font-medium px-3 py-2 rounded-xl bg-white text-black hover:bg-visiyon-text/90 disabled:opacity-50 transition-colors"
              >
                {publishing ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />}
                Publish
              </button>
            )}
            {project.publishedAt && project.subdomain && (
              <div className="flex items-center justify-between text-xs text-visiyon-text-2 pt-1 border-t border-visiyon-border">
                <a
                  href={`https://${project.subdomain}.visiyon.com`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:text-visiyon-text"
                >
                  {project.subdomain}.visiyon.com <ExternalLink size={11} />
                </a>
                {canEdit && (
                  <button onClick={handleUnpublish} className="hover:text-red-400">
                    Unpublish
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
