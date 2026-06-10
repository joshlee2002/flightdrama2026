import { Link, useLocation } from "wouter";
import { useEffect } from "react";
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
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";

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
  const { loading, isAuthenticated } = useAuth();
  const utils = trpc.useUtils();

  // All hooks must be declared before any conditional returns
  const refreshFeeds = trpc.stories.refreshFeeds.useMutation({
    onSuccess: () => {
      toast.success('Ingest started — new stories will appear shortly as feeds are processed');
      setRefreshing(false);
      // Poll for new stories over the next 3 minutes while the background ingest runs
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

  // Approved count for sidebar badge
  const { data: approvedItems = [] } = trpc.stories.list.useQuery(
    { approvalStatus: "approved" },
    { refetchInterval: 30000 }
  );
  const approvedCount = approvedItems.length;

  // Pending story count for Dashboard badge — uses a lightweight COUNT(*) query, refetches every 60s
  const { data: pendingCount = 0 } = trpc.stories.pendingCount.useQuery(
    undefined,
    { refetchInterval: 60000 }
  );

  // Last ingest time — refetches every 60s to stay in sync with the hourly schedule
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

  // Redirect to login page if not authenticated — useEffect must be before any early returns
  useEffect(() => {
    if (!loading && !isAuthenticated) {
      setLocation("/login");
    }
  }, [loading, isAuthenticated, setLocation]);

  // Show loading spinner while auth state resolves
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

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-border bg-sidebar flex flex-col">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <Plane
                className="w-4 h-4 text-primary-foreground"
                strokeWidth={2.5}
              />
            </div>
            <div>
              <p
                className="font-bold text-sm text-sidebar-foreground leading-tight"
                style={{ fontFamily: "Space Grotesk, sans-serif" }}
              >
                Soyunci
              </p>
              <p className="text-[10px] text-muted-foreground leading-tight">
                Aviation Content OS
              </p>
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
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors duration-150",
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

        {/* Last ingested timestamp — always shown; displays "Never" if no ingest has run yet */}
        <div className="px-4 py-2 border-t border-sidebar-border">
          <p className="text-[10px] text-muted-foreground/60 leading-tight">Last ingested</p>
          <p className="text-[11px] text-muted-foreground mt-0.5" title={lastIngestTime ? new Date(lastIngestTime).toLocaleString() : undefined}>
            {lastIngestTime
              ? (() => {
                  const diff = Date.now() - new Date(lastIngestTime).getTime();
                  const mins = Math.floor(diff / 60000);
                  const hrs = Math.floor(mins / 60);
                  if (mins < 1) return "Just now";
                  if (mins < 60) return `${mins} min ago`;
                  if (hrs < 24) return `${hrs}h ago`;
                  return new Date(lastIngestTime).toLocaleDateString();
                })()
              : "Never"}
          </p>
        </div>

        {/* Quick actions */}
        <div className="px-3 pb-4 space-y-2 border-t border-sidebar-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              refreshFeeds.mutate();
            }}
          >
            <RefreshCw
              className={cn("w-3.5 h-3.5", refreshing && "animate-spin")}
            />
            {refreshing ? "Refreshing..." : "Refresh Feeds"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            disabled={reranking}
            onClick={() => {
              setReranking(true);
              rerank.mutate();
            }}
          >
            <LayoutDashboard
              className={cn("w-3.5 h-3.5", reranking && "animate-pulse")}
            />
            {reranking ? "Re-ranking..." : "Re-rank All"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
            disabled={learning}
            onClick={() => {
              setLearning(true);
              learnFromOverrides.mutate();
            }}
            title="Analyse your score overrides and improve the AI scoring rules"
          >
            <BrainCircuit
              className={cn("w-3.5 h-3.5", learning && "animate-pulse")}
            />
            {learning ? "Learning..." : "Learn from Overrides"}
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
