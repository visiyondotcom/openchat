"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import { arenaLeaderboard, listFlaggedMessages, FlaggedMessage } from "@/lib/api";
import { Trophy, MessageSquareWarning } from "lucide-react";

interface ArenaRatingRow {
  modelName: string;
  rating: number;
  votes: number;
  updatedAt: string;
}

type SubTab = "leaderboard" | "feedback";

export default function AdminEvaluationsPage() {
  const ready = useRequireAdmin();
  const [subTab, setSubTab] = useState<SubTab>("leaderboard");
  const [ratings, setRatings] = useState<ArenaRatingRow[]>([]);
  const [flagged, setFlagged] = useState<FlaggedMessage[]>([]);

  useEffect(() => {
    arenaLeaderboard().then((d) => setRatings(d.ratings)).catch(() => {});
    listFlaggedMessages().then(setFlagged).catch(() => {});
  }, []);

  if (!ready) return null;

  // Highest votes among all rows — used to size a simple win/loss bar per
  // row without a charting dependency, same spirit as OpenWebUI's table.
  const maxVotes = Math.max(1, ...ratings.map((r) => r.votes));

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        </div>

        <div className="flex gap-6 mb-6 border-b border-visiyon-border">
          <button
            onClick={() => setSubTab("leaderboard")}
            className={`flex items-center gap-1.5 pb-2.5 text-[13.5px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === "leaderboard" ? "border-visiyon-text text-visiyon-text" : "border-transparent text-visiyon-text-3 hover:text-visiyon-text-2"
            }`}
          >
            <Trophy size={14} /> Leaderboard
          </button>
          <button
            onClick={() => setSubTab("feedback")}
            className={`flex items-center gap-1.5 pb-2.5 text-[13.5px] font-medium border-b-2 -mb-px transition-colors ${
              subTab === "feedback" ? "border-visiyon-text text-visiyon-text" : "border-transparent text-visiyon-text-3 hover:text-visiyon-text-2"
            }`}
          >
            <MessageSquareWarning size={14} /> Feedback
          </button>
        </div>

        {subTab === "leaderboard" && (
          <div>
            <h2 className="text-lg font-semibold mb-1">
              Leaderboard {ratings.length > 0 && <span className="text-visiyon-text-3 font-normal">{ratings.length}</span>}
            </h2>
            <p className="text-[12px] text-visiyon-text-3 mb-5">
              Based on ELO ratings from Model Arena votes, updated in real time.
            </p>
            <div className="border border-visiyon-border rounded-[6px] overflow-hidden">
              <div className="grid grid-cols-[50px_1.6fr_1fr_1fr_1fr] gap-3 px-5 py-2.5 text-[11px] uppercase tracking-wide text-visiyon-text-3 border-b border-visiyon-border">
                <span>Rk</span>
                <span>Model</span>
                <span>Rating</span>
                <span>Won</span>
                <span>Lost</span>
              </div>
              {ratings.length === 0 && (
                <p className="px-5 py-6 text-sm text-visiyon-text-3">
                  No votes yet — cast a few battles in the Model Arena to populate this leaderboard.
                </p>
              )}
              {ratings.map((r, i) => (
                <div key={r.modelName} className="grid grid-cols-[50px_1.6fr_1fr_1fr_1fr] gap-3 items-center px-5 py-3 border-b border-visiyon-border last:border-0">
                  <span className="text-sm text-visiyon-text-3">{i + 1}</span>
                  <span className="text-sm font-medium truncate">{r.modelName}</span>
                  <span className="text-sm font-semibold">{r.rating}</span>
                  <span className="text-[12.5px] text-visiyon-text-3">{r.votes}</span>
                  <div className="h-1.5 rounded-full bg-visiyon-text/[0.06] overflow-hidden">
                    <div className="h-full bg-visiyon-text/40" style={{ width: `${(r.votes / maxVotes) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {subTab === "feedback" && (
          <div>
            <h2 className="text-lg font-semibold mb-1">Feedback {flagged.length > 0 && <span className="text-visiyon-text-3 font-normal">{flagged.length}</span>}</h2>
            <p className="text-[12px] text-visiyon-text-3 mb-5">
              Messages flagged by a moderation rule (Pipelines), for manual review.
            </p>
            <div className="border border-visiyon-border rounded-[6px] overflow-hidden">
              {flagged.length === 0 && (
                <p className="px-5 py-6 text-sm text-visiyon-text-3">No flagged messages.</p>
              )}
              {flagged.map((m) => (
                <div key={m.id} className="px-5 py-3.5 border-b border-visiyon-border last:border-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] text-visiyon-text-3">
                      {m.role} · {m.chat.title} · {new Date(m.createdAt).toLocaleString()}
                    </span>
                    {m.flagReason && (
                      <span className="text-[11px] border border-visiyon-border rounded-full px-2 py-0.5 text-visiyon-text-3">
                        {m.flagReason}
                      </span>
                    )}
                  </div>
                  <p className="text-sm line-clamp-2">{m.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
