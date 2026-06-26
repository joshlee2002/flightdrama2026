import { useState } from "react";
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
  Edit3,
  Copy,
  Loader2,
  Zap,
  Image,
  FileText,
  Palette,
  Hash,
  Sparkles,
  History as HistoryIcon,
  Sliders,
  Tag,
  Download,
  BookOpen,
  RefreshCw,
  Trash2,
  Brain,
  ChevronRight,
  Search,
  FlaskConical,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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


// ── HeroImageSlot — image thumbnail with skeleton shimmer while loading ────────
function HeroImageSlot({
  thumbUrl,
  description,
  isAiGenerated = false,
  aiPrompt,
}: {
  thumbUrl: string;
  description: string;
  isAiGenerated?: boolean;
  aiPrompt?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  return (
    <div className="relative mx-3 mb-2 rounded overflow-hidden bg-muted/30" style={{ aspectRatio: "16/9" }}>
      {/* Skeleton shimmer shown until image loads */}
      {!loaded && !errored && (
        <div className="absolute inset-0 z-10">
          <Skeleton className="w-full h-full rounded-none" />
          {isAiGenerated && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 z-20">
              <Sparkles className="w-5 h-5 text-primary/60 animate-pulse" />
              <span className="text-[10px] text-muted-foreground/70 font-medium">Generating AI image…</span>
            </div>
          )}
        </div>
      )}
      {/* Actual image — invisible until loaded */}
      {!errored && (
        <img
          src={thumbUrl}
          alt={description}
          className={cn(
            "w-full h-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      )}
      {/* AI-generated badge overlay — with prompt tooltip */}
      {loaded && isAiGenerated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded px-1.5 py-0.5 cursor-help">
              <Sparkles className="w-2.5 h-2.5 text-primary" />
              <span className="text-[9px] text-primary font-medium">AI Generated</span>
            </div>
          </TooltipTrigger>
          {aiPrompt && (
            <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed whitespace-normal">
              <p className="font-semibold mb-1 text-[10px] uppercase tracking-wide opacity-70">Image prompt</p>
              <p>{aiPrompt}</p>
            </TooltipContent>
          )}
        </Tooltip>
      )}
    </div>
  );
}

interface StoryCardProps {
  rank: number;
  story: any;
  pkg: any;
  onApprove: (variant?: string) => void;
  onReject: () => void;
  onDismiss: () => void;
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
  onProcess,
  onOverrideScore,
  isProcessing,
  isSavingOverride,
}: StoryCardProps) {
  const [showVariantPicker, setShowVariantPicker] = useState(false);
  const [chosenVariant, setChosenVariant] = useState<string>("selected");
  // Pre-populate with override score if set, otherwise the viral score,
  // so the spin arrows always step from the current value rather than from 0.
  const [overrideInput, setOverrideInput] = useState(
    story.overrideScore != null ? String(story.overrideScore) : String(story.viralScore)
  );
  const hasOverride = story.overrideScore != null;
  const displayScore = hasOverride ? story.overrideScore : story.viralScore;
  const displayLabel = hasOverride ? story.overrideLabel : story.statusLabel;
  const displayStatus = statusConfig((displayLabel || story.statusLabel) as StatusLabel);

  const isFailed = pkg?.processingStatus === "failed";
  const isQueued = pkg?.processingStatus === "queued" || !pkg;

  return (
    <div
      className={cn(
        "story-card rounded-xl border border-border bg-card overflow-hidden",
        story.approvalStatus === "approved" && "border-emerald-500/40",
        story.approvalStatus === "rejected" && "opacity-50 border-red-500/20"
      )}
    >
      {/* Card header */}
      <div className="p-4 flex items-start gap-4">
        {/* Rank */}
        <div className="shrink-0 w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
          <span className="text-xs font-bold text-muted-foreground">#{rank}</span>
        </div>

        {/* Score ring — shows override score if set */}
        <div className="relative">
          <ScoreRing score={displayScore} />
          {hasOverride && (
            <div className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-amber-500 flex items-center justify-center" title="Manually overridden score">
              <Sliders className="w-2 h-2 text-black" />
            </div>
          )}
          {!hasOverride && story.scoringMethod === "llm_assisted" && (
            <div
              className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-violet-500 flex items-center justify-center"
              title="Score generated by AI using your override history"
            >
              <span className="text-[7px] font-bold text-white leading-none">AI</span>
            </div>
          )}
        </div>

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", displayStatus.className)}>
              {displayStatus.text}
              {hasOverride && <span className="ml-1 opacity-60">(override)</span>}
              {!hasOverride && story.scoringMethod === "llm_assisted" && (
                <span className="ml-1 opacity-60">(AI)</span>
              )}
            </span>
            {story.category && (
              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                {story.category}
              </span>
            )}
            {approvalBadge(story.approvalStatus)}
          </div>
          <h3 className="text-sm font-semibold text-foreground leading-snug line-clamp-2 mb-1">
            {story.title}
          </h3>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {story.sourceName && <span>{story.sourceName}</span>}
            {story.publishedAt && (
              <span>{new Date(story.publishedAt).toLocaleDateString()}</span>
            )}
            {/* Research depth indicator — shown when sources were fetched */}
            {pkg?.sourcesResearched != null && pkg.sourcesResearched > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 cursor-default">
                    <FlaskConical className="w-2.5 h-2.5" />
                    {pkg.sourcesResearched} source{pkg.sourcesResearched !== 1 ? 's' : ''}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[200px]">
                  {pkg.sourcesResearched} source{pkg.sourcesResearched !== 1 ? 's' : ''} fetched and used during the Soyunci pipeline research step
                </TooltipContent>
              </Tooltip>
            )}
            {/* Editor quality score badge */}
            {(pkg as any)?.editorScore != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border cursor-default font-medium ${
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
                        {r.missingContext && r.missingContext !== 'None' && <p><span className="font-semibold">Missing:</span> {r.missingContext}</p>}
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
              className="flex items-center gap-1 text-primary hover:underline"
            >
              Source <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {/* Trigger breakdown tags */}
          {story.viralTriggers && story.viralTriggers.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {(story.viralTriggers as string[]).slice(0, 4).map((trigger: string, i: number) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/15"
                >
                  <Tag className="w-2.5 h-2.5" />
                  {trigger.length > 40 ? trigger.slice(0, 38) + "…" : trigger}
                </span>
              ))}
              {story.viralTriggers.length > 4 && (
                <span className="text-[10px] text-muted-foreground px-1.5 py-0.5">
                  +{story.viralTriggers.length - 4} more
                </span>
              )}
            </div>
          )}
          {/* Score explanation — shown below triggers */}
          {(story.viralExplanation || story.viralReason) && (
            <p className="text-xs text-muted-foreground/80 mt-1.5 italic leading-relaxed">
              {story.viralExplanation || story.viralReason}
            </p>
          )}
        </div>

        {/* Manual score override */}
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={100}
              value={overrideInput}
              onChange={(e) => setOverrideInput(e.target.value)}
              className="w-16 h-7 text-xs text-center px-1 bg-muted/40 border-border"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs gap-1 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
              disabled={isSavingOverride}
              onClick={() => {
                const v = parseInt(overrideInput, 10);
                if (!isNaN(v) && v >= 0 && v <= 100) {
                  const label = v >= 88 ? "must_post" : v >= 70 ? "strong_candidate" : v >= 55 ? "maybe" : "reject";
                  onOverrideScore(v, label);
                } else if (overrideInput === "") {
                  onOverrideScore(null, null);
                }
              }}
            >
              {isSavingOverride ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sliders className="w-3 h-3" />}
            </Button>
          </div>
          {hasOverride && (
            <button
              className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
              onClick={() => { setOverrideInput(String(story.viralScore)); onOverrideScore(null, null); }}
            >
              clear override
            </button>
          )}
        </div>

        {/* Process / approve / reject */}
        <div className="shrink-0 flex items-center gap-2">
          {isQueued && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs"
              onClick={onProcess}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-primary" />
              )}
              {isProcessing ? "Processing..." : "Run Soyunci"}
            </Button>
          )}
          {isFailed && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs border-red-500/30 text-red-400"
              onClick={onProcess}
              disabled={isProcessing}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Retry
            </Button>
          )}
          {story.approvalStatus === "pending" || story.approvalStatus === "edited" ? (
            <>
              {showVariantPicker && pkg?.allHeadlines?.length > 0 ? (
                <div className="flex flex-col gap-1.5 items-end">
                  <p className="text-[10px] text-muted-foreground">Which headline will you post?</p>
                  <Select value={chosenVariant} onValueChange={setChosenVariant}>
                    <SelectTrigger className="h-7 text-xs w-52 bg-muted/30">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="selected">AI Selected (recommended)</SelectItem>
                      {(pkg.allHeadlines as string[]).slice(0, 9).map((h: string, i: number) => (
                        <SelectItem key={i} value={`alt_${i + 1}`}>
                          Alt {i + 1}: {h.length > 40 ? h.slice(0, 38) + "…" : h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="gap-1.5 text-xs h-7 bg-emerald-600 hover:bg-emerald-500 text-white"
                      onClick={() => { setShowVariantPicker(false); onApprove(chosenVariant); }}
                    >
                      <Check className="w-3 h-3" /> Confirm
                    </Button>
                    <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setShowVariantPicker(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                onClick={() => {
                  if (pkg?.allHeadlines?.length > 0) {
                    setShowVariantPicker(true);
                  } else {
                    onApprove();
                  }
                }}
              >
                <Check className="w-3.5 h-3.5" />
                Approve
              </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10"
                onClick={onReject}
              >
                <X className="w-3.5 h-3.5" />
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={onDismiss}
                title="Dismiss permanently — hides this story and prevents it from returning"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Dismiss
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Compact processing status */}
      {pkg?.processingStatus === "processing" && (
        <div className="border-t border-border/50 px-4 py-2 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
          <span className="text-xs text-muted-foreground">Soyunci is researching — view full package in Approved Queue once approved</span>
        </div>
      )}
      {isFailed && pkg?.processingError && (
        <div className="border-t border-border/50 px-4 py-2">
          <p className="text-xs text-red-400">Pipeline failed: {pkg.processingError}</p>
        </div>
      )}

      {/* Research preview — shown when research package is available */}
      {(() => {
        const hasResearch = !!(pkg?.storySummary || (pkg?.extractedFacts && pkg.extractedFacts !== "[]") || pkg?.researchExtracted);
        if (!hasResearch) return null;

        const extracted: string[] = (() => {
          if (Array.isArray(pkg?.researchExtracted)) return pkg.researchExtracted;
          if (Array.isArray(pkg?.extractedFacts)) return pkg.extractedFacts;
          try { return JSON.parse(pkg?.extractedFacts ?? "[]"); } catch { return []; }
        })();

        const buildResearchCopy = () => {
          const parts: string[] = [];
          parts.push(`STORY: ${story.title}`);
          parts.push(`SOURCE: ${story.sourceUrl ?? ""} (${story.sourceName ?? ""})`);
          parts.push("");
          if (pkg?.storySummary) { parts.push("── STORY SUMMARY ──"); parts.push(pkg.storySummary); parts.push(""); }
          if (extracted.length > 0) {
            parts.push("── EXTRACTED INFORMATION ──");
            extracted.forEach((f: string, i: number) => parts.push(`${i + 1}. ${f}`));
            parts.push("");
          }
          if (pkg?.researchTimeline) { parts.push("── TIMELINE ──"); parts.push(pkg.researchTimeline); parts.push(""); }
          const quotes: Record<string, string[]> = (() => {
            if (pkg?.researchQuotes && typeof pkg.researchQuotes === "object" && !Array.isArray(pkg.researchQuotes)) return pkg.researchQuotes;
            try { return JSON.parse(pkg?.researchQuotes ?? "{}"); } catch { return {}; }
          })();
          const quoteEntries = Object.entries(quotes).filter(([, arr]) => Array.isArray(arr) && (arr as string[]).length > 0);
          if (quoteEntries.length > 0) {
            parts.push("── QUOTES ──");
            quoteEntries.forEach(([source, qs]) => { parts.push(`[${source.toUpperCase()}]`); (qs as string[]).forEach((q: string) => parts.push(`  "${q}"`)); });
            parts.push("");
          }
          if (pkg?.researchContradictions && pkg.researchContradictions !== "None identified") { parts.push("── CONTRADICTIONS ──"); parts.push(pkg.researchContradictions); parts.push(""); }
          if (pkg?.researchMissingInfo && pkg.researchMissingInfo !== "Not assessed") { parts.push("── MISSING INFORMATION ──"); parts.push(pkg.researchMissingInfo); parts.push(""); }
          return parts.join("\n").trim();
        };

        const quotes: Record<string, string[]> = (() => {
          if (pkg?.researchQuotes && typeof pkg.researchQuotes === "object" && !Array.isArray(pkg.researchQuotes)) return pkg.researchQuotes as Record<string, string[]>;
          try { return JSON.parse(pkg?.researchQuotes ?? "{}") as Record<string, string[]>; } catch { return {}; }
        })();
        const quoteEntries = Object.entries(quotes).filter(([, arr]) => Array.isArray(arr) && (arr as string[]).length > 0);
        const totalQuotes = quoteEntries.reduce((sum, [, arr]) => sum + (arr as string[]).length, 0);

        return (
          <div className="border-t border-border/50">
            <div className="px-4 py-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BookOpen className="w-3.5 h-3.5 text-primary/60" />
                <span className="text-xs font-medium text-muted-foreground">Research Package</span>
                {extracted.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/15">{extracted.length} facts</span>
                )}
                {totalQuotes > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">{totalQuotes} quotes</span>
                )}
                {pkg?.sourcesResearched != null && pkg.sourcesResearched > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">{pkg.sourcesResearched} sources</span>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-xs gap-1 text-primary/80 hover:text-primary font-medium"
                onClick={() => { navigator.clipboard.writeText(buildResearchCopy()); toast.success("Research package copied"); }}
                title="Copy complete research package ready to paste into ChatGPT"
              >
                <Copy className="w-3 h-3" />Copy Research
              </Button>
            </div>
            {/* Single unified box: summary + extracted facts + quotes */}
            {(pkg?.storySummary || extracted.length > 0 || quoteEntries.length > 0) && (
              <div className="mx-4 mb-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 space-y-2.5">
                {pkg?.storySummary && (
                  <p className="text-xs text-foreground/80 leading-relaxed">{pkg.storySummary}</p>
                )}
                {(extracted.length > 0 || quoteEntries.length > 0) && pkg?.storySummary && (
                  <div className="border-t border-border/30" />
                )}
                {extracted.length > 0 && (
                  <ul className="space-y-0.5">
                    {extracted.map((fact: string, i: number) => (
                      <li key={i} className="flex gap-2 text-xs text-foreground/75 leading-relaxed">
                        <span className="text-muted-foreground shrink-0 tabular-nums w-4">{i + 1}.</span>
                        <span>{fact}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {quoteEntries.length > 0 && extracted.length > 0 && (
                  <div className="border-t border-border/30" />
                )}
                {quoteEntries.length > 0 && (
                  <div className="space-y-1.5">
                    {quoteEntries.map(([source, qs]) => (
                      <div key={source}>
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{source}</span>
                        <ul className="mt-0.5 space-y-0.5">
                          {(qs as string[]).map((q: string, qi: number) => (
                            <li key={qi} className="text-xs text-foreground/75 leading-relaxed pl-2 border-l-2 border-amber-500/40 italic">"{q}"</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export default function Dashboard() {
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [completedOnly, setCompletedOnly] = useState(false);
  // Default to pending-only so approved/rejected stories never reappear on the dashboard.
  // Toggle showHistory to browse all past stories.
  const [showHistory, setShowHistory] = useState(false);
  const [sortBy, setSortBy] = useState<"top_scored" | "newest">("top_scored");
  const [processingIds, setProcessingIds] = useState<Set<number>>(new Set());
  const [showLearningPanel, setShowLearningPanel] = useState(false);
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
    ...(filterStatus !== "all" ? { statusLabel: filterStatus } : {}),
    ...(completedOnly ? { completedOnly: true } : {}),
    // When not showing history, only fetch pending/edited stories
    ...(!showHistory ? { approvalStatus: "pending" } : {}),
    sortBy,
  };

  const { data, isLoading } = trpc.stories.list.useQuery(queryInput);

  const approve = trpc.stories.approve.useMutation({
    onSuccess: () => {
      toast.success("Story approved");
      utils.stories.list.invalidate();
    },
  });

  const reject = trpc.stories.reject.useMutation({
    onSuccess: () => {
      toast.success("Story rejected");
      utils.stories.list.invalidate();
      utils.stories.pendingCount.invalidate();
    },
  });

  const dismiss = trpc.stories.dismiss.useMutation({
    onSuccess: () => {
      toast.success("Story dismissed permanently");
      utils.stories.list.invalidate();
      utils.stories.pendingCount.invalidate();
    },
  });

  const updateArticle = trpc.stories.updateArticle.useMutation({
    onSuccess: () => {
      toast.success("Article updated");
      utils.stories.list.invalidate();
    },
  });

  const retryStory = trpc.stories.retryStory.useMutation({
    onSuccess: (_data: unknown, variables: { storyId: number }) => {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.storyId);
        return next;
      });
      toast.success("Story processed by Soyunci");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { storyId: number }) => {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.storyId);
        return next;
      });
      toast.error(`Processing failed: ${err.message}`);
    },
  });

  const [overridingIds, setOverridingIds] = useState<Set<number>>(new Set());
  const [rewritingIds, setRewritingIds] = useState<Set<number>>(new Set());
  const [reResearchingIds, setReResearchingIds] = useState<Set<number>>(new Set());

  const reResearch = trpc.stories.reResearch.useMutation({
    onSuccess: (_data: unknown, variables: { storyId: number }) => {
      setReResearchingIds((prev) => { const next = new Set(prev); next.delete(variables.storyId); return next; });
      toast.success("Re-research complete — article and headlines updated");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { storyId: number }) => {
      setReResearchingIds((prev) => { const next = new Set(prev); next.delete(variables.storyId); return next; });
      toast.error(`Re-research failed: ${err.message}`);
    },
  });

  const handleReResearch = (storyId: number) => {
    setReResearchingIds((prev) => new Set(prev).add(storyId));
    reResearch.mutate({ storyId });
  };

  const rewriteArticle = trpc.stories.rewriteArticle.useMutation({
    onSuccess: (_data: unknown, variables: { storyId: number }) => {
      setRewritingIds((prev) => { const next = new Set(prev); next.delete(variables.storyId); return next; });
      toast.success("Article rewritten");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { storyId: number }) => {
      setRewritingIds((prev) => { const next = new Set(prev); next.delete(variables.storyId); return next; });
      toast.error(`Rewrite failed: ${err.message}`);
    },
  });

  const handleRewriteArticle = (storyId: number) => {
    setRewritingIds((prev) => new Set(prev).add(storyId));
    rewriteArticle.mutate({ storyId });
  };

  // swappingSlot: Map<storyId, slotIndex> — tracks which slot is currently being swapped
  const [swappingSlots, setSwappingSlots] = useState<Map<number, number>>(new Map());

  const swapImage = trpc.stories.swapImage.useMutation({
    onSuccess: (_data: unknown, variables: { storyId: number; slotIndex: number }) => {
      setSwappingSlots((prev) => {
        const next = new Map(prev);
        next.delete(variables.storyId);
        return next;
      });
      toast.success("Image swapped");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { storyId: number }) => {
      setSwappingSlots((prev) => {
        const next = new Map(prev);
        next.delete(variables.storyId);
        return next;
      });
      toast.error(`Swap failed: ${err.message}`);
    },
  });

  const handleSwapImage = (storyId: number, slotIndex: number) => {
    setSwappingSlots((prev) => new Map(prev).set(storyId, slotIndex));
    swapImage.mutate({ storyId, slotIndex });
  };

  const overrideScore = trpc.stories.overrideScore.useMutation({
    onSuccess: (_data: unknown, variables: { id: number }) => {
      setOverridingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.id);
        return next;
      });
      toast.success("Score override saved");
      utils.stories.list.invalidate();
    },
    onError: (err: { message: string }, variables: { id: number }) => {
      setOverridingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.id);
        return next;
      });
      toast.error(`Override failed: ${err.message}`);
    },
  });

  const handleOverrideScore = (storyId: number, score: number | null, label: string | null) => {
    setOverridingIds((prev) => new Set(prev).add(storyId));
    overrideScore.mutate({
      id: storyId,
      overrideScore: score,
      overrideLabel: label as any,
    });
  };

  const handleProcess = (storyId: number) => {
    setProcessingIds((prev) => new Set(prev).add(storyId));
    retryStory.mutate({ storyId });
  };

  const stories = data || [];
  const counts = {
    must_post: stories.filter((s) => s.story.statusLabel === "must_post").length,
    strong_candidate: stories.filter((s) => s.story.statusLabel === "strong_candidate").length,
    maybe: stories.filter((s) => s.story.statusLabel === "maybe").length,
    reject: stories.filter((s) => s.story.statusLabel === "reject").length,
  };

  return (
    <FlightLayout>
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
              Story Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {stories.length} stories ranked by viral potential
            </p>
          </div>

          {/* Filter */}
          <div className="flex items-center gap-2">
            {/* Sort toggle */}
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              <button
                className={cn(
                  "px-3 h-8 text-xs font-medium transition-colors flex items-center gap-1.5",
                  sortBy === "top_scored"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                )}
                onClick={() => setSortBy("top_scored")}
              >
                <Zap className="w-3 h-3" />Top Scored
              </button>
              <button
                className={cn(
                  "px-3 h-8 text-xs font-medium transition-colors flex items-center gap-1.5 border-l border-border",
                  sortBy === "newest"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                )}
                onClick={() => setSortBy("newest")}
              >
                <Tag className="w-3 h-3" />Newest
              </button>
            </div>
            <Button
              size="sm"
              variant={showHistory ? "default" : "outline"}
              className="text-xs h-8 gap-1.5"
              onClick={() => setShowHistory(!showHistory)}
            >
              <HistoryIcon className="w-3.5 h-3.5" />
              {showHistory ? "Showing All" : "New Only"}
            </Button>
            <Button
              size="sm"
              variant={completedOnly ? "default" : "outline"}
              className="text-xs h-8 gap-1.5"
              onClick={() => setCompletedOnly(!completedOnly)}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {completedOnly ? "Completed Only" : "All Stories"}
            </Button>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-44 text-xs h-8">
                <SelectValue placeholder="Filter by status" />
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

        {/* Score summary bar */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { key: "must_post", label: "Must Post", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
            { key: "strong_candidate", label: "Strong Candidate", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
            { key: "maybe", label: "Maybe", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
            { key: "reject", label: "Reject", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
          ].map(({ key, label, color, bg }) => (
            <button
              key={key}
              className={cn(
                "rounded-xl border p-3 text-left transition-all",
                bg,
                filterStatus === key ? "ring-1 ring-current" : "hover:opacity-80"
              )}
              onClick={() => setFilterStatus(filterStatus === key ? "all" : key)}
            >
              <p className={cn("text-2xl font-bold", color)} style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                {counts[key as keyof typeof counts]}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
            </button>
          ))}
        </div>

        {/* Learning Status Panel */}
        {insights && (
          <div className="mb-5 rounded-xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-violet-300 hover:bg-violet-500/10 transition-colors"
              onClick={() => setShowLearningPanel(!showLearningPanel)}
            >
              <span className="flex items-center gap-2">
                <Brain className="w-4 h-4" />
                AI Learning Status
                {insights.lastLearnedAt && (
                  <span className="text-xs text-muted-foreground font-normal">
                    Last updated {new Date(insights.lastLearnedAt).toLocaleDateString()} · {insights.lastLearnedExamplesCount ?? 0} examples
                  </span>
                )}
                {!insights.lastLearnedAt && (
                  <span className="text-xs text-muted-foreground font-normal">No learning data yet — override scores to train</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 border-violet-500/30 text-violet-300 hover:bg-violet-500/10"
                  disabled={learnMutation.isPending}
                  onClick={(e) => { e.stopPropagation(); learnMutation.mutate(); }}
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

        {/* Story cards */}
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
          <div className="space-y-3">
            {stories.map(({ story, package: pkg }, index) => (
              <StoryCard
                key={story.id}
                rank={index + 1}
                story={story}
                pkg={pkg}
                isProcessing={processingIds.has(story.id)}
                isSavingOverride={overridingIds.has(story.id)}
                onApprove={(variant) => approve.mutate({ id: story.id, usedHeadlineVariant: variant })}
                onReject={() => reject.mutate({ id: story.id })}
                onDismiss={() => dismiss.mutate({ id: story.id })}
                onProcess={() => handleProcess(story.id)}
                onOverrideScore={(score, label) => handleOverrideScore(story.id, score, label)}
              />
            ))}
          </div>
        )}
      </div>
    </FlightLayout>
  );
}
