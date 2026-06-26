import FlightLayout from "@/components/FlightLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Rss, Loader2, RefreshCw, DatabaseZap, Sparkles, Clock, BarChart2, Zap, Filter, ShieldOff, ExternalLink } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useState } from "react";

const categoryLabel: Record<string, string> = {
  aviation: "Aviation",
  viral: "Viral / Mainstream",
  raw_aviation: "Raw Aviation",
};

const categoryColor: Record<string, string> = {
  aviation: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  viral: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  raw_aviation: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

const tierConfig = {
  core: {
    label: "Core",
    color: "bg-violet-500/15 text-violet-400 border-violet-500/30",
    description: "Derived from Amazing-rated stories",
  },
  explore: {
    label: "Explore",
    color: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    description: "Derived from Good-rated stories",
  },
  test: {
    label: "Test",
    color: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    description: "Experimental — 7-day expiry",
  },
};

function formatRelativeDate(date: Date | string | null | undefined): string {
  if (!date) return "never";
  const d = new Date(date);
  const now = Date.now();
  const diff = now - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatExpiryDate(date: Date | string | null | undefined): string {
  if (!date) return "never";
  const d = new Date(date);
  const now = Date.now();
  const diff = d.getTime() - now;
  if (diff < 0) return "expired";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

const reasonLabel: Record<string, { label: string; color: string }> = {
  score_below_threshold: { label: "Score too low", color: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  not_aviation: { label: "Not aviation", color: "text-red-400 bg-red-500/10 border-red-500/20" },
  similar_title: { label: "Duplicate", color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
  manually_rejected: { label: "Manually rejected", color: "text-red-400 bg-red-500/10 border-red-500/20" },
};

export default function Sources() {
  const { data: sources, isLoading, refetch } = trpc.rssSources.list.useQuery();
  const utils = trpc.useUtils();
  const [showBlocked, setShowBlocked] = useState(false);
  const { data: blocked, isLoading: blockedLoading } = trpc.stories.blockedStories.useQuery(
    { limit: 100, reason: "all" },
    { enabled: showBlocked }
  );
  // Track which source's threshold input is being edited
  const [editingThreshold, setEditingThreshold] = useState<Record<number, string>>({});

  const updateThreshold = trpc.rssSources.updateThreshold.useMutation({
    onSuccess: (_, vars) => {
      toast.success(`Score gate updated to ${vars.scoreThreshold}`);
      utils.rssSources.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Failed to update threshold: ${err.message}`);
    },
  });

  const toggle = trpc.rssSources.toggle.useMutation({
    onSuccess: () => {
      utils.rssSources.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Failed to update source: ${err.message}`);
    },
  });

  const seed = trpc.rssSources.reseed.useMutation({
    onSuccess: () => {
      toast.success("Sources re-seeded");
      utils.rssSources.list.invalidate();
    },
  });

  const regenerate = trpc.rssSources.regenerateKeywordFeeds.useMutation({
    onSuccess: (data) => {
      toast.success(`AI feeds regenerated — ${data.created} created, ${data.updated} updated`);
      utils.rssSources.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Failed to regenerate feeds: ${err.message}`);
    },
  });

  // Split sources into AI keyword feeds and standard feeds
  const aiFeeds = (sources || []).filter((s) => s.sourceType === "ai_keyword");
  const standardSources = (sources || []).filter((s) => s.sourceType !== "ai_keyword");

  const grouped = standardSources.reduce(
    (acc, source) => {
      const cat = source.category || "aviation";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(source);
      return acc;
    },
    {} as Record<string, typeof standardSources>
  );

  const activeCount = (sources || []).filter((s) => s.isActive).length;
  const totalCount = (sources || []).length;

  // Group AI feeds by tier
  const aiByTier = aiFeeds.reduce(
    (acc, feed) => {
      const tier = (feed.tier as "core" | "explore" | "test") || "test";
      if (!acc[tier]) acc[tier] = [];
      acc[tier].push(feed);
      return acc;
    },
    {} as Record<"core" | "explore" | "test", typeof aiFeeds>
  );

  return (
    <FlightLayout>
      <div className="p-4 lg:p-6 max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
              RSS Sources
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {activeCount} of {totalCount} sources active
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => refetch()}
              disabled={isLoading}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs border-primary/30 text-primary hover:bg-primary/10"
              onClick={() => seed.mutate()}
              disabled={seed.isPending}
              title="Re-seed all default RSS sources into the database (safe to run multiple times)"
            >
              {seed.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Seeding...</>
              ) : (
                <><DatabaseZap className="w-3.5 h-3.5" /> Seed Sources</>
              )}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── AI Keyword Feeds Section ─────────────────────────────── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2.5 py-1 rounded-full border font-medium bg-violet-500/15 text-violet-400 border-violet-500/30 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" />
                    AI Keyword Feeds
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {aiFeeds.filter((s) => s.isActive).length}/{aiFeeds.length} active
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                  onClick={() => regenerate.mutate()}
                  disabled={regenerate.isPending}
                  title="Regenerate AI keyword feeds based on your rated story patterns"
                >
                  {regenerate.isPending ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Regenerating...</>
                  ) : (
                    <><Zap className="w-3.5 h-3.5" /> Regenerate Feeds</>
                  )}
                </Button>
              </div>

              {aiFeeds.length === 0 ? (
                <div className="bg-card border border-border rounded-xl p-6 text-center">
                  <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                  <p className="text-sm text-muted-foreground">No AI keyword feeds yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Rate some stories as Amazing or Good, then click Regenerate Feeds to generate targeted search feeds.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {(["core", "explore", "test"] as const).map((tier) => {
                    const tierFeeds = aiByTier[tier] || [];
                    if (tierFeeds.length === 0) return null;
                    const cfg = tierConfig[tier];
                    return (
                      <div key={tier}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={cn("text-xs px-2 py-0.5 rounded-full border font-medium", cfg.color)}>
                            {cfg.label}
                          </span>
                          <span className="text-xs text-muted-foreground">{cfg.description}</span>
                          <span className="text-xs text-muted-foreground">
                            · threshold {tier === "core" ? 80 : tier === "explore" ? 70 : 75}
                          </span>
                        </div>
                        <div className="bg-card border border-border rounded-xl overflow-hidden">
                          {tierFeeds.map((feed, i) => {
                            const isExpired = feed.expiresAt && new Date(feed.expiresAt) < new Date();
                            return (
                              <div
                                key={feed.id}
                                className={cn(
                                  "flex items-start gap-4 px-4 py-3",
                                  i < tierFeeds.length - 1 && "border-b border-border/50",
                                  isExpired && "opacity-60"
                                )}
                              >
                                    <Rss className={cn("w-4 h-4 shrink-0 mt-0.5", feed.isActive ? "text-violet-400" : "text-muted-foreground")} />
                                <div className="flex-1 min-w-0">
                                  {/* Feed name — strip the [AI Core] prefix for cleaner display */}
                                  <p className={cn("text-sm font-medium", feed.isActive ? "text-foreground" : "text-muted-foreground")}>
                                    {feed.name.replace(/^\[AI (Core|Explore|Test)\] /, "")}
                                  </p>
                                  <p className="text-xs text-muted-foreground truncate mt-0.5">{feed.url}</p>
                                  {/* Stats row */}
                                  <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                                    {feed.ratedStoryCount !== null && feed.ratedStoryCount !== undefined && (
                                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <BarChart2 className="w-3 h-3" />
                                        {feed.ratedStoryCount} rated {feed.ratedStoryCount === 1 ? "story" : "stories"}
                                      </span>
                                    )}
                                    {feed.lastFetchedAt && (
                                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <RefreshCw className="w-3 h-3" />
                                        Fetched {formatRelativeDate(feed.lastFetchedAt)}
                                      </span>
                                    )}
                                    {feed.expiresAt && (
                                      <span className={cn(
                                        "flex items-center gap-1 text-xs",
                                        isExpired ? "text-red-400" : "text-muted-foreground"
                                      )}>
                                        <Clock className="w-3 h-3" />
                                        Expires {formatExpiryDate(feed.expiresAt)}
                                      </span>
                                    )}
                                    {/* Score gate threshold */}
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <Filter className="w-3 h-3" />
                                      Gate:
                                      <Input
                                        type="number"
                                        min={0}
                                        max={100}
                                        className="w-14 h-5 text-xs px-1 py-0 ml-0.5"
                                        value={editingThreshold[feed.id] ?? String(feed.scoreThreshold ?? 0)}
                                        onChange={(e) => setEditingThreshold(prev => ({ ...prev, [feed.id]: e.target.value }))}
                                        onBlur={() => {
                                          const val = parseInt(editingThreshold[feed.id] ?? "", 10);
                                          if (!isNaN(val) && val >= 0 && val <= 100 && val !== (feed.scoreThreshold ?? 0)) {
                                            updateThreshold.mutate({ id: feed.id, scoreThreshold: val });
                                          }
                                          setEditingThreshold(prev => { const n = { ...prev }; delete n[feed.id]; return n; });
                                        }}
                                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                      />
                                    </span>
                                  </div>
                                </div>
                                <Switch
                                  checked={feed.isActive ?? false}
                                  onCheckedChange={(checked) => {
                                    if (feed.id) {
                                      toggle.mutate({ id: feed.id, isActive: checked });
                                    }
                                  }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Standard RSS Sources ─────────────────────────────────── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs px-2.5 py-1 rounded-full border font-medium bg-muted text-muted-foreground border-border">
                  Standard Feeds
                </span>
                <span className="text-xs text-muted-foreground">
                  {standardSources.filter((s) => s.isActive).length}/{standardSources.length} active
                </span>
              </div>

              <div className="space-y-6">
                {Object.entries(grouped).map(([category, items]) => (
                  <div key={category}>
                    <div className="flex items-center gap-2 mb-3">
                      <span
                        className={cn(
                          "text-xs px-2.5 py-1 rounded-full border font-medium",
                          categoryColor[category] || "bg-muted text-muted-foreground"
                        )}
                      >
                        {categoryLabel[category] || category}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {(items || []).filter((s) => s?.isActive).length}/{(items || []).length} active
                      </span>
                    </div>

                    <div className="bg-card border border-border rounded-xl overflow-hidden">
                      {(items || []).map((source, i) => (
                        <div
                          key={source?.id}
                          className={cn(
                            "flex items-center gap-4 px-4 py-3",
                            i < (items || []).length - 1 && "border-b border-border/50"
                          )}
                        >
                          <Rss className={cn("w-4 h-4 shrink-0", source?.isActive ? "text-primary" : "text-muted-foreground")} />
                          <div className="flex-1 min-w-0">
                            <p className={cn("text-sm font-medium", source?.isActive ? "text-foreground" : "text-muted-foreground")}>
                              {source?.name}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">{source?.url}</p>
                            <div className="flex items-center gap-3 mt-1 flex-wrap">
                              {source?.lastFetchedAt && (
                                <span className="text-xs text-muted-foreground">
                                  Last fetched: {new Date(source.lastFetchedAt!).toLocaleString()}
                                </span>
                              )}
                              {/* Score gate threshold */}
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Filter className="w-3 h-3" />
                                Gate:
                                <Input
                                  type="number"
                                  min={0}
                                  max={100}
                                  className="w-14 h-5 text-xs px-1 py-0 ml-0.5"
                                  value={editingThreshold[source?.id] ?? String(source?.scoreThreshold ?? 0)}
                                  onChange={(e) => source?.id && setEditingThreshold(prev => ({ ...prev, [source.id]: e.target.value }))}
                                  onBlur={() => {
                                    if (!source?.id) return;
                                    const val = parseInt(editingThreshold[source.id] ?? "", 10);
                                    if (!isNaN(val) && val >= 0 && val <= 100 && val !== (source.scoreThreshold ?? 0)) {
                                      updateThreshold.mutate({ id: source.id, scoreThreshold: val });
                                    }
                                    setEditingThreshold(prev => { const n = { ...prev }; delete n[source.id]; return n; });
                                  }}
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                />
                              </span>
                            </div>
                          </div>
                          <Switch
                            checked={source?.isActive ?? false}
                            onCheckedChange={(checked) => {
                              if (source?.id) {
                                toggle.mutate({ id: source.id, isActive: checked });
                              }
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Blocked Stories Section */}
      <div className="mt-8">
        <button
          onClick={() => setShowBlocked(v => !v)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ShieldOff className="w-4 h-4" />
          <span>{showBlocked ? "Hide" : "Show"} Blocked Stories</span>
          <span className="text-xs text-muted-foreground">(URLs filtered out at ingestion)</span>
        </button>

        {showBlocked && (
          <div className="rounded-xl border border-border bg-card/40 overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <ShieldOff className="w-4 h-4 text-muted-foreground" />
                Blocked Stories
              </h3>
              <span className="text-xs text-muted-foreground">{blocked?.length ?? 0} shown (most recent first)</span>
            </div>
            {blockedLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : !blocked || blocked.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">No blocked stories found.</div>
            ) : (
              <div className="divide-y divide-border/50 max-h-96 overflow-y-auto">
                {blocked.map((item, i) => {
                  const reason = reasonLabel[item.rejectedReason ?? ""] ?? { label: item.rejectedReason ?? "Unknown", color: "text-muted-foreground bg-muted border-border" };
                  const domain = (() => { try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return item.url.slice(0, 40); } })();
                  return (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors">
                      <span className={cn("text-xs px-2 py-0.5 rounded-full border shrink-0", reason.color)}>{reason.label}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{domain}</span>
                      <span className="text-xs text-foreground/70 flex-1 truncate">{item.url}</span>
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground">
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <span className="text-xs text-muted-foreground shrink-0">{formatRelativeDate(item.seenAt)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </FlightLayout>
  );
}
