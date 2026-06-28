import { useState } from "react";
import { trpc } from "@/lib/trpc";

const DROP_REASON_LABELS: Record<string, { label: string; colour: string; description: string }> = {
  ingested:              { label: "Ingested",           colour: "bg-green-500/20 text-green-300 border-green-500/30",  description: "Story passed all gates and was added to your dashboard" },
  not_aviation:          { label: "Not Aviation",       colour: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30", description: "Failed the aviation keyword gate — title and lede had no aviation signals" },
  duplicate_content:     { label: "Duplicate (content)",colour: "bg-orange-500/20 text-orange-300 border-orange-500/30", description: "Content hash or event fingerprint matched an existing story" },
  duplicate_title:       { label: "Duplicate (title)",  colour: "bg-orange-500/20 text-orange-300 border-orange-500/30", description: "Title was too similar to a recent story (fuzzy or LLM dedup)" },
  duplicate_batch:       { label: "Duplicate (batch)",  colour: "bg-orange-400/20 text-orange-200 border-orange-400/30", description: "Duplicate of another story in the same ingest batch" },
  score_below_rule:      { label: "Low Rule Score",     colour: "bg-red-500/20 text-red-300 border-red-500/30",        description: "Rule-based score < 30 — dropped before LLM scoring to save cost" },
  score_below_feed:      { label: "Low LLM Score",      colour: "bg-red-600/20 text-red-300 border-red-600/30",        description: "LLM score was below the feed threshold — not interesting enough" },
};

function Badge({ reason }: { reason: string }) {
  const meta = DROP_REASON_LABELS[reason] ?? { label: reason, colour: "bg-slate-500/20 text-slate-300 border-slate-500/30", description: "" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${meta.colour}`}>
      {meta.label}
    </span>
  );
}

function ScoreBar({ score, max = 100 }: { score: number | null; max?: number }) {
  if (score === null) return <span className="text-slate-500 text-xs">—</span>;
  const pct = Math.min(100, Math.max(0, (score / max) * 100));
  const colour = score >= 75 ? "bg-green-500" : score >= 50 ? "bg-yellow-500" : score >= 30 ? "bg-orange-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-300 tabular-nums">{score}</span>
    </div>
  );
}

export default function IngestLog() {
  const [sinceHours, setSinceHours] = useState(24);
  const [filterReason, setFilterReason] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: summary, isLoading: summaryLoading } = trpc.ingestLog.summary.useQuery({ sinceHours });
  const { data: entries, isLoading: entriesLoading } = trpc.ingestLog.list.useQuery({
    sinceHours,
    dropReason: filterReason,
    limit: 300,
  });

  const totalDropped = (summary ?? []).filter((s: any) => s.dropReason !== "ingested").reduce((acc: number, s: any) => acc + Number(s.count), 0);
  const totalIngested = (summary ?? []).find((s: any) => s.dropReason === "ingested")?.count ?? 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Ingest Diagnostic Log</h1>
          <p className="text-slate-400 text-sm mt-1">
            Every story seen by the pipeline — including why it was dropped. Use this to spot missing viral stories.
          </p>
        </div>

        {/* Time filter */}
        <div className="flex items-center gap-3 mb-6">
          <span className="text-slate-400 text-sm">Show last:</span>
          {[6, 12, 24, 48, 72].map(h => (
            <button
              key={h}
              onClick={() => setSinceHours(h)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                sinceHours === h
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {h}h
            </button>
          ))}
        </div>

        {/* Summary cards */}
        {summaryLoading ? (
          <div className="text-slate-500 text-sm mb-6">Loading summary...</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
            {/* Ingested card */}
            <button
              onClick={() => setFilterReason(filterReason === "ingested" ? undefined : "ingested")}
              className={`p-3 rounded-lg border text-left transition-all ${
                filterReason === "ingested"
                  ? "border-green-500 bg-green-500/10"
                  : "border-slate-700 bg-slate-900 hover:border-slate-600"
              }`}
            >
              <div className="text-2xl font-bold text-green-400">{Number(totalIngested)}</div>
              <div className="text-xs text-slate-400 mt-0.5">Ingested to dashboard</div>
            </button>

            {/* Drop reason cards */}
            {(summary ?? [])
              .filter((s: any) => s.dropReason !== "ingested")
              .map((s: any) => {
                const meta = DROP_REASON_LABELS[s.dropReason] ?? { label: s.dropReason, colour: "bg-slate-500/20 text-slate-300 border-slate-500/30", description: "" };
                const isActive = filterReason === s.dropReason;
                return (
                  <button
                    key={s.dropReason}
                    onClick={() => setFilterReason(isActive ? undefined : s.dropReason)}
                    title={meta.description}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      isActive ? "border-indigo-500 bg-indigo-500/10" : "border-slate-700 bg-slate-900 hover:border-slate-600"
                    }`}
                  >
                    <div className="text-2xl font-bold text-white">{Number(s.count)}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{meta.label}</div>
                  </button>
                );
              })}

            {/* Total dropped */}
            <div className="p-3 rounded-lg border border-slate-700 bg-slate-900">
              <div className="text-2xl font-bold text-slate-300">{totalDropped}</div>
              <div className="text-xs text-slate-400 mt-0.5">Total dropped</div>
            </div>
          </div>
        )}

        {/* Filter pill */}
        {filterReason && (
          <div className="flex items-center gap-2 mb-4">
            <span className="text-slate-400 text-sm">Filtering by:</span>
            <Badge reason={filterReason} />
            <button
              onClick={() => setFilterReason(undefined)}
              className="text-xs text-slate-500 hover:text-slate-300 underline"
            >
              Clear
            </button>
          </div>
        )}

        {/* Entry list */}
        {entriesLoading ? (
          <div className="text-slate-500 text-sm">Loading entries...</div>
        ) : !entries?.length ? (
          <div className="text-slate-500 text-sm py-8 text-center">
            No entries found for this time range.
            {!filterReason && <span> The log starts filling after the next ingest run.</span>}
          </div>
        ) : (
          <div className="space-y-1">
            {entries.map((entry: any, i: number) => {
              const isOpen = expanded === i;
              return (
                <div
                  key={entry.id}
                  className={`rounded-lg border transition-all ${
                    entry.dropReason === "ingested"
                      ? "border-green-900/50 bg-green-950/20"
                      : "border-slate-800 bg-slate-900/50"
                  }`}
                >
                  <button
                    className="w-full text-left px-4 py-3 flex items-start gap-3"
                    onClick={() => setExpanded(isOpen ? null : i)}
                  >
                    {/* Badge */}
                    <div className="flex-shrink-0 pt-0.5">
                      <Badge reason={entry.dropReason} />
                    </div>

                    {/* Title */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${
                        entry.dropReason === "ingested" ? "text-white" : "text-slate-300"
                      }`}>
                        {entry.title}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {entry.sourceName} · {entry.publishedAt
                          ? new Date(entry.publishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                          : new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {entry.category && ` · ${entry.category}`}
                      </p>
                    </div>

                    {/* Scores */}
                    <div className="flex-shrink-0 flex flex-col items-end gap-1">
                      {entry.ruleScore !== null && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-500">Rule</span>
                          <ScoreBar score={entry.ruleScore} />
                        </div>
                      )}
                      {entry.llmScore !== null && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-500">LLM</span>
                          <ScoreBar score={entry.llmScore} />
                        </div>
                      )}
                    </div>

                    {/* Expand chevron */}
                    <div className="flex-shrink-0 text-slate-600 text-xs pt-1">
                      {isOpen ? "▲" : "▼"}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isOpen && (
                    <div className="px-4 pb-4 pt-0 border-t border-slate-800 mt-0">
                      <div className="mt-3 space-y-2 text-sm">
                        {entry.dropDetail && (
                          <div>
                            <span className="text-slate-500 text-xs uppercase tracking-wide">Reason</span>
                            <p className="text-slate-300 mt-0.5">{entry.dropDetail}</p>
                          </div>
                        )}
                        {entry.feedThreshold !== null && (
                          <div>
                            <span className="text-slate-500 text-xs uppercase tracking-wide">Feed threshold</span>
                            <p className="text-slate-300 mt-0.5">{entry.feedThreshold}</p>
                          </div>
                        )}
                        <div>
                          <span className="text-slate-500 text-xs uppercase tracking-wide">Source URL</span>
                          <a
                            href={entry.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-indigo-400 hover:text-indigo-300 mt-0.5 truncate text-xs"
                          >
                            {entry.sourceUrl}
                          </a>
                        </div>
                        <div>
                          <span className="text-slate-500 text-xs uppercase tracking-wide">Logged at</span>
                          <p className="text-slate-400 mt-0.5 text-xs">
                            {new Date(entry.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
