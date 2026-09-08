"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import Link from "next/link";
import { arenaBattle, arenaVote, arenaLeaderboard, listModels } from "@/lib/api";
import { Trophy, Swords, ArrowLeft } from "lucide-react";
import ModelSelector from "@/components/ModelSelector";

interface Battle {
  prompt: string;
  modelA: string;
  modelB: string;
  responseA: string;
  responseB: string;
}
interface Rating {
  modelName: string;
  rating: number;
  votes: number;
}

export default function ArenaPage() {
  const { ready } = useRequireAuth();
  const [models, setModels] = useState<{ name: string }[]>([]);
  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [prompt, setPrompt] = useState("");
  const [battle, setBattle] = useState<Battle | null>(null);
  const [loading, setLoading] = useState(false);
  const [voted, setVoted] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Rating[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refreshLeaderboard() {
    try {
      const { leaderboard } = await arenaLeaderboard();
      setLeaderboard(leaderboard);
    } catch {
      setLeaderboard([]);
    }
  }
  useEffect(() => {
    refreshLeaderboard();
    listModels()
      .then((m) => {
        setModels(m);
        if (m.length > 0) setModelA((prev) => prev || m[0].name);
        if (m.length > 1) setModelB((prev) => prev || m[1].name);
      })
      .catch(() => setModels([]));
  }, []);

  async function handleBattle() {
    if (!prompt.trim() || !modelA || !modelB) return;
    setLoading(true);
    setVoted(false);
    setError(null);
    try {
      const result = await arenaBattle(prompt, modelA, modelB);
      setBattle(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Battle failed — check that both models are available.");
      setBattle(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleVote(winner: "A" | "B" | "TIE" | "BOTH_BAD") {
    if (!battle || voted) return;
    try {
      await arenaVote(battle, winner);
      setVoted(true);
      await refreshLeaderboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vote failed");
    }
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto bg-visiyon-bg text-visiyon-text">
    <div className="p-6 max-w-5xl mx-auto">
      <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text mb-4 w-fit">
        <ArrowLeft size={14} /> Back to chat
      </Link>
      <h1 className="text-xl font-semibold flex items-center gap-2 mb-6">
        <Swords size={20} /> Model Arena
      </h1>

      <div className="flex flex-wrap gap-3 mb-4">
        <ModelSelector value={modelA} onChange={setModelA} />
        <ModelSelector value={modelB} onChange={setModelB} />
      </div>
      {error && (
        <div className="mb-4 text-[13px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <div className="flex gap-2 mb-8">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleBattle()}
          placeholder="Ask both models the same prompt…"
          className="flex-1 bg-visiyon-text/5 rounded-lg px-3 py-2 text-sm outline-none focus:bg-visiyon-text/10 transition-colors placeholder:text-visiyon-text-3"
        />
        <button
          onClick={handleBattle}
          disabled={loading || !modelA || !modelB}
          className="px-4 py-2 rounded-lg bg-visiyon-accent text-visiyon-bg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {loading ? "Battling…" : "Battle"}
        </button>
      </div>

      {battle && (
        <div className="grid grid-cols-2 gap-4 mb-4">
          {(["A", "B"] as const).map((side) => (
            <div key={side} className="bg-visiyon-text/5 rounded-lg p-4">
              <div className="text-xs text-visiyon-text-3 mb-2">{side === "A" ? battle.modelA : battle.modelB}</div>
              <p className="text-sm whitespace-pre-wrap">{side === "A" ? battle.responseA : battle.responseB}</p>
            </div>
          ))}
        </div>
      )}

      {battle && (
        <div className="flex gap-2 mb-10">
          <button onClick={() => handleVote("A")} disabled={voted} className="flex-1 py-2 rounded bg-visiyon-text/10 hover:bg-visiyon-text/20 text-sm disabled:opacity-40">A is better</button>
          <button onClick={() => handleVote("B")} disabled={voted} className="flex-1 py-2 rounded bg-visiyon-text/10 hover:bg-visiyon-text/20 text-sm disabled:opacity-40">B is better</button>
          <button onClick={() => handleVote("TIE")} disabled={voted} className="flex-1 py-2 rounded bg-visiyon-text/10 hover:bg-visiyon-text/20 text-sm disabled:opacity-40">Tie</button>
          <button onClick={() => handleVote("BOTH_BAD")} disabled={voted} className="flex-1 py-2 rounded bg-visiyon-text/10 hover:bg-visiyon-text/20 text-sm disabled:opacity-40">Both bad</button>
        </div>
      )}

      <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
        <Trophy size={18} /> Leaderboard
      </h2>
      <table className="w-full text-sm">
        <thead className="text-visiyon-text-3 text-left">
          <tr>
            <th className="py-2">Model</th>
            <th className="py-2">Rating</th>
            <th className="py-2">Votes</th>
          </tr>
        </thead>
        <tbody>
          {(leaderboard ?? [])
            .sort((a, b) => b.rating - a.rating)
            .map((r) => (
              <tr key={r.modelName} className="border-t border-white/5">
                <td className="py-2">{r.modelName}</td>
                <td className="py-2">{r.rating}</td>
                <td className="py-2">{r.votes}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
