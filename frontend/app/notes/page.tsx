"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import Link from "next/link";
import { listNotes, createNote, updateNote, deleteNote } from "@/lib/api";
import { Plus, Trash2, Pin, ArrowLeft } from "lucide-react";

interface Note {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt: string;
}

export default function NotesPage() {
  const { ready } = useRequireAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [active, setActive] = useState<Note | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const { notes } = await listNotes();
    setNotes(notes);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function handleNew() {
    const { note } = await createNote({});
    await refresh();
    setActive(note);
  }

  async function handleSave(note: Note) {
    setSaving(true);
    try {
      await updateNote(note.id, { title: note.title, content: note.content, pinned: note.pinned });
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteNote(id);
    if (active?.id === id) setActive(null);
    await refresh();
  }

  if (!ready) return null;

  return (
    <div className="flex h-full bg-visiyon-bg text-visiyon-text">
      <div className={`${active ? "hidden md:flex" : "flex"} w-full md:w-72 shrink-0 border-r border-visiyon-border flex-col`}>
        <div className="px-4 pt-4">
          <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
            <ArrowLeft size={14} /> Back to chat
          </Link>
        </div>
        <div className="p-4 flex items-center justify-between">
          <h1 className="font-semibold">Notes</h1>
          <button onClick={handleNew} className="p-1.5 rounded hover:bg-visiyon-text/10">
            <Plus size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {(notes ?? [])
            .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
            .map((n) => (
              <button
                key={n.id}
                onClick={() => setActive(n)}
                className={`w-full text-left px-4 py-3 border-b border-white/5 hover:bg-visiyon-text/5 ${active?.id === n.id ? "bg-visiyon-text/10" : ""}`}
              >
                <div className="flex items-center gap-1.5">
                  {n.pinned && <Pin size={12} className="text-visiyon-accent" />}
                  <span className="truncate font-medium">{n.title || "Untitled note"}</span>
                </div>
                <p className="text-xs text-visiyon-text-3 truncate mt-1">{n.content.slice(0, 80)}</p>
              </button>
            ))}
          {notes.length === 0 && <p className="p-4 text-sm text-visiyon-text-3">No notes yet — create one to get started.</p>}
        </div>
      </div>

      <div className={`${active ? "flex" : "hidden md:flex"} flex-1 flex-col w-full min-w-0`}>
        {active ? (
          <>
            <div className="flex items-center gap-2 p-4 border-b border-visiyon-border">
              <button
                onClick={() => setActive(null)}
                className="md:hidden p-1 -ml-1 text-visiyon-text-2 hover:text-visiyon-text shrink-0"
                title="Back to notes"
              >
                <ArrowLeft size={18} />
              </button>
              <input
                value={active.title}
                onChange={(e) => setActive({ ...active, title: e.target.value })}
                onBlur={() => handleSave(active)}
                className="flex-1 bg-transparent text-lg font-semibold outline-none"
                placeholder="Untitled note"
              />
              <button
                onClick={() => handleSave({ ...active, pinned: !active.pinned })}
                className={`p-1.5 rounded hover:bg-visiyon-text/10 ${active.pinned ? "text-visiyon-accent" : "text-visiyon-text-3"}`}
                title="Pin"
              >
                <Pin size={16} />
              </button>
              <button onClick={() => handleDelete(active.id)} className="p-1.5 rounded hover:bg-visiyon-text/10 text-red-400">
                <Trash2 size={16} />
              </button>
              {saving && <span className="text-xs text-visiyon-text-3">Saving…</span>}
            </div>
            <textarea
              value={active.content}
              onChange={(e) => setActive({ ...active, content: e.target.value })}
              onBlur={() => handleSave(active)}
              className="flex-1 bg-transparent p-4 outline-none resize-none font-mono text-sm"
              placeholder="Write in Markdown…"
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-visiyon-text-3">Select or create a note</div>
        )}
      </div>
    </div>
  );
}
