import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, Clock, Brain, Rss, BarChart2, TrendingUp, TrendingDown } from "lucide-react";

function ago(isoString: string | null): string {
  if (!isoString) return "Never";
  const ms = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (ok) return <span className="inline-block w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />;
  if (warn) return <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />;
}

function StatCard({ label, value, sub, colour = "text-white" }: { label: string; value: string | number; sub?: string; colour?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className={`text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
      <div className="text-xs text-slate-400 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-indigo-400" />
        <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export default function SystemHealth() {
  const [showAllFeeds, setShowAllFeeds] = useState(false);
  const { data, isLoading, refetch, isFetching } = trpc.diagnostics.health.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400 text-sm">Loading system health...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-red-400 text-sm">Failed to load diagnostics.</div>
      </div>
    );
  }

  const { feedSummary, staleFeeds, feedHealth, ingest24h, ingest7d, learning, scoreDistribution, approvedCount } = data as any;

  const ingestRate24h = ingest24h.total > 0 ? Math.round((ingest24h.ingested / ingest24h.total) * 100) : 0;
  const overallFeedHealth = feedSummary.stale === 0 ? "good" : feedSummary.stale <= 3 ? "warn" : "bad";

  const activeFeedsSorted = (feedHealth as any[])
    .filter((f: any) => f.isActive)
    .sort((a: any, b: any) => {
      if (a.isStale && !b.isStale) return 1;
      if (!a.isStale && b.isStale) return -1;
      return (a.minutesSinceFetch ?? 9999) - (b.minutesSinceFetch ?? 9999);
    });

  const visibleFeeds = showAllFeeds ? activeFeedsSorted : activeFeedsSorted.slice(0, 15);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">System Health</h1>
            <p className="text-slate-400 text-sm mt-1">
              Live evidence that feeds, ingestion, and override learning are all working.
              Updated {ago(data.generatedAt as string)}.
            </p>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* ── Top-level status bar ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <StatCard
            label="Feeds active"
            value={`${feedSummary.healthy}/${feedSummary.active}`}
            sub={feedSummary.stale > 0 ? `${feedSummary.stale} stale` : "All healthy"}
            colour={overallFeedHealth === "good" ? "text-green-400" : overallFeedHealth === "warn" ? "text-yellow-400" : "text-red-400"}
          />
          <StatCard
            label="Stories ingested (24h)"
            value={ingest24h.ingested}
            sub={`${ingestRate24h}% pass rate from ${ingest24h.total} seen`}
            colour="text-indigo-400"
          />
          <StatCard
            label="Override examples"
            value={learning.totalOverrides}
            sub={`${learning.recentOverrides} added this week`}
            colour="text-purple-400"
          />
          <StatCard
            label="Approved queue"
            value={approvedCount}
            sub="Stories ready to post"
            colour="text-green-400"
          />
        </div>

        {/* ── Feed Health ── */}
        <Section title="RSS Feed Health" icon={Rss}>
          {staleFeeds.length > 0 && (
            <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-center gap-2 text-yellow-300 text-sm font-medium mb-2">
                <AlertTriangle className="w-4 h-4" />
                {staleFeeds.length} feed{staleFeeds.length > 1 ? "s" : ""} haven't been fetched in over 3 hours
              </div>
              <div className="space-y-1">
                {(staleFeeds as any[]).map((f: any) => (
                  <div key={f.name} className="text-xs text-yellow-200/70 flex items-center gap-2">
                    <span className="text-yellow-500">•</span>
                    <span className="font-medium">{f.name}</span>
                    <span className="text-yellow-500/60">({f.category})</span>
                    <span className="ml-auto text-yellow-500/60">
                      {f.minutesSinceFetch !== null ? `${Math.floor(f.minutesSinceFetch / 60)}h ${f.minutesSinceFetch % 60}m ago` : "Never fetched"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-0 text-xs text-slate-500 uppercase tracking-wide px-4 py-2 border-b border-slate-800">
              <span>Feed</span>
              <span className="text-right pr-4">Category</span>
              <span className="text-right pr-4">Last Fetched</span>
              <span className="text-right">Status</span>
            </div>
            <div className="divide-y divide-slate-800/50">
              {visibleFeeds.map((f: any) => (
                <div key={f.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-0 items-center px-4 py-2.5">
                  <span className="text-sm text-slate-200 truncate pr-4">{f.name}</span>
                  <span className="text-xs text-slate-500 text-right pr-4 capitalize">{f.category}</span>
                  <span className="text-xs text-slate-400 text-right pr-4 tabular-nums">
                    {f.minutesSinceFetch !== null
                      ? f.minutesSinceFetch < 60
                        ? `${f.minutesSinceFetch}m ago`
                        : `${Math.floor(f.minutesSinceFetch / 60)}h ${f.minutesSinceFetch % 60}m ago`
                      : "Never"}
                  </span>
                  <div className="flex justify-end">
                    {f.isStale
                      ? <span className="flex items-center gap-1 text-xs text-yellow-400"><AlertTriangle className="w-3 h-3" /> Stale</span>
                      : <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 className="w-3 h-3" /> OK</span>
                    }
                  </div>
                </div>
              ))}
            </div>
            {activeFeedsSorted.length > 15 && (
              <div className="px-4 py-3 border-t border-slate-800">
                <button
                  onClick={() => setShowAllFeeds(!showAllFeeds)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 underline"
                >
                  {showAllFeeds ? "Show fewer" : `Show all ${activeFeedsSorted.length} feeds`}
                </button>
              </div>
            )}
          </div>
        </Section>

        {/* ── Ingestion Stats ── */}
        <Section title="Ingestion Pipeline" icon={BarChart2}>
          <div className="grid grid-cols-2 gap-6">
            {/* 24h */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Last 24 hours</div>
              <div className="space-y-2">
                {[
                  { label: "Ingested to dashboard", value: ingest24h.ingested, colour: "bg-green-500" },
                  { label: "Not aviation (filtered)", value: ingest24h.notAviation, colour: "bg-yellow-500" },
                  { label: "Duplicates removed", value: ingest24h.duplicate, colour: "bg-orange-500" },
                  { label: "Score too low", value: ingest24h.lowScore, colour: "bg-red-500" },
                ].map(({ label, value, colour }) => (
                  <div key={label} className="flex items-center gap-3">
                    <div className="w-24 h-1.5 bg-slate-700 rounded-full overflow-hidden flex-shrink-0">
                      <div
                        className={`h-full rounded-full ${colour}`}
                        style={{ width: ingest24h.total > 0 ? `${Math.min(100, (value / ingest24h.total) * 100)}%` : "0%" }}
                      />
                    </div>
                    <span className="text-xs text-slate-300 tabular-nums w-6 text-right">{value}</span>
                    <span className="text-xs text-slate-500">{label}</span>
                  </div>
                ))}
                <div className="pt-1 border-t border-slate-800 text-xs text-slate-500">
                  {ingest24h.total} total stories seen
                </div>
              </div>
            </div>

            {/* 7d */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Last 7 days</div>
              <div className="space-y-2">
                {[
                  { label: "Ingested to dashboard", value: ingest7d.ingested, colour: "bg-green-500" },
                  { label: "Not aviation (filtered)", value: ingest7d.notAviation, colour: "bg-yellow-500" },
                  { label: "Duplicates removed", value: ingest7d.duplicate, colour: "bg-orange-500" },
                  { label: "Score too low", value: ingest7d.lowScore, colour: "bg-red-500" },
                ].map(({ label, value, colour }) => (
                  <div key={label} className="flex items-center gap-3">
                    <div className="w-24 h-1.5 bg-slate-700 rounded-full overflow-hidden flex-shrink-0">
                      <div
                        className={`h-full rounded-full ${colour}`}
                        style={{ width: ingest7d.total > 0 ? `${Math.min(100, (value / ingest7d.total) * 100)}%` : "0%" }}
                      />
                    </div>
                    <span className="text-xs text-slate-300 tabular-nums w-6 text-right">{value}</span>
                    <span className="text-xs text-slate-500">{label}</span>
                  </div>
                ))}
                <div className="pt-1 border-t border-slate-800 text-xs text-slate-500">
                  {ingest7d.total} total stories seen
                </div>
              </div>
            </div>
          </div>

          {/* Score distribution */}
          <div className="mt-4 bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Current pending stories — score distribution</div>
            <div className="flex items-end gap-2 h-20">
              {(scoreDistribution as any[]).map(({ bucket, count }: any) => {
                const max = Math.max(...(scoreDistribution as any[]).map((b: any) => b.count), 1);
                const pct = (count / max) * 100;
                const colour = bucket === "85-100" ? "bg-green-500" : bucket === "70-84" ? "bg-indigo-500" : bucket === "50-69" ? "bg-yellow-500" : bucket === "30-49" ? "bg-orange-500" : "bg-red-500";
                return (
                  <div key={bucket} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-xs text-slate-400 tabular-nums">{count}</span>
                    <div className="w-full flex items-end" style={{ height: "48px" }}>
                      <div className={`w-full rounded-t ${colour}`} style={{ height: `${Math.max(4, pct)}%` }} />
                    </div>
                    <span className="text-xs text-slate-500">{bucket}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>

        {/* ── Override Learning ── */}
        <Section title="Override Learning" icon={Brain}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            <StatCard
              label="Total override examples"
              value={learning.totalOverrides}
              sub="All-time approve/reject decisions"
              colour={learning.totalOverrides >= 30 ? "text-green-400" : learning.totalOverrides >= 10 ? "text-yellow-400" : "text-red-400"}
            />
            <StatCard
              label="Added this week"
              value={learning.recentOverrides}
              sub="New examples in last 7 days"
              colour="text-indigo-400"
            />
            <StatCard
              label="Pending to learn"
              value={learning.pendingOverrides}
              sub="Will be used on next Re-learn"
              colour={learning.pendingOverrides > 0 ? "text-yellow-400" : "text-slate-400"}
            />
          </div>

          {/* LLM learning */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 mb-3">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-slate-500 uppercase tracking-wide">LLM Deep Learning</div>
              <div className="flex items-center gap-2">
                <StatusDot ok={!!learning.lastLearnedAt} warn={!learning.lastLearnedAt} />
                <span className="text-xs text-slate-400">
                  {learning.lastLearnedAt ? `Last run ${ago(learning.lastLearnedAt)} · ${learning.lastLearnedCount} examples used` : "Never run"}
                </span>
              </div>
            </div>
            {learning.editorialPhilosophy ? (
              <div>
                <div className="text-xs text-slate-500 mb-1">What the AI has learned about your editorial preferences:</div>
                <p className="text-sm text-slate-300 leading-relaxed bg-slate-800/50 rounded p-3 border border-slate-700">
                  {learning.editorialPhilosophy}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500 italic">
                No editorial philosophy learned yet. Run "Re-learn Now" from the AI Learning Status bar on the dashboard once you have 10+ overrides.
              </p>
            )}
          </div>

          {/* Statistical learning */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-slate-500 uppercase tracking-wide">Statistical Learning</div>
              <div className="flex items-center gap-2">
                <StatusDot ok={!!learning.statLastLearnedAt} warn={!learning.statLastLearnedAt} />
                <span className="text-xs text-slate-400">
                  {learning.statLastLearnedAt ? `Last run ${ago(learning.statLastLearnedAt)} · ${learning.statExamplesCount} examples` : "Never run"}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {learning.statCategoryWeights && (
                <div>
                  <div className="text-xs text-slate-500 mb-1">Category weights learned:</div>
                  <p className="text-xs text-slate-300 bg-slate-800/50 rounded p-2 border border-slate-700 font-mono leading-relaxed">
                    {learning.statCategoryWeights}
                  </p>
                </div>
              )}
              {learning.statOverallDrift && (
                <div>
                  <div className="text-xs text-slate-500 mb-1">Overall scoring drift:</div>
                  <p className="text-xs text-slate-300 bg-slate-800/50 rounded p-2 border border-slate-700 leading-relaxed">
                    {learning.statOverallDrift}
                  </p>
                </div>
              )}
              {learning.statKeywordBoosts && learning.statKeywordBoosts !== "none yet" && (
                <div>
                  <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">
                    <TrendingUp className="w-3 h-3 text-green-400" /> Keyword boosts:
                  </div>
                  <p className="text-xs text-slate-300 bg-slate-800/50 rounded p-2 border border-slate-700 font-mono leading-relaxed">
                    {learning.statKeywordBoosts}
                  </p>
                </div>
              )}
              {learning.statKeywordPenalties && learning.statKeywordPenalties !== "none yet" && (
                <div>
                  <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">
                    <TrendingDown className="w-3 h-3 text-red-400" /> Keyword penalties:
                  </div>
                  <p className="text-xs text-slate-300 bg-slate-800/50 rounded p-2 border border-slate-700 font-mono leading-relaxed">
                    {learning.statKeywordPenalties}
                  </p>
                </div>
              )}
              {!learning.statCategoryWeights && !learning.statOverallDrift && (
                <p className="text-sm text-slate-500 italic col-span-2">
                  Statistical learning hasn't run yet. It fires automatically after every 5 overrides.
                </p>
              )}
            </div>
          </div>
        </Section>

        {/* ── How to trust it ── */}
        <Section title="How to Read This Page" icon={CheckCircle2}>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-sm text-slate-400 space-y-2 leading-relaxed">
            <p><span className="text-slate-200 font-medium">Feed health:</span> Every active feed should show "OK" and a fetch time under 3 hours. If a feed is stale, it means the ingest scheduler hasn't run recently — check your Railway cron job.</p>
            <p><span className="text-slate-200 font-medium">Ingestion rate:</span> A healthy system ingests 10–40 stories per 24h. If "Not aviation" is very high, the keyword gate is filtering too aggressively. If "Score too low" is very high, your thresholds may need lowering.</p>
            <p><span className="text-slate-200 font-medium">Override learning:</span> The AI learns from every approve/reject you make. With 30+ examples the LLM deep learning becomes meaningful. The "Editorial philosophy" text is the literal rule set the AI is using when it scores new stories — read it to verify it matches your actual preferences.</p>
            <p><span className="text-slate-200 font-medium">Statistical learning:</span> Runs automatically every 5 overrides. The keyword boosts and penalties are applied on top of the rule-based score for every new story — you can see exactly which words are being rewarded or penalised.</p>
          </div>
        </Section>

      </div>
    </div>
  );
}
