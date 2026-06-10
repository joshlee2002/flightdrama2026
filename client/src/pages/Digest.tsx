import { useState } from "react";
import FlightLayout from "@/components/FlightLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Sparkles, Calendar, TrendingUp, CheckCircle2, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

function formatDateRange(start: Date | string, end: Date | string) {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${e.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

function DigestCard({
  digest,
  isLatest,
}: {
  digest: {
    id: number;
    weekStart: Date | string;
    weekEnd: Date | string;
    storiesApproved: number;
    topCategory: string | null;
    topStoryTitle: string | null;
    topStoryScore: number | null;
    summary: string;
    recommendations: string;
    createdAt: Date | string;
  };
  isLatest: boolean;
}) {
  const [expanded, setExpanded] = useState(isLatest);

  const recLines = digest.recommendations
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card overflow-hidden transition-all",
        isLatest ? "border-primary/30 shadow-sm" : "border-border"
      )}
    >
      {/* Header */}
      <button
        className="w-full flex items-start gap-4 p-4 text-left hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div
          className={cn(
            "shrink-0 w-10 h-10 rounded-lg flex items-center justify-center",
            isLatest ? "bg-primary/15" : "bg-muted"
          )}
        >
          <Calendar className={cn("w-5 h-5", isLatest ? "text-primary" : "text-muted-foreground")} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="text-sm font-semibold text-foreground">
              {formatDateRange(digest.weekStart, digest.weekEnd)}
            </span>
            {isLatest && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
                Latest
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              {digest.storiesApproved} approved
            </span>
            {digest.topCategory && (
              <span className="flex items-center gap-1">
                <TrendingUp className="w-3 h-3 text-blue-400" />
                Top: {digest.topCategory}
              </span>
            )}
            {digest.topStoryScore != null && (
              <span className="text-muted-foreground">
                Best score: {digest.topStoryScore}
              </span>
            )}
          </div>
          {!expanded && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1 italic">
              {digest.summary.slice(0, 120)}…
            </p>
          )}
        </div>
        <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border px-4 pb-5 pt-4 space-y-5">
          {/* Summary */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Weekly Summary
            </p>
            <p className="text-sm text-foreground/90 leading-relaxed">{digest.summary}</p>
          </div>

          {/* Top story */}
          {digest.topStoryTitle && (
            <div className="bg-primary/8 border border-primary/15 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-semibold text-primary uppercase tracking-wide mb-1">
                Top Story This Week
              </p>
              <p className="text-sm text-foreground font-medium leading-snug">{digest.topStoryTitle}</p>
              {digest.topStoryScore != null && (
                <p className="text-xs text-muted-foreground mt-0.5">Score: {digest.topStoryScore}</p>
              )}
            </div>
          )}

          {/* Recommendations */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Lightbulb className="w-3 h-3 text-amber-400" />
              Recommendations for Next Week
            </p>
            <ul className="space-y-2">
              {recLines.map((line, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-foreground/90 leading-relaxed">
                  <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary/60 mt-2" />
                  <span>{line.replace(/^[•\-]\s*/, "")}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Digest() {
  const { data: digests, isLoading, refetch } = trpc.digest.list.useQuery();

  const generate = trpc.digest.generate.useMutation({
    onSuccess: () => {
      toast.success("Weekly digest generated");
      refetch();
    },
    onError: (err) => {
      toast.error(`Failed to generate digest: ${err.message}`);
    },
  });

  return (
    <FlightLayout>
      <div className="p-6 max-w-3xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1
              className="text-2xl font-bold text-foreground"
              style={{ fontFamily: "Space Grotesk, sans-serif" }}
            >
              Weekly Digest
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              AI-generated summaries of your weekly content performance and recommendations
            </p>
          </div>
          <Button
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={() => generate.mutate({})}
            disabled={generate.isPending}
          >
            {generate.isPending ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
            ) : (
              <><Sparkles className="w-3.5 h-3.5" /> Generate This Week</>
            )}
          </Button>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : !digests || digests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">No digests yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-4">
              Generate your first weekly digest to get an AI summary of your content performance and
              recommendations for next week.
            </p>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => generate.mutate({})}
              disabled={generate.isPending}
            >
              {generate.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5" /> Generate First Digest</>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {digests.map((d, i) => (
              <DigestCard key={d.id} digest={d} isLatest={i === 0} />
            ))}
          </div>
        )}
      </div>
    </FlightLayout>
  );
}
