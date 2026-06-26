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

  const refreshFeeds = trpc.stories.refreshFeeds.useMutation({
    onSuccess: () => {
      toast.success("Ingest started — new stories will appear shortly");
      setRefreshing(false);
      const intervals = [5000, 15000, 30000, 60000, 120000, 180000];
      intervals.forEach(delay => {
        setTimeout(() => {
          utils.stories.list.invalidate();
          utils.stories.pendingCount.invalidate();
          utils.stories.lastIngestTime.invalidate();
        }, delay);
      });
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
      toast.success(`Re-ranked ${data.reranked} stories`);
      setReranking(false);
      utils.stories.list.invalidate();
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

        {/* Quick actions */}
        <div className="px-3 pb-4 space-y-2 border-t border-sidebar-border pt-3">
          <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs" disabled={refreshing}
            onClick={() => { setRefreshing(true); refreshFeeds.mutate(); }}>
            <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
            {refreshing ? "Refreshing..." : "Refresh Feeds"}
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs" disabled={reranking}
            onClick={() => { setReranking(true); rerank.mutate(); }}>
            <LayoutDashboard className={cn("w-3.5 h-3.5", reranking && "animate-pulse")} />
            {reranking ? "Re-ranking..." : "Re-rank All"}
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300" disabled={learning}
            onClick={() => { setLearning(true); learnFromOverrides.mutate(); }}>
            <BrainCircuit className={cn("w-3.5 h-3.5", learning && "animate-pulse")} />
            {learning ? "Learning..." : "Learn from Overrides"}
          </Button>
        </div>
      </aside>

      {/* ── Mobile top bar (< lg) ─────────────────────────────────────────── */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-sidebar border-b border-sidebar-border flex items-center px-4 gap-3">
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
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50 transition-colors disabled:opacity-40"
          disabled={refreshing}
          title="Refresh Feeds"
          onClick={() => { setRefreshing(true); refreshFeeds.mutate(); }}
        >
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
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

            {/* Quick actions */}
            <div className="px-3 pb-6 pt-3 space-y-2 border-t border-sidebar-border">
              <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs" disabled={refreshing}
                onClick={() => { setRefreshing(true); refreshFeeds.mutate(); setDrawerOpen(false); }}>
                <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
                {refreshing ? "Refreshing..." : "Refresh Feeds"}
              </Button>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs" disabled={reranking}
                onClick={() => { setReranking(true); rerank.mutate(); setDrawerOpen(false); }}>
                <LayoutDashboard className={cn("w-3.5 h-3.5", reranking && "animate-pulse")} />
                {reranking ? "Re-ranking..." : "Re-rank All"}
              </Button>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300" disabled={learning}
                onClick={() => { setLearning(true); learnFromOverrides.mutate(); setDrawerOpen(false); }}>
                <BrainCircuit className={cn("w-3.5 h-3.5", learning && "animate-pulse")} />
                {learning ? "Learning..." : "Learn from Overrides"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto min-w-0 lg:pt-0 pt-14 pb-20 lg:pb-0">
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
