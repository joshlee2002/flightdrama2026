import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Rss,
  History,
  Link2,
  RefreshCw,
  Plane,
  Loader2,
  CheckCircle2,
  BrainCircuit,
  BookOpen,
  Newspaper,
  Menu,
  X,
  Activity,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";

// Bottom nav shows only the 5 most important pages on mobile
const bottomNavItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/approved", label: "Approved", icon: CheckCircle2 },
  { href: "/historical", label: "Performance", icon: History },
  { href: "/insights", label: "Insights", icon: BrainCircuit },
  { href: "/sources", label: "Sources", icon: Rss },
];

// Full nav for sidebar (desktop) and mobile drawer
const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/approved", label: "Approved Queue", icon: CheckCircle2 },
  { href: "/ingest", label: "Add Stories", icon: Link2 },
  { href: "/sources", label: "RSS Sources", icon: Rss },
  { href: "/historical", label: "Performance Data", icon: History },
  { href: "/insights", label: "Learning Insights", icon: BrainCircuit },
  { href: "/example-articles", label: "Example Articles", icon: BookOpen },
  { href: "/digest", label: "Weekly Digest", icon: Newspaper },
  { href: "/ingest-log", label: "Ingest Log", icon: Activity },
  { href: "/system-health", label: "System Health", icon: ShieldCheck },
];

interface FlightLayoutProps {
  children: React.ReactNode;
}

export default function FlightLayout({ children }: FlightLayoutProps) {
  const [location, setLocation] = useLocation();
  const [refreshing, setRefreshing] = useState(false);
  const [reranking, setReranking] = useState(false);
  const [learning, setLearning] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { loading, isAuthenticated } = useAuth();
  const utils = trpc.useUtils();

  // Close drawer on route change
  useEffect(() => { setDrawerOpen(false); }, [location]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  // ── Rerank progress polling ──────────────────────────────────────────────
  const { data: rerankProgress } = trpc.stories.rerankProgress.useQuery(undefined, {
    // Always poll every 3s — this way the bar shows even if the user didn't click rerank
    refetchInterval: 3000,
    staleTime: 0,
  });

  // Derive reranking state from server data (not just local click)
  const isReranking = rerankProgress ? (!rerankProgress.done && rerankProgress.total > 0) : reranking;

  useEffect(() => {
    if (reranking && rerankProgress?.done && rerankProgress.total > 0) {
      setReranking(false);
      utils.stories.list.invalidate();
      utils.stories.pendingCount.invalidate();
      toast.success(`Re-rank complete — ${rerankProgress.completed}/${rerankProgress.total} stories scored`);
    }
  }, [reranking, rerankProgress?.done, rerankProgress?.total]);

  const rerankPct = rerankProgress && rerankProgress.total > 0
    ? Math.round((rerankProgress.completed / rerankProgress.total) * 100)
    : 0;
  const rerankEtaSec = rerankProgress?.etaMs ? Math.ceil(rerankProgress.etaMs / 1000) : null;

  // ── Ingest (refresh) progress polling ────────────────────────────────────
  const { data: ingestProgress } = trpc.stories.ingestProgress.useQuery(undefined, {
    refetchInterval: 2000,
    staleTime: 0,
  });

  // Derive refreshing state from server data too
  const isRefreshing = ingestProgress ? (!ingestProgress.done && ingestProgress.startedAt !== null) : refreshing;

  useEffect(() => {
    if (refreshing && ingestProgress?.done && ingestProgress.startedAt !== null) {
      setRefreshing(false);
      const newCount = ingestProgress.newCount ?? 0;
      toast.success(`Ingest complete — ${newCount} new ${newCount === 1 ? "story" : "stories"} added`);
      utils.stories.list.invalidate();
      utils.stories.pendingCount.invalidate();
      utils.stories.lastIngestTime.invalidate();
    }
  }, [refreshing, ingestProgress?.done, ingestProgress?.startedAt]);

  // Ingest progress label and percentage
  const getIngestLabel = () => {
    if (!ingestProgress || ingestProgress.done) return null;
    const phase = ingestProgress.phase;
    if (phase === "fetching") return `Fetching feeds…`;
    if (phase === "filtering") return `Filtering stories…`;
    if (phase === "scoring") {
      const total = ingestProgress.scoringTotal ?? 0;
      const done = ingestProgress.scoringDone ?? 0;
      return total > 0 ? `Scoring ${done}/${total} stories…` : `Scoring stories…`;
    }
    return `Processing…`;
  };

  const ingestPct = (() => {
    if (!ingestProgress || ingestProgress.done) return 0;
    const phase = ingestProgress.phase;
    if (phase === "fetching") return 10;
    if (phase === "filtering") return 35;
    if (phase === "scoring") {
      const total = ingestProgress.scoringTotal ?? 0;
      const done = ingestProgress.scoringDone ?? 0;
      if (total === 0) return 40;
      return Math.round(35 + (done / total) * 60);
    }
    return 50;
  })();

  const ingestLabel = getIngestLabel();
  // ────────────────────────────────────────────────────────────────────────

  const refreshFeeds = trpc.stories.refreshFeeds.useMutation({
    onSuccess: () => {
      // Don't clear refreshing here — let the ingestProgress polling handle it
      // so the progress bar stays visible until done
    },
    onError: (err) => {
      toast.error(`Refresh failed: ${err.message}`);
      setRefreshing(false);
    },
  });

  const { data: approvedItems = [] } = trpc.stories.list.useQuery(
    { approvalStatus: "approved" },
    { refetchInterval: 30000 }
  );
  const approvedCount = approvedItems.length;

  const { data: pendingCount = 0 } = trpc.stories.pendingCount.useQuery(
    undefined,
    { refetchInterval: 60000 }
  );

  const { data: lastIngestTime } = trpc.stories.lastIngestTime.useQuery(
    undefined,
    { refetchInterval: 60000 }
  );

  const learnFromOverrides = trpc.stories.learnFromOverrides.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success(`Scoring updated — learned from ${data.examplesUsed} overrides. ${data.summary}`);
      } else {
        toast.warning(data.summary);
      }
      setLearning(false);
    },
    onError: (err) => {
      toast.error(`Learning failed: ${err.message}`);
      setLearning(false);
    },
  });

  const rerank = trpc.stories.rerank.useMutation({
    onSuccess: (data) => {
      if (data.total === 0) {
        toast.info("No stories to re-rank (all have manual overrides)");
        setReranking(false);
      }
    },
    onError: (err) => {
      toast.error(`Re-rank failed: ${err.message}`);
      setReranking(false);
    },
  });

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      setLocation("/login");
    }
  }, [loading, isAuthenticated, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  const formatLastIngest = () => {
    if (!lastIngestTime) return "Never";
    const diff = Date.now() - new Date(lastIngestTime).getTime();
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(lastIngestTime).toLocaleDateString();
  };

  /** Shared progress bar block — used in both sidebar and mobile drawer */
  const ProgressBars = () => (
    <div className="space-y-0">
      {/* Ingest progress */}
      {isRefreshing && ingestLabel && (
        <div className="px-3 pt-2 pb-1">
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/8 px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3 text-sky-400 animate-spin" />
                <span className="text-[11px] font-semibold text-sky-400">Refreshing Feeds</span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums font-medium">{ingestPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-sky-500/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-sky-400 transition-all duration-700"
                style={{ width: `${ingestPct}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">{ingestLabel}</p>
          </div>
        </div>
      )}

      {/* Rerank progress */}
      {isReranking && (
        <div className="px-3 pt-2 pb-1">
          <div className="rounded-lg border border-primary/30 bg-primary/8 px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <LayoutDashboard className="w-3 h-3 text-primary animate-pulse" />
                <span className="text-[11px] font-semibold text-primary">Re-ranking Stories</span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums font-medium">
                {rerankProgress ? `${rerankProgress.completed}/${rerankProgress.total}` : "…"}
              </span>
            </div>
            <div className="h-2 rounded-full bg-primary/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${rerankPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">{rerankPct}% complete</span>
              {rerankEtaSec !== null && rerankEtaSec > 0 && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  ~{rerankEtaSec < 60 ? `${rerankEtaSec}s` : `${Math.ceil(rerankEtaSec / 60)}m`} left
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Desktop sidebar (lg+) ─────────────────────────────────────────── */}
      <aside className="hidden lg:flex w-56 shrink-0 border-r border-border bg-sidebar flex-col">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <Plane className="w-4 h-4 text-primary-foreground" strokeWidth={2.5} />
            </div>
            <div>
              <p className="font-bold text-sm text-sidebar-foreground leading-tight" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                Soyunci
              </p>
              <p className="text-[10px] text-muted-foreground leading-tight">Aviation Content OS</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = location === href;
            const isApproved = href === "/approved";
            return (
              <Link key={href} href={href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors duration-150 relative",
                    active
                      ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                      : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                  )}
                  title={label}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {isApproved && approvedCount > 0 && (
                    <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 min-w-[18px] text-center">
                      {approvedCount}
                    </span>
                  )}
                  {href === "/" && pendingCount > 0 && (
                    <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/20 text-primary min-w-[18px] text-center">
                      {pendingCount}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Last ingested */}
        <div className="px-4 py-2 border-t border-sidebar-border">
          <p className="text-[10px] text-muted-foreground/60 leading-tight">Last ingested</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{formatLastIngest()}</p>
        </div>

        {/* Progress bars (desktop) */}
        <ProgressBars />

        {/* Quick actions */}
        <div className="px-3 pb-4 space-y-2 border-t border-sidebar-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "w-full justify-start gap-2 text-xs",
              isRefreshing && "border-sky-500/40 text-sky-400"
            )}
            disabled={isRefreshing}
            onClick={() => { setRefreshing(true); refreshFeeds.mutate(); }}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin text-sky-400")} />
            {isRefreshing ? "Refreshing…" : "Refresh Feeds"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "w-full justify-start gap-2 text-xs",
              isReranking && "border-primary/40 text-primary"
            )}
            disabled={isReranking}
            onClick={() => { setReranking(true); rerank.mutate(); }}
          >
            <LayoutDashboard className={cn("w-3.5 h-3.5", isReranking && "animate-pulse text-primary")} />
            {isReranking ? `Re-ranking… ${rerankPct}%` : "Re-rank All"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
            disabled={learning}
            onClick={() => { setLearning(true); learnFromOverrides.mutate(); }}
          >
            <BrainCircuit className={cn("w-3.5 h-3.5", learning && "animate-pulse")} />
            {learning ? "Learning…" : "Learn from Overrides"}
          </Button>
        </div>
      </aside>

      {/* ── Mobile top bar (< lg) ─────────────────────────────────────────── */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-sidebar border-b border-sidebar-border">
        <div className="h-14 flex items-center px-4 gap-3">
          <button
            onClick={() => setDrawerOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 flex-1">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <Plane className="w-3.5 h-3.5 text-primary-foreground" strokeWidth={2.5} />
            </div>
            <p className="font-bold text-sm text-sidebar-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
              Soyunci
            </p>
          </div>
          {/* Quick action buttons in top bar */}
          <button
            className={cn(
              "w-9 h-9 flex items-center justify-center rounded-md transition-colors disabled:opacity-40",
              isRefreshing
                ? "text-sky-400 bg-sky-500/10"
                : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50"
            )}
            disabled={isRefreshing}
            title="Refresh Feeds"
            onClick={() => { setRefreshing(true); refreshFeeds.mutate(); }}
          >
            <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
          </button>
          <button
            className="w-9 h-9 flex items-center justify-center rounded-md text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 transition-colors disabled:opacity-40"
            disabled={learning}
            title="Learn from Overrides"
            onClick={() => { setLearning(true); learnFromOverrides.mutate(); }}
          >
            <BrainCircuit className={cn("w-4 h-4", learning && "animate-pulse")} />
          </button>
        </div>

        {/* Mobile inline progress bars — shown below the top bar when active */}
        {(isRefreshing || isReranking) && (
          <div className="px-4 pb-2 space-y-1.5">
            {isRefreshing && ingestLabel && (
              <div className="flex items-center gap-2">
                <RefreshCw className="w-3 h-3 text-sky-400 animate-spin shrink-0" />
                <div className="flex-1">
                  <div className="flex justify-between mb-0.5">
                    <span className="text-[10px] text-sky-400 font-medium">{ingestLabel}</span>
                    <span className="text-[10px] text-muted-foreground">{ingestPct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-sky-500/15 overflow-hidden">
                    <div className="h-full rounded-full bg-sky-400 transition-all duration-700" style={{ width: `${ingestPct}%` }} />
                  </div>
                </div>
              </div>
            )}
            {isReranking && (
              <div className="flex items-center gap-2">
                <LayoutDashboard className="w-3 h-3 text-primary animate-pulse shrink-0" />
                <div className="flex-1">
                  <div className="flex justify-between mb-0.5">
                    <span className="text-[10px] text-primary font-medium">
                      Re-ranking {rerankProgress?.completed ?? 0}/{rerankProgress?.total ?? 0}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {rerankEtaSec && rerankEtaSec > 0 ? `~${rerankEtaSec < 60 ? `${rerankEtaSec}s` : `${Math.ceil(rerankEtaSec / 60)}m`}` : `${rerankPct}%`}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-primary/15 overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${rerankPct}%` }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile drawer overlay ─────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          {/* Drawer panel */}
          <div className="relative w-72 max-w-[85vw] bg-sidebar border-r border-sidebar-border flex flex-col h-full shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-sidebar-border">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                  <Plane className="w-4 h-4 text-primary-foreground" strokeWidth={2.5} />
                </div>
                <div>
                  <p className="font-bold text-sm text-sidebar-foreground leading-tight" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                    Soyunci
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-tight">Aviation Content OS</p>
                </div>
              </div>
              <button
                onClick={() => setDrawerOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Nav */}
            <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
              {navItems.map(({ href, label, icon: Icon }) => {
                const active = location === href;
                const isApproved = href === "/approved";
                return (
                  <Link key={href} href={href}>
                    <div
                      className={cn(
                        "flex items-center gap-3 px-3 py-3 rounded-md text-sm cursor-pointer transition-colors duration-150 relative",
                        active
                          ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                          : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                      )}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1">{label}</span>
                      {isApproved && approvedCount > 0 && (
                        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 min-w-[18px] text-center">
                          {approvedCount}
                        </span>
                      )}
                      {href === "/" && pendingCount > 0 && (
                        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/20 text-primary min-w-[18px] text-center">
                          {pendingCount}
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </nav>

            {/* Last ingested */}
            <div className="px-4 py-2 border-t border-sidebar-border">
              <p className="text-[10px] text-muted-foreground/60">Last ingested: {formatLastIngest()}</p>
            </div>

            {/* Progress bars (mobile drawer) */}
            <ProgressBars />

            {/* Quick actions */}
            <div className="px-3 pb-6 pt-3 space-y-2 border-t border-sidebar-border">
              <Button
                variant="outline"
                size="sm"
                className={cn("w-full justify-start gap-2 text-xs", isRefreshing && "border-sky-500/40 text-sky-400")}
                disabled={isRefreshing}
                onClick={() => { setRefreshing(true); refreshFeeds.mutate(); setDrawerOpen(false); }}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin text-sky-400")} />
                {isRefreshing ? "Refreshing…" : "Refresh Feeds"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn("w-full justify-start gap-2 text-xs", isReranking && "border-primary/40 text-primary")}
                disabled={isReranking}
                onClick={() => { setReranking(true); rerank.mutate(); setDrawerOpen(false); }}
              >
                <LayoutDashboard className={cn("w-3.5 h-3.5", isReranking && "animate-pulse text-primary")} />
                {isReranking ? `Re-ranking… ${rerankPct}%` : "Re-rank All"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
                disabled={learning}
                onClick={() => { setLearning(true); learnFromOverrides.mutate(); setDrawerOpen(false); }}
              >
                <BrainCircuit className={cn("w-3.5 h-3.5", learning && "animate-pulse")} />
                {learning ? "Learning…" : "Learn from Overrides"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <main className={cn("flex-1 overflow-auto min-w-0 lg:pt-0 pb-20 lg:pb-0", (isRefreshing || isReranking) ? "pt-28" : "pt-14")}>
        {children}
      </main>

      {/* ── Mobile bottom nav bar (< lg) ─────────────────────────────────── */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-sidebar border-t border-sidebar-border flex items-stretch h-16 safe-area-inset-bottom">
        {bottomNavItems.map(({ href, label, icon: Icon }) => {
          const active = location === href;
          const isApproved = href === "/approved";
          const isDashboard = href === "/";
          return (
            <Link key={href} href={href} className="flex-1">
              <div className={cn(
                "flex flex-col items-center justify-center gap-0.5 h-full px-1 relative transition-colors",
                active ? "text-primary" : "text-muted-foreground"
              )}>
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {isApproved && approvedCount > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full bg-emerald-500 text-[8px] font-bold text-black flex items-center justify-center">
                      {approvedCount > 9 ? "9+" : approvedCount}
                    </span>
                  )}
                  {isDashboard && pendingCount > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full bg-primary text-[8px] font-bold text-black flex items-center justify-center">
                      {pendingCount > 9 ? "9+" : pendingCount}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-medium leading-none">{label}</span>
                {active && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 rounded-full bg-primary" />
                )}
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
