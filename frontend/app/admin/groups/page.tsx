"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import { askConfirm } from "@/components/PromptDialog";
import { apiFetch, listGroups, createGroup, updateGroup, deleteGroup, Group } from "@/lib/api";
import { Plus, Trash2 } from "lucide-react";

export default function AdminGroupsPage() {
  const ready = useRequireAdmin();
  const [groups, setGroups] = useState<Group[]>([]);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  function refreshGroups() {
    listGroups().then(setGroups).catch(() => {});
  }

  useEffect(() => {
    refreshGroups();
    apiFetch("/admin/health")
      .then((h) => setAvailableModels(h?.ollama?.models ?? []))
      .catch(() => {});
  }, []);

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    await createGroup({ name: newGroupName.trim() });
    setNewGroupName("");
    setCreatingGroup(false);
    refreshGroups();
  }

  async function toggleGroupModel(group: Group, model: string) {
    const has = group.modelAccess.includes(model);
    const modelAccess = has ? group.modelAccess.filter((m) => m !== model) : [...group.modelAccess, model];
    await updateGroup(group.id, { modelAccess });
    refreshGroups();
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-semibold">Groups &amp; Access</h1>
          <button
            onClick={() => setCreatingGroup((v) => !v)}
            className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors"
          >
            <Plus size={14} /> New group
          </button>
        </div>

        {creatingGroup && (
          <div className="flex gap-2 mb-4">
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Group name"
              className="flex-1 text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
            />
            <button
              onClick={handleCreateGroup}
              className="text-[13px] font-medium px-4 py-2 rounded-[6px] bg-white text-black"
            >
              Create
            </button>
          </div>
        )}

        <p className="text-[12px] text-visiyon-text-3 mb-4">
          No models checked = group can use all models. Check models to restrict the group to only those models.
        </p>

        <div className="space-y-3">
          {groups.length === 0 && <p className="text-visiyon-text-3 text-sm">No groups created yet.</p>}
          {groups.map((g) => (
            <div key={g.id} className="rounded-[6px] p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    {g.name}
                    {g.isDefault && (
                      <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full bg-white text-black">
                        Default for new accounts
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-visiyon-text-3">{g._count?.users ?? 0} user(s)</div>
                </div>
                <div className="flex items-center gap-3">
                  {!g.isDefault && (
                    <button
                      onClick={async () => {
                        await updateGroup(g.id, { isDefault: true });
                        refreshGroups();
                      }}
                      className="text-[12px] text-visiyon-text-3 hover:text-visiyon-text transition-colors"
                      title="Every new account is automatically placed in this group"
                    >
                      Make default
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (await askConfirm({ title: `Delete group "${g.name}"? Members will lose their restriction (gain full access).`, confirmLabel: "Delete", danger: true })) {
                        await deleteGroup(g.id);
                        refreshGroups();
                      }
                    }}
                    className="text-visiyon-text-3 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mb-3">
                {availableModels.length === 0 && (
                  <p className="text-[12px] text-visiyon-text-3">No models detected.</p>
                )}
                {availableModels.map((m) => {
                  const active = g.modelAccess.includes(m);
                  return (
                    <button
                      key={m}
                      onClick={() => toggleGroupModel(g, m)}
                      className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                        active ? "bg-white text-black border-visiyon-text" : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 pt-3 border-t border-visiyon-border">
                <div className="flex items-center gap-2">
                  <label className="text-[12px] text-visiyon-text-3">Token limit (rolling window)</label>
                  <input
                    type="number"
                    min={1}
                    placeholder="Default: 500"
                    defaultValue={g.dailyTokenQuota ?? ""}
                    onBlur={async (e) => {
                      const val = e.target.value.trim();
                      await updateGroup(g.id, { dailyTokenQuota: val ? Number(val) : null });
                      refreshGroups();
                    }}
                    className="w-24 text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-1 outline-none focus:border-visiyon-text"
                  />
                  <span className="text-[11px] text-visiyon-text-3">(afbeeldingen tellen hierin mee)</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
