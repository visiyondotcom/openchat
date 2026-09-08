"use client";

import { useEffect, useState } from "react";
import { X, Trash2, Plus, BrainCircuit } from "lucide-react";
import { listUserMemories, addUserMemory, updateUserMemory, deleteUserMemory, clearUserMemories, UserMemory } from "@/lib/api";
import { askConfirm } from "@/components/PromptDialog";

// Admin > Users > a user's "Memory" button — shows and lets an admin
// edit exactly what the AI has learned about this user (see
// backend/src/lib/memory.ts), independent of memoriesEnabled/
// memorySystemContextEnabled which just gate whether this happens at all.
export default function UserMemoryModal({
  userId,
  userLabel,
  onClose,
}: {
  userId: string;
  userLabel: string;
  onClose: () => void;
}) {
  const [memories, setMemories] = useState<UserMemory[] | null>(null);
  const [newFact, setNewFact] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [saving, setSaving] = useState(false);

  function refresh() {
    listUserMemories(userId)
      .then((r) => setMemories(r.memories))
      .catch(() => setMemories([]));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleAdd() {
    const content = newFact.trim();
    if (!content) return;
    setSaving(true);
    try {
      await addUserMemory(userId, content);
      setNewFact("");
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit(id: string) {
    const content = editingValue.trim();
    if (!content) return;
    await updateUserMemory(userId, id, content);
    setEditingId(null);
    refresh();
  }

  async function handleDelete(id: string) {
    await deleteUserMemory(userId, id);
    refresh();
  }

  async function handleClearAll() {
    if (
      await askConfirm({
        title: `Forget everything about ${userLabel}? This deletes all ${memories?.length ?? 0} stored facts.`,
        confirmLabel: "Forget all",
        danger: true,
      })
    ) {
      await clearUserMemories(userId);
      refresh();
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-visiyon-panel border border-visiyon-border rounded-[6px] w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-visiyon-border">
          <h2 className="text-[15px] font-semibold flex items-center gap-2">
            <BrainCircuit size={17} /> Memory — {userLabel}
          </h2>
          <button onClick={onClose} className="text-visiyon-text-3 hover:text-visiyon-text">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[12px] text-visiyon-text-3 mb-4">
            What the AI has learned about this user from past conversations, plus their name (pulled
            automatically from their account). Edit or remove anything, or add a fact by hand.
          </p>

          {memories === null && <p className="text-[13px] text-visiyon-text-3">Loading…</p>}
          {memories !== null && memories.length === 0 && (
            <p className="text-[13px] text-visiyon-text-3">No stored facts yet.</p>
          )}

          <div className="space-y-2 mb-4">
            {memories?.map((m) => (
              <div key={m.id} className="flex items-start gap-2 border border-visiyon-border rounded-[6px] px-3 py-2">
                {editingId === m.id ? (
                  <>
                    <input
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSaveEdit(m.id)}
                      autoFocus
                      className="flex-1 text-[13px] bg-transparent text-visiyon-text outline-none border-b border-visiyon-border focus:border-visiyon-text"
                    />
                    <button onClick={() => handleSaveEdit(m.id)} className="text-[12px] text-visiyon-text-2 hover:text-visiyon-text shrink-0">
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditingId(m.id);
                        setEditingValue(m.content);
                      }}
                      className="flex-1 text-left text-[13px] text-visiyon-text-2 hover:text-visiyon-text"
                      title="Click to edit"
                    >
                      {m.content}
                    </button>
                    <span className="text-[10px] text-visiyon-text-3 shrink-0 mt-0.5">{m.source}</span>
                    <button onClick={() => handleDelete(m.id)} className="text-visiyon-text-3 hover:text-red-400 shrink-0">
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              value={newFact}
              onChange={(e) => setNewFact(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder='Add a fact by hand, e.g. "Prefers concise answers"'
              autoComplete="off"
              className="flex-1 text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
            />
            <button
              onClick={handleAdd}
              disabled={saving || !newFact.trim()}
              className="flex items-center gap-1 text-[12.5px] font-medium px-3 py-2 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors disabled:opacity-40"
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-visiyon-border flex justify-between">
          <button
            onClick={handleClearAll}
            disabled={!memories || memories.length === 0}
            className="text-[12.5px] text-visiyon-text-3 hover:text-red-400 disabled:opacity-40"
          >
            Forget everything about this user
          </button>
          <button onClick={onClose} className="text-[12.5px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
