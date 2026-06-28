import { useState } from "react";
import { labelFromScore, effectiveLabel as sharedEffectiveLabel } from "@shared/const";
import FlightLayout from "@/components/FlightLayout";
import ScoreRing from "@/components/ScoreRing";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Check,
  X,
  Loader2,
  Zap,
  Sparkles,
  History as HistoryIcon,
  Sliders,
  Tag,
  BookOpen,
  Brain,
  ChevronRight,
  FlaskConical,
  GitMerge,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusLabel = "must_post" | "strong_candidate" | "maybe" | "reject";

function statusConfig(label: StatusLabel) {
  switch (label) {
    case "must_post":
      return { text: "Must Post", className: "status-must-post" };
    case "strong_candidate":
      return { text: "Strong Candidate", className: "status-strong-candidate" };
    case "maybe":
      return { text: "Maybe", className: "status-maybe" };
    case "reject":
      return { text: "Reject", className: "status-reject" };
  }
}

function approvalBadge(status: string) {
  switch (status) {
    case "approved":
      return <span className="text-xs text-emerald-400 font-medium">Approved</span>;
    case "rejected":
      return <span className="text-xs text-red-400 font-medium">Rejected</span>;
    case "edited":
      return <span className="text-xs text-blue-400 font-medium">Edited</span>;
    default:
      return null;
  }
}

interface StoryCardProps {
  rank: number;
  story: any;
  pkg: any;
  onApprove: (variant?: string) => void;
  onReject: () => void;
  onDismiss: () => void;
  onDismissAsDuplicate: (canonicalStoryId?: number) => void;
  onProcess: () => void;
  onOverrideScore: (score: number | null, label: string | null) => void;
  isProcessing: boolean;
  isSavingOverride: boolean;
}

function StoryCard({
  rank,
  story,
  pkg,
  onApprove,
  onReject,
  onDismiss,
  onDismissAsDuplicate,
  onProcess,
  onOverrideScore,
  isProcessing,
  isSavingOverride,
}: StoryCardProps) {
  const [overrideInput, setOverrideInput] = useState(
    story.overrideScore != null ? String(story.overrideScore) : String(story.viralScore)
  );
  // Expandable detail panel — collapsed by default
  const [showDetail, setShowDetail] = useState(false);
  // Apprentice panel — collapsed by default inside detail
  const [showApprentice, setShowApprentice] = useState(false);

  const hasOverride = story.overrideScore != null;
  const displayScore = hasOverride ? story.overrideScore : story.viralScore;
  const displayLabel = sharedEffectiveLabel(story);
  const displayStatus = statusConfig((displayLabel || story.statusLabel) as StatusLabel);

  const isFailed = pkg?.processingStatus === "failed";
  const isQueued = pkg?.processingStatus === "queued" || !pkg;
  const hasResearchReady = !!(pkg?.storySummary || (pkg?.extractedFacts && pkg.extractedFacts !== "[]") || pkg?.researchExtracted);

  return (
    <div
      className={cn(
        "story-card rounded-xl border border-border bg-card overflow-hidden",
        story.approvalStatus === "approved" && "border-emerald-500/40",
        story.approvalStatus === "rejected" && "opacity-50 border-red-500/20"
      )}
    >
      {/* ── Main card row — tight single-line layout ── */}
      <div className="px-3 py-2.5 flex items-center gap-3">
        {/* Rank */}
        <span className="shrink-0 text-[10px] font-bold text-muted-foreground/50 w-5 text-right tabular-nums">
          #{rank}
        </span>

        {/* Score ring with AI/override badge */}
        <div className="relative shrink-0">
          <ScoreRing score={displayScore} />
          {hasOverride && (
            <div
              className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-amber-500 flex items-center justify-center"
              title="Manually overridden score"
            >
              <Sliders className="w-2 h-2 text-black" />
            </div>
          )}
          {!hasOverride && story.scoringMethod === "llm_assisted" && (
            <div
              className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-violet-500 flex items-center justify-center"
              title="AI apprentice score"
            >
              <span className="text-[7px] font-bold text-white leading-none">AI</span>
            </div>
          )}
        </div>

        {/* Title + meta — takes remaining space */}
        <div className="flex-1 min-w-0">
          {/* Status pill + category + approval badge — single tight row */}
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium leading-none", displayStatus.className)}>
              {displayStatus.text}
              {hasOverride && <span className="ml-1 opacity-60">(override)</span>}
            </span>
            {story.category && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full leading-none">
                {story.category}
              </span>
            )}
            {approvalBadge(story.approvalStatus)}
          </div>

          {/* Headline */}
          <h3 className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
            {story.title}
          </h3>

          {/* Source line */}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {story.sourceName && (
              <span className="text-[11px] text-muted-foreground">{story.sourceName}</span>
            )}
            {story.publishedAt && (
              <span className="text-[11px] text-muted-foreground">
                {new Date(story.publishedAt).toLocaleDateString()}
              </span>
            )}
            {/* Research-ready badge — just a small indicator, no content */}
            {hasResearchReady && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 cursor-default leading-none">
                    <BookOpen className="w-2.5 h-2.5" />
                    Research ready
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[220px]">
                  Research package available — view full details in the Approved Queue after approving.
                </TooltipContent>
              </Tooltip>
            )}
            {/* Sources researched badge */}
            {!hasResearchReady && pkg?.sourcesResearched != null && pkg.sourcesResearched > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 leading-none">
                <FlaskConical className="w-2.5 h-2.5" />
                {pkg.sourcesResearched} sources
              </span>
            )}
            {/* Editor quality score */}
            {(pkg as any)?.editorScore != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border cursor-default font-medium leading-none ${
                    (pkg as any).editorScore >= 8 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                    (pkg as any).editorScore >= 6 ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                    'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}>
                    ✦ {(pkg as any).editorScore}/10
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[260px] space-y-1">
                  {(() => {
                    const r = (pkg as any).editorReview as any;
                    if (!r) return <p>Editor score: {(pkg as any).editorScore}/10</p>;
                    return (
                      <div className="space-y-1">
                        <p><span className="font-semibold">Score:</span> {r.soyunciScore}/10 — {r.verdict}</p>
                        {r.storyAngle && <p><span className="font-semibold">Angle:</span> {r.storyAngle}</p>}
                        {r.biggestWeakness && r.biggestWeakness !== 'None' && <p><span className="font-semibold">Weakness:</span> {r.biggestWeakness}</p>}
                      </div>
                    );
                  })()}
                </TooltipContent>
              </Tooltip>
            )}
            <a
              href={story.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline"
            >
              Source <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
        </div>

        {/* Action buttons — right side, always visible */}
        <div className="shrink-0 flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all"
                onClick={() => onApprove()}
              >
                <Check className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[220px]">Approve — runs research extraction and adds to your publishing queue</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 hover:bg-red-500/20 active:scale-95 transition-all"
                onClick={() => onReject()}
              >
                <X className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[240px]">Reject — permanently hides this story and teaches the scorer to rank similar stories lower in future</TooltipContent>
          </Tooltip>
          {/* Expand detail toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "w-8 h-8 rounded-lg border flex items-center justify-center transition-all active:scale-95",
                  showDetail
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "bg-muted/40 border-border text-muted-foreground hover:text-foreground hover:bg-muted/70"
                )}
                onClick={() => setShowDetail(v => !v)}
              >
                {showDetail ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[240px]">{showDetail ? "Hide score breakdown and override controls" : "Show why this story scored this way, and manually override the score"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Trigger pills — shown below main row, compact ── */}
      {story.viralTriggers && story.viralTriggers.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {(story.viralTriggers as string[]).slice(0, 3).map((trigger: string, i: number) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/15 leading-none"
            >
              <Tag className="w-2 h-2" />
              {trigger.length > 45 ? trigger.slice(0, 43) + "…" : trigger}
            </span>
          ))}
          {story.viralTriggers.length > 3 && (
            <span className="text-[10px] text-muted-foreground/60 px-1 py-0.5 leading-none">
              +{story.viralTriggers.length - 3} more
            </span>
          )}
        </div>
      )}

      {/* ── Expandable detail panel ── */}
      {showDetail && (
        <div className="border-t border-border/40 bg-muted/10">
          {/* Viral reason */}
          {(story.viralExplanation || story.viralReason) && (
            <div className="px-3 pt-2.5 pb-2">
              <p className="text-xs text-muted-foreground/80 italic leading-relaxed">
                {story.viralExplanation || story.viralReason}
              </p>
            </div>
          )}

          {/* Apprentice reasoning — collapsible */}
          {(story.apprenticeReasoning || story.apprenticeConfidence) && (
            <div className="px-3 pb-2.5">
              <button
                className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-400 uppercase tracking-wide hover:text-violet-300 transition-colors mb-1"
                onClick={() => setShowApprentice(v => !v)}
              >
                <Brain className="w-3 h-3" />
                Why this score?
                {story.apprenticeConfidence && (
                  <span className={`ml-1 font-medium px-1.5 py-0.5 rounded normal-case tracking-normal ${
                    story.apprenticeConfidence === "High" ? "bg-green-500/20 text-green-400" :
                    story.apprenticeConfidence === "Medium" ? "bg-amber-500/20 text-amber-400" :
                    "bg-red-500/20 text-red-400"
                  }`}>
                    {story.apprenticeConfidence} confidence
                  </span>
                )}
                <ChevronRight className={cn("w-3 h-3 ml-auto transition-transform", showApprentice && "rotate-90")} />
              </button>
              {showApprentice && (
                <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-2.5 py-2 space-y-1.5">
                  {story.apprenticeReasoning && (
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {story.apprenticeReasoning}
                    </p>
                  )}
                  {story.ruleScore !== undefined && story.ruleScore !== null && (
                    <p className="text-[10px] text-muted-foreground/50">
                      Rule-based score (debug): {story.ruleScore}
                    </p>
                  )}
                  {story.similarExamplesUsed && (() => {
                    try {
                      const examples = typeof story.similarExamplesUsed === "string"
                        ? JSON.parse(story.similarExamplesUsed) as string[]
                        : story.similarExamplesUsed as string[];
                      if (Array.isArray(examples) && examples.length > 0) {
                        return (
                          <p className="text-[10px] text-muted-foreground/50">
                            <span className="font-medium">Similar examples:</span>{" "}
                            {examples.slice(0, 3).map((t, i) => (
                              <span key={i} className="italic">"{t.slice(0, 50)}{t.length > 50 ? "…" : ""}"{i < Math.min(examples.length, 3) - 1 ? ", " : ""}</span>
                            ))}
                            {examples.length > 3 && <span> +{examples.length - 3} more</span>}
                          </p>
                        );
                      }
                    } catch { /* ignore */ }
                    return null;
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Override score row */}
          <div className="border-t border-border/30 px-3 py-2.5 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground shrink-0">Override score:</span>
            <div className="flex items-center gap-1">
              <button
                className="w-7 h-7 rounded-md border border-border bg-muted/40 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 active:scale-95 transition-all text-sm font-bold select-none"
                onClick={() => setOverrideInput(v => String(Math.max(0, (parseInt(v, 10) || 0) - 1)))}
              >−</button>
              <input
                type="number"
                min={0}
                max={100}
                value={overrideInput}
                onChange={(e) => setOverrideInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = parseInt(overrideInput, 10);
                    if (!isNaN(v) && v >= 0 && v <= 100) {
                      onOverrideScore(v, labelFromScore(v));
                    }
                  }
                }}
                className="w-11 h-7 text-sm font-bold text-center bg-muted/40 border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                className="w-7 h-7 rounded-md border border-border bg-muted/40 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 active:scale-95 transition-all text-sm font-bold select-none"
                onClick={() => setOverrideInput(v => String(Math.min(100, (parseInt(v, 10) || 0) + 1)))}
              >+</button>
            </div>
            <button
              className="h-7 px-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium hover:bg-amber-500/20 active:scale-95 transition-all disabled:opacity-50"
              disabled={isSavingOverride}
              onClick={() => {
                const v = parseInt(overrideInput, 10);
                if (!isNaN(v) && v >= 0 && v <= 100) {
                  onOverrideScore(v, labelFromScore(v));
                }
              }}
            >
              {isSavingOverride ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
            </button>
            {hasOverride && (
              <button
                className="h-7 px-2 rounded-md text-muted-foreground text-xs hover:text-foreground transition-colors"
                onClick={() => { setOverrideInput(String(story.viralScore)); onOverrideScore(null, null); }}
              >
                Clear
              </button>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="h-7 px-2 rounded-md border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-muted/40 transition-all flex items-center gap-1"
                    onClick={() => onDismiss()}
                  >
                    <X className="w-3 h-3" />Dismiss
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-[240px]">Dismiss — hides this story without affecting the scorer. Use when you're just not interested, not because the story is bad</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="h-7 px-2 rounded-md border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-muted/40 transition-all flex items-center gap-1"
                    onClick={() => onDismissAsDuplicate()}
                  >
                    <GitMerge className="w-3 h-3" />Duplicate
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-[240px]">Duplicate — hides this story and teaches the system to filter similar duplicate stories in future</TooltipContent>
              </Tooltip>
              {isQueued && !isFailed && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="h-7 px-2 rounded-md border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-muted/40 transition-all flex items-center gap-1 disabled:opacity-50"
                      disabled={isProcessing}
                      onClick={() => onProcess()}
                    >
                      {isProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      Research
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs max-w-[240px]">Research — manually fetch sources and extract facts, quotes, and timeline for this story before approving</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          {/* Pipeline status messages */}
          {pkg?.processingStatus === "processing" && (
            <div className="border-t border-border/30 px-3 py-2 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin text-primary/60" />
              <span className="text-xs text-muted-foreground">Soyunci is researching…</span>
            </div>
          )}
          {isFailed && pkg?.processingError && (
            <div className="border-t border-border/30 px-3 py-2">
              <p className="text-xs text-red-400">Pipeline failed: {pkg.processingError}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [completedOnly, setCompletedOnly] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [sortBy, setSortBy] = useState<"top_scored" | "newest">("top_scored");
  const [processingIds, setProcessingIds] = useState<Set<number>>(new Set());
  const [showLearningPanel, setShowLearningPanel] = useState(false);
  const SECTION_PAGE_SIZE = 50;
  const [sectionLimits, setSectionLimits] = useState<Record<string, number>>({
    must_post: SECTION_PAGE_SIZE,
    strong_candidate: SECTION_PAGE_SIZE,
    maybe: SECTION_PAGE_SIZE,
    reject: SECTION_PAGE_SIZE,
  });
  const showMoreSection = (key: string) =>
    setSectionLimits(prev => ({ ...prev, [key]: (prev[key] ?? SECTION_PAGE_SIZE) + SECTION_PAGE_SIZE }));

  const utils = trpc.useUtils();
  const { data: insights } = trpc.stories.scoringInsights.useQuery();
  const learnMutation = trpc.stories.learnFromOverrides.useMutation({
    onSuccess: (result) => {
      utils.stories.scoringInsights.invalidate();
      if (result.success) {
        toast.success(`Learning complete — ${(result.summary ?? '').slice(0, 80)}`);
      } else {
        toast.error(result.summary || 'Learning failed');
      }
    },
    onError: (err) => toast.error(`Learning failed: ${err.message}`),
  });

  const queryInput = {
    ...(completedOnly ? { completedOnly: true } : {}),
    ...(!showHistory ? { approvalStatus: "pending" } : {}),
    sortBy,
  };

  const { data, isLoading } = trpc.stories.list.useQuery(queryInput);

  const approve = trpc.stories.approve.useMutation({
    onSuccess: () => { toast.success("Story approved"); utils.stories.list.invalidate(); },
  });
  const reject = trpc.stories.reject.useMutation({
    onSuccess: () => { toast.success("Story rejected"); utils.stories.list.invalidate(); utils.stories.pendingCount.invalidate(); },
  });
  const dismiss = trpc.stories.dismiss.useMutation({
    onSuccess: () => { toast.success("Story dismissed"); utils.stories.list.invalidate(); utils.stories.pendingCount.invalidate(); },
  });
  const dismissAsDuplicate = trpc.stories.dismissAsDuplicate.useMutation({
    onSuccess: () => { toast.success("Dismissed as duplicate"); utils.stories.list.invalidate(); utils.stories.pendingCount.invalidate(); },
  });
  const retryStory = trpc.stories.retryStory.useMutation({
    onSuccess: (_data: unknown, variables: { storyId: number }) => {
      setProcessingIds((prev) => { const next = new Set(prev); next.delete(variables.storyId); return next; });
      toast.success("Story processed by Soyunci");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { storyId: number }) => {
      setProcessingIds((prev) => { const next = new Set(prev); next.delete(variables.storyId); return next; });
      toast.error(`Processing failed: ${err.message}`);
    },
  });

  // Duplicate modal state
  const [duplicateModalStoryId, setDuplicateModalStoryId] = useState<number | null>(null);
  const { data: duplicateCandidates, isFetching: loadingCandidates } = trpc.stories.getDuplicateCandidates.useQuery(
    { id: duplicateModalStoryId! },
    { enabled: duplicateModalStoryId !== null }
  );

  const [overridingIds, setOverridingIds] = useState<Set<number>>(new Set());

  const overrideScore = trpc.stories.overrideScore.useMutation({
    onSuccess: (_data: unknown, variables: { id: number }) => {
      setOverridingIds((prev) => { const next = new Set(prev); next.delete(variables.id); return next; });
      toast.success("Score override saved");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { id: number }) => {
      setOverridingIds((prev) => { const next = new Set(prev); next.delete(variables.id); return next; });
      toast.error(`Override failed: ${err.message}`);
    },
  });

  const handleOverrideScore = (storyId: number, score: number | null, label: string | null) => {
    setOverridingIds((prev) => new Set(prev).add(storyId));
    overrideScore.mutate({ id: storyId, overrideScore: score, overrideLabel: label as any });
  };
  const handleProcess = (storyId: number) => {
    setProcessingIds((prev) => new Set(prev).add(storyId));
    retryStory.mutate({ storyId });
  };

  const allStories = data || [];
  const effectiveLabel = (s: any) => sharedEffectiveLabel(s);

  const stories = filterStatus === "all"
    ? allStories
    : allStories.filter((s) => effectiveLabel(s.story) === filterStatus);

  const counts = {
    must_post: allStories.filter((s) => effectiveLabel(s.story) === "must_post").length,
    strong_candidate: allStories.filter((s) => effectiveLabel(s.story) === "strong_candidate").length,
    maybe: allStories.filter((s) => effectiveLabel(s.story) === "maybe").length,
    reject: allStories.filter((s) => effectiveLabel(s.story) === "reject").length,
  };

  const grouped = {
    must_post: stories.filter((s) => effectiveLabel(s.story) === "must_post"),
    strong_candidate: stories.filter((s) => effectiveLabel(s.story) === "strong_candidate"),
    maybe: stories.filter((s) => effectiveLabel(s.story) === "maybe"),
    reject: stories.filter((s) => effectiveLabel(s.story) === "reject"),
  };

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    must_post: false,
    strong_candidate: false,
    maybe: true,
    reject: true,
  });
  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const SECTION_CONFIG = [
    { key: "must_post",        label: "Must Post",        color: "text-emerald-400", dot: "bg-emerald-400" },
    { key: "strong_candidate", label: "Strong Candidate", color: "text-blue-400",    dot: "bg-blue-400" },
    { key: "maybe",            label: "Maybe",            color: "text-amber-400",   dot: "bg-amber-400" },
    { key: "reject",           label: "Reject",           color: "text-red-400",     dot: "bg-red-400" },
  ];

  return (
    <FlightLayout>
      <div className="p-4 lg:p-6">
        {/* Header */}
        <div className="flex flex-col gap-3 mb-4 lg:mb-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl lg:text-2xl font-bold text-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                Story Dashboard
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {stories.length} stories ranked by viral potential
              </p>
            </div>
          </div>

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "px-3 h-8 text-xs font-medium transition-colors flex items-center gap-1.5",
                      sortBy === "top_scored" ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    )}
                    onClick={() => setSortBy("top_scored")}
                  >
                    <Zap className="w-3 h-3" />Top Scored
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[220px]">Sort by viral score — highest scoring stories appear first</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "px-3 h-8 text-xs font-medium transition-colors flex items-center gap-1.5 border-l border-border",
                      sortBy === "newest" ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    )}
                    onClick={() => setSortBy("newest")}
                  >
                    <Tag className="w-3 h-3" />Newest
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[220px]">Sort by ingestion time — most recently fetched stories appear first</TooltipContent>
              </Tooltip>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant={showHistory ? "default" : "outline"} className="text-xs h-8 gap-1.5" onClick={() => setShowHistory(!showHistory)}>
                  <HistoryIcon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{showHistory ? "Showing All" : "New Only"}</span>
                  <span className="sm:hidden">{showHistory ? "All" : "New"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-[240px]">{showHistory ? "Showing all stories including approved/rejected — click to show only pending" : "Showing only pending stories — click to include approved and rejected history"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant={completedOnly ? "default" : "outline"} className="text-xs h-8 gap-1.5" onClick={() => setCompletedOnly(!completedOnly)}>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{completedOnly ? "Completed Only" : "All Stories"}</span>
                  <span className="sm:hidden">{completedOnly ? "Done" : "All"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-[240px]">{completedOnly ? "Showing only stories with completed research packages — click to show all" : "Showing all stories — click to show only those with completed research ready"}</TooltipContent>
            </Tooltip>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-36 lg:w-44 text-xs h-8">
                <SelectValue placeholder="Filter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="must_post">Must Post</SelectItem>
                <SelectItem value="strong_candidate">Strong Candidate</SelectItem>
                <SelectItem value="maybe">Maybe</SelectItem>
                <SelectItem value="reject">Reject</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Score summary bar — compact clickable tiles */}
        <div className="grid grid-cols-4 gap-2 mb-4 lg:mb-5">
          {[
            { key: "must_post",        label: "Must Post",        color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
            { key: "strong_candidate", label: "Strong Candidate", color: "text-blue-400",    bg: "bg-blue-500/10 border-blue-500/20" },
            { key: "maybe",            label: "Maybe",            color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/20" },
            { key: "reject",           label: "Reject",           color: "text-red-400",     bg: "bg-red-500/10 border-red-500/20" },
          ].map(({ key, label, color, bg }) => (
            <button
              key={key}
              className={cn("rounded-xl border p-2 lg:p-3 text-left transition-all", bg, filterStatus === key ? "ring-1 ring-current" : "hover:opacity-80")}
              onClick={() => setFilterStatus(filterStatus === key ? "all" : key)}
            >
              <p className={cn("text-xl lg:text-2xl font-bold", color)} style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                {counts[key as keyof typeof counts]}
              </p>
              <p className="text-[10px] lg:text-xs text-muted-foreground mt-0.5 leading-tight">{label}</p>
            </button>
          ))}
        </div>

        {/* AI Learning Status — collapsed by default */}
        {insights && (
          <div className="mb-4 rounded-xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-violet-300 hover:bg-violet-500/10 transition-colors"
              onClick={() => setShowLearningPanel(!showLearningPanel)}
            >
              <span className="flex items-center gap-2">
                <Brain className="w-4 h-4" />
                <span className="text-sm">AI Learning Status</span>
                {insights.lastLearnedAt ? (
                  <span className="text-xs text-muted-foreground font-normal">
                    Last updated {new Date(insights.lastLearnedAt).toLocaleDateString()} · {insights.lastLearnedExamplesCount ?? 0} examples
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground font-normal">No learning data yet</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 border-violet-500/30 text-violet-300 hover:bg-violet-500/10"
                  disabled={learnMutation.isPending}
                  onClick={(e) => { e.stopPropagation(); learnMutation.mutate(); }}
                  title="Re-run the statistical learner now — analyses your recent approvals, rejections, and score overrides to update scoring weights and keyword rules"
                >
                  {learnMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                  {learnMutation.isPending ? 'Learning...' : 'Re-learn Now'}
                </Button>
                <ChevronRight className={cn("w-4 h-4 transition-transform", showLearningPanel && "rotate-90")} />
              </div>
            </button>
            {showLearningPanel && (
              <div className="px-4 pb-4 pt-1 space-y-3 border-t border-violet-500/15">
                {insights.learnedRules && (
                  <div>
                    <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wide mb-1.5">Learned Scoring Rules</p>
                    <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{insights.learnedRules}</p>
                  </div>
                )}
                {insights.learnedInsights && (
                  <div>
                    <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wide mb-1.5">Editor Insights</p>
                    <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{insights.learnedInsights}</p>
                  </div>
                )}
                {insights.learnedWeights && (
                  <div>
                    <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wide mb-1.5">Category Weights</p>
                    <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{insights.learnedWeights}</p>
                  </div>
                )}
                {!insights.learnedRules && !insights.learnedInsights && !insights.learnedWeights && (
                  <p className="text-xs text-muted-foreground italic">Override some story scores on the dashboard, then click "Re-learn Now" to train the AI on your preferences.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Story cards — grouped by section */}
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : stories.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">No stories yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Use the sidebar to refresh your RSS feeds or add stories manually via the Add Stories page.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {SECTION_CONFIG.map(({ key, label, color, dot }) => {
              const sectionStories = grouped[key as keyof typeof grouped];
              if (sectionStories.length === 0) return null;
              const isCollapsed = collapsedSections[key];
              const limit = sectionLimits[key] ?? SECTION_PAGE_SIZE;
              const visibleStories = sectionStories.slice(0, limit);
              const hasMore = sectionStories.length > limit;
              const rankOffset = SECTION_CONFIG.slice(0, SECTION_CONFIG.findIndex(s => s.key === key))
                .reduce((acc, s) => acc + grouped[s.key as keyof typeof grouped].length, 0);
              return (
                <div key={key}>
                  {/* Slim section header — just a line with label and count */}
                  <button
                    className="w-full flex items-center gap-2 mb-2 group"
                    onClick={() => toggleSection(key)}
                  >
                    <span className={cn("w-2 h-2 rounded-full shrink-0", dot)} />
                    <span className={cn("text-xs font-semibold", color)}>{label}</span>
                    <span className="text-xs text-muted-foreground">
                      {sectionStories.length} {sectionStories.length === 1 ? "story" : "stories"}
                    </span>
                    <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
                    <ChevronRight className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0", !isCollapsed && "rotate-90")} />
                  </button>

                  {/* Section stories */}
                  {!isCollapsed && (
                    <div className="space-y-2">
                      {visibleStories.map(({ story, package: pkg }, index) => (
                        <StoryCard
                          key={story.id}
                          rank={rankOffset + index + 1}
                          story={story}
                          pkg={pkg}
                          isProcessing={processingIds.has(story.id)}
                          isSavingOverride={overridingIds.has(story.id)}
                          onApprove={(variant) => approve.mutate({ id: story.id, usedHeadlineVariant: variant })}
                          onReject={() => reject.mutate({ id: story.id })}
                          onDismiss={() => dismiss.mutate({ id: story.id })}
                          onDismissAsDuplicate={(canonicalId) => {
                            if (canonicalId !== undefined) {
                              dismissAsDuplicate.mutate({ id: story.id, canonicalStoryId: canonicalId });
                            } else {
                              setDuplicateModalStoryId(story.id);
                            }
                          }}
                          onProcess={() => handleProcess(story.id)}
                          onOverrideScore={(score, label) => handleOverrideScore(story.id, score, label)}
                        />
                      ))}
                      {hasMore && (
                        <button
                          className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-lg hover:border-primary/40 transition-colors"
                          onClick={() => showMoreSection(key)}
                        >
                          Show {Math.min(SECTION_PAGE_SIZE, sectionStories.length - limit)} more ({sectionStories.length - limit} remaining)
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* ── Duplicate canonical selection modal ── */}
      {duplicateModalStoryId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setDuplicateModalStoryId(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Which story is this a duplicate of?</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Select the original story, or skip to dismiss without linking</p>
              </div>
              <button
                className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                onClick={() => setDuplicateModalStoryId(null)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-2">
              {loadingCandidates ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                </div>
              ) : !duplicateCandidates || duplicateCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">No similar stories found in recent history.</p>
              ) : (
                duplicateCandidates.map((candidate: any) => (
                  <button
                    key={candidate.id}
                    className="w-full text-left rounded-xl border border-border bg-muted/20 hover:bg-muted/50 hover:border-primary/40 transition-all px-3.5 py-3 group"
                    onClick={() => {
                      const storyId = duplicateModalStoryId;
                      setDuplicateModalStoryId(null);
                      dismissAsDuplicate.mutate({ id: storyId!, canonicalStoryId: candidate.id });
                      toast.success("Dismissed as duplicate — pair recorded");
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-foreground leading-snug line-clamp-2 flex-1">{candidate.title}</p>
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-medium">
                        {Math.round(candidate.confidence * 100)}% match
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      {candidate.sourceName && (
                        <span className="text-[10px] text-muted-foreground">{candidate.sourceName}</span>
                      )}
                      {candidate.publishedAt && (
                        <span className="text-[10px] text-muted-foreground">{new Date(candidate.publishedAt).toLocaleDateString()}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground">Score: {candidate.viralScore}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="px-4 pb-4">
              <button
                className="w-full h-9 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-border/70 transition-colors"
                onClick={() => {
                  const storyId = duplicateModalStoryId;
                  setDuplicateModalStoryId(null);
                  dismissAsDuplicate.mutate({ id: storyId! });
                  toast.success("Dismissed as duplicate");
                }}
              >
                Skip — dismiss without selecting canonical
              </button>
            </div>
          </div>
        </div>
      )}
    </FlightLayout>
  );
}
