"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import {
  apiFetch,
  listGroups,
  setUserGroup,
  Group,
  Invite,
  listInvites,
  createInvite,
  resendInvite,
  revokeInvite,
} from "@/lib/api";
import { askConfirm } from "@/components/PromptDialog";
import UserMemoryModal from "@/components/UserMemoryModal";
import Select from "@/components/Select";
import { Trash2, BrainCircuit, UserPlus, X, RotateCw } from "lucide-react";

interface User {
  id: string;
  email: string;
  name?: string;
  role: "USER" | "ADMIN";
  groupId?: string | null;
  group?: { id: string; name: string } | null;
  createdAt: string;
  lastActiveAt?: string | null;
}

function isOnline(iso?: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 2 * 60 * 1000;
}

function timeAgoOrDate(iso?: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "a few seconds ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function inviteStatus(inv: Invite): { label: string; className: string } {
  if (inv.revokedAt) return { label: "Revoked", className: "text-visiyon-text-3" };
  if (inv.acceptedAt) return { label: "Accepted", className: "text-green-400" };
  if (new Date(inv.expiresAt) < new Date()) return { label: "Expired", className: "text-visiyon-text-3" };
  return { label: "Pending", className: "text-amber-400" };
}

// Its own page (Admin > Users, previously a section crammed onto the
// bottom of the general Overview page alongside models/groups/pipelines)
// so the user list has room to breathe and isn't lost in a long scroll.
export default function AdminUsersPage() {
  const ready = useRequireAdmin();
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [memoryUser, setMemoryUser] = useState<User | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);

  function refreshUsers() {
    apiFetch("/admin/users").then((d) => setUsers(d.users)).catch(() => {});
  }
  function refreshGroups() {
    listGroups().then(setGroups).catch(() => {});
  }
  function refreshInvites() {
    listInvites().then(setInvites).catch(() => {});
  }

  useEffect(() => {
    if (!ready) return;
    refreshUsers();
    refreshGroups();
    refreshInvites();
    // Refetch periodically so the online/offline dot (derived from
    // lastActiveAt) stays accurate while this page is left open.
    const t = setInterval(refreshUsers, 30000);
    return () => clearInterval(t);
  }, [ready]);

  if (!ready) return null;

  const pendingInvites = invites.filter((i) => inviteStatus(i).label === "Pending");

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Users</h1>
            <p className="text-[12.5px] text-visiyon-text-3 mt-1">
              {users.length} user{users.length === 1 ? "" : "s"}
              {pendingInvites.length > 0 &&
                ` · ${pendingInvites.length} pending invite${pendingInvites.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <button
            onClick={() => setInviteModalOpen(true)}
            className="flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-2 rounded-[6px] bg-white text-black hover:bg-visiyon-text/85 transition-colors"
          >
            <UserPlus size={14} /> Invite user
          </button>
        </div>

        <div className="rounded-[6px] overflow-hidden">
          <div className="grid grid-cols-[90px_1.3fr_1.6fr_1fr_1fr_auto] gap-3 px-5 py-2.5 text-[11px] uppercase tracking-wide text-visiyon-text-3 border-b border-visiyon-border">
            <span>Role</span>
            <span>Name</span>
            <span>Email</span>
            <span className="text-center">Last active</span>
            <span className="text-center">Created at</span>
            <span></span>
          </div>
          {users.map((u) => (
            <div
              key={u.id}
              className="grid grid-cols-[90px_1.3fr_1.6fr_1fr_1fr_auto] gap-3 items-center px-5 py-3 border-b border-visiyon-border last:border-0"
            >
              <button
                onClick={async () => {
                  await apiFetch(`/admin/users/${u.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ role: u.role === "ADMIN" ? "USER" : "ADMIN" }),
                  });
                  refreshUsers();
                }}
                title="Click to change this user's role"
                className="text-[11px] font-medium border border-visiyon-border rounded-full px-2.5 py-1 hover:border-visiyon-text transition-colors w-fit"
              >
                {u.role}
              </button>
              <span className="text-sm font-medium truncate">{u.name || u.email.split("@")[0]}</span>
              <span className="text-[12.5px] text-visiyon-text-3 truncate">{u.email}</span>
              <span className="text-[12px] text-visiyon-text-3 text-center flex items-center justify-center gap-1.5">
                {isOnline(u.lastActiveAt) ? (
                  <span className="relative w-2 h-2 shrink-0" title="Online">
                    <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-75" />
                    <span className="absolute inset-0 rounded-full bg-emerald-500" />
                  </span>
                ) : (
                  <span className="w-2 h-2 rounded-full shrink-0 bg-yellow-500" title="Offline" />
                )}
                {timeAgoOrDate(u.lastActiveAt)}
              </span>
              <span className="text-[12px] text-visiyon-text-3 text-center">{fmtDate(u.createdAt)}</span>
              <div className="flex items-center gap-2 justify-end">
                <Select
                  value={u.groupId ?? ""}
                  onChange={async (v) => {
                    await setUserGroup(u.id, v || null);
                    refreshUsers();
                    refreshGroups();
                  }}
                  options={[{ value: "", label: "No group" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
                  className="w-28"
                  buttonClassName="rounded-full py-1 text-[11px]"
                />
                <button
                  onClick={() => setMemoryUser(u)}
                  className="text-visiyon-text-3 hover:text-visiyon-text"
                  title="View/edit what the AI remembers about this user"
                >
                  <BrainCircuit size={14} />
                </button>
                <button
                  onClick={async () => {
                    if (
                      await askConfirm({
                        title: `Delete user "${u.email}"? This removes their account, chats and data.`,
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    ) {
                      await apiFetch(`/admin/users/${u.id}`, { method: "DELETE" });
                      refreshUsers();
                    }
                  }}
                  className="text-visiyon-text-3 hover:text-red-400"
                  title="Delete user"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {invites.length > 0 && (
          <div className="mt-10">
            <h2 className="text-[13px] font-semibold text-visiyon-text-2 mb-3">Invites</h2>
            <div className="rounded-[6px] overflow-hidden">
              <div className="grid grid-cols-[1.6fr_90px_1fr_1fr_100px_auto] gap-3 px-5 py-2.5 text-[11px] uppercase tracking-wide text-visiyon-text-3 border-b border-visiyon-border">
                <span>Email</span>
                <span>Role</span>
                <span>Group</span>
                <span>Expires</span>
                <span>Status</span>
                <span></span>
              </div>
              {invites.map((inv) => {
                const status = inviteStatus(inv);
                const pending = status.label === "Pending";
                return (
                  <div
                    key={inv.id}
                    className="grid grid-cols-[1.6fr_90px_1fr_1fr_100px_auto] gap-3 items-center px-5 py-3 border-b border-visiyon-border last:border-0"
                  >
                    <span className="text-[12.5px] text-visiyon-text-2 truncate">{inv.email}</span>
                    <span className="text-[11px] font-medium border border-visiyon-border rounded-full px-2.5 py-1 w-fit">
                      {inv.role}
                    </span>
                    <span className="text-[12px] text-visiyon-text-3 truncate">{inv.group?.name || "No group"}</span>
                    <span className="text-[12px] text-visiyon-text-3">{fmtDate(inv.expiresAt)}</span>
                    <span className={`text-[12px] font-medium ${status.className}`}>{status.label}</span>
                    <div className="flex items-center gap-2 justify-end">
                      {pending && (
                        <>
                          <button
                            onClick={async () => {
                              await resendInvite(inv.id);
                              refreshInvites();
                            }}
                            className="text-visiyon-text-3 hover:text-visiyon-text"
                            title="Resend invite (refreshes the link and expiry)"
                          >
                            <RotateCw size={14} />
                          </button>
                          <button
                            onClick={async () => {
                              if (
                                await askConfirm({
                                  title: `Revoke the invite to "${inv.email}"?`,
                                  confirmLabel: "Revoke",
                                  danger: true,
                                })
                              ) {
                                await revokeInvite(inv.id);
                                refreshInvites();
                              }
                            }}
                            className="text-visiyon-text-3 hover:text-red-400"
                            title="Revoke invite"
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {memoryUser && (
        <UserMemoryModal
          userId={memoryUser.id}
          userLabel={memoryUser.name || memoryUser.email}
          onClose={() => setMemoryUser(null)}
        />
      )}

      {inviteModalOpen && (
        <InviteUserModal
          groups={groups}
          onClose={() => setInviteModalOpen(false)}
          onInvited={() => {
            setInviteModalOpen(false);
            refreshInvites();
          }}
        />
      )}
    </div>
  );
}

function InviteUserModal({
  groups,
  onClose,
  onInvited,
}: {
  groups: Group[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");
  const [groupId, setGroupId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await createInvite({ email: email.trim(), role, groupId: groupId || null });
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-visiyon-panel border border-visiyon-border rounded-[6px] w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-visiyon-border">
          <h2 className="text-[15px] font-semibold flex items-center gap-2">
            <UserPlus size={17} /> Invite user
          </h2>
          <button onClick={onClose} className="text-visiyon-text-3 hover:text-visiyon-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-visiyon-text-3 mb-1 block">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 text-sm outline-none focus:border-visiyon-text transition-colors"
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-visiyon-text-3 mb-1 block">Role</label>
            <Select
              value={role}
              onChange={(v) => setRole(v as "USER" | "ADMIN")}
              options={[
                { value: "USER", label: "User" },
                { value: "ADMIN", label: "Admin" },
              ]}
              className="w-full"
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-visiyon-text-3 mb-1 block">Group</label>
            <Select
              value={groupId}
              onChange={setGroupId}
              options={[{ value: "", label: "No group" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
              className="w-full"
            />
          </div>

          {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !email.trim()}
            className="w-full bg-white text-black rounded-[6px] py-2.5 text-sm font-medium hover:bg-visiyon-text/85 transition-colors disabled:opacity-40 disabled:hover:bg-white"
          >
            {submitting ? "Sending…" : "Send invite"}
          </button>
        </form>
      </div>
    </div>
  );
}
