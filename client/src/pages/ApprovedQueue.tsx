import FlightLayout from "@/components/FlightLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Copy, Download, ExternalLink, Hash, RotateCcw, FileText,
  Newspaper, Image, Palette, ChevronDown, ChevronRight, ChevronLeft,
  Loader2, Inbox, Pencil, Check, X, ThumbsUp, ThumbsDown,
  Sparkles, BookOpen, Star, RefreshCw, ClipboardList, Search,
  FlaskConical, ImageIcon, ZoomIn, Upload, Grid3X3,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

/** Return the best URL to load an image in the browser.
 * Wikimedia/Commons images load fine directly in the browser (no CORS block).
 * Only proxy Pexels and other sources that require server-side auth headers.
 */
function ensureProxied(url: string | undefined | null): string {
  if (!url) return "";
  // Already a relative path or already proxied — leave as-is
  if (url.startsWith("/")) return url;
  // Wikimedia images load directly in the browser — no proxy needed
  if (/upload\.wikimedia\.org|commons\.wikimedia\.org/i.test(url)) return url;
  // Pexels and other external sources need the server proxy
  if (/^https?:\/\//i.test(url)) return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  return url;
}

function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

function formatDate(d: Date | string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function buildArticleWithHashtags(pkg: any): string {
  const article = pkg?.soyunciArticle ?? "";
  const tags: string[] = Array.isArray(pkg?.hashtags)
    ? pkg.hashtags
    : (() => { try { return JSON.parse(pkg?.hashtags ?? "[]"); } catch { return []; } })();
  if (tags.length === 0) return article;
  return `${article}\n\n${tags.join(" ")}`;
}

function buildCopyAll(story: any, pkg: any): string {
  const parts: string[] = [];
  if (pkg?.selectedHeadline) parts.push(`HEADLINE:\n${pkg.selectedHeadline}`);
  const articleWithTags = buildArticleWithHashtags(pkg);
  if (articleWithTags) parts.push(`ARTICLE:\n${articleWithTags}`);
  return parts.join("\n\n");
}

/** Build the complete research package in clean ChatGPT-ready format */
function buildResearchCopy(story: any, pkg: any): string {
  const parts: string[] = [];
  parts.push(`STORY: ${story.title}`);
  parts.push(`SOURCE: ${story.sourceUrl ?? ""} (${story.sourceName ?? ""})`);
  parts.push("");

  if (pkg?.storySummary) {
    parts.push("── STORY SUMMARY ──");
    parts.push(pkg.storySummary);
    parts.push("");
  }

  const extracted: string[] = (() => {
    if (Array.isArray(pkg?.researchExtracted)) return pkg.researchExtracted;
    if (Array.isArray(pkg?.extractedFacts)) return pkg.extractedFacts;
    try { return JSON.parse(pkg?.extractedFacts ?? "[]"); } catch { return []; }
  })();
  if (extracted.length > 0) {
    parts.push("── EXTRACTED INFORMATION ──");
    extracted.forEach((f: string, i: number) => parts.push(`${i + 1}. ${f}`));
    parts.push("");
  }

  if (pkg?.researchTimeline) {
    parts.push("── TIMELINE ──");
    parts.push(pkg.researchTimeline);
    parts.push("");
  }

  const quotes: Record<string, string[]> = (() => {
    if (pkg?.researchQuotes && typeof pkg.researchQuotes === "object" && !Array.isArray(pkg.researchQuotes)) return pkg.researchQuotes;
    try { return JSON.parse(pkg?.researchQuotes ?? "{}"); } catch { return {}; }
  })();
  const quoteEntries = Object.entries(quotes).filter(([, arr]) => Array.isArray(arr) && arr.length > 0);
  if (quoteEntries.length > 0) {
    parts.push("── QUOTES ──");
    quoteEntries.forEach(([source, qs]) => {
      parts.push(`[${source.toUpperCase()}]`);
      (qs as string[]).forEach((q: string) => parts.push(`  "${q}"`));
    });
    parts.push("");
  }

  const sources: Array<{ name: string; url?: string; type: string }> = (() => {
    if (Array.isArray(pkg?.researchSources)) return pkg.researchSources;
    try { return JSON.parse(pkg?.researchSources ?? "[]"); } catch { return []; }
  })();
  if (sources.length > 0) {
    parts.push("── SOURCES ──");
    sources.forEach((s: any) => parts.push(`${s.type?.toUpperCase() ?? "SOURCE"}: ${s.name}${s.url ? " — " + s.url : ""}`));
    parts.push("");
  }

  if (pkg?.researchContradictions && pkg.researchContradictions !== "None identified") {
    parts.push("── CONTRADICTIONS ──");
    parts.push(pkg.researchContradictions);
    parts.push("");
  }

  if (pkg?.researchMissingInfo && pkg.researchMissingInfo !== "Not assessed") {
    parts.push("── MISSING INFORMATION ──");
    parts.push(pkg.researchMissingInfo);
    parts.push("");
  }

  return parts.join("\n").trim();
}

function exportToCSV(items: { story: any; package: any }[]) {
  const headers = ["Title","Source","Score","Category","Selected Headline","Article","Hashtags","Canva Headline","Canva Visual Idea","Approved Date","Source URL"];
  const rows = items.map(({ story, package: pkg }) => [
    story.title ?? "", story.sourceName ?? "", story.overrideScore ?? story.viralScore ?? "",
    story.category ?? "", pkg?.selectedHeadline ?? "", (pkg?.soyunciArticle ?? "").replace(/\n/g, " "),
    (pkg?.hashtags ?? []).join(" "), pkg?.canvaHeadline ?? "", pkg?.canvaVisualIdea ?? "",
    formatDate(story.updatedAt), story.sourceUrl ?? "",
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `flightdrama-approved-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success("CSV exported");
}

const RATINGS = [
  { value: "amazing", label: "Amazing", icon: Star, color: "text-yellow-400" },
  { value: "good", label: "Good", icon: ThumbsUp, color: "text-green-400" },
  { value: "ok", label: "OK", icon: Check, color: "text-blue-400" },
  { value: "bad", label: "Bad", icon: ThumbsDown, color: "text-red-400" },
] as const;

function FeedbackBar({ storyId, currentRating, currentNote }: { storyId: number; currentRating?: string | null; currentNote?: string | null }) {
  const utils = trpc.useUtils();
  const [note, setNote] = useState(currentNote ?? "");
  const [showNote, setShowNote] = useState(false);
  const saveFeedback = trpc.stories.saveSoyunciFeedback.useMutation({
    onSuccess: () => { toast.success("Feedback saved — Soyunci will learn from this"); utils.stories.list.invalidate(); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const handleRate = (rating: string) => {
    saveFeedback.mutate({ storyId, rating: rating as any, note: note || undefined });
    setShowNote(true);
  };

  return (
    <div className="border-t border-border/50 px-4 py-3 bg-muted/10">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" />Rate this output:
        </span>
        {RATINGS.map(({ value, label, icon: Icon, color }) => (
          <button
            key={value}
            onClick={() => handleRate(value)}
            disabled={saveFeedback.isPending}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
              currentRating === value
                ? "border-primary bg-primary/10 text-primary"
                : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            <Icon className={cn("w-3 h-3", currentRating === value ? "text-primary" : color)} />
            {label}
          </button>
        ))}
        {currentRating && (
          <button onClick={() => setShowNote(v => !v)} className="text-xs text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1">
            <Pencil className="w-3 h-3" />{currentNote ? "Edit note" : "Add note"}
          </button>
        )}
      </div>
      {showNote && (
        <div className="mt-2 flex gap-2">
          <input
            className="flex-1 bg-muted/30 border border-border/50 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="What did you like or dislike? (optional)"
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && currentRating) { saveFeedback.mutate({ storyId, rating: currentRating as any, note: note || undefined }); setShowNote(false); }
            }}
          />
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { if (currentRating) saveFeedback.mutate({ storyId, rating: currentRating as any, note: note || undefined }); setShowNote(false); }}>Save</Button>
        </div>
      )}
    </div>
  );
}

function ProcessingState({ storyId }: { storyId: number }) {
  const utils = trpc.useUtils();
  useEffect(() => {
    const id = setInterval(() => { utils.stories.list.invalidate(); }, 5000);
    return () => clearInterval(id);
  }, [utils]);

  return (
    <div className="flex flex-col items-center justify-center py-8 gap-3">
      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
        <Sparkles className="w-5 h-5 text-primary animate-pulse" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Soyunci is researching &amp; writing</p>
        <p className="text-xs text-muted-foreground mt-0.5">Deep research → angle detection → article → headlines → images</p>
      </div>
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
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
  // Reset load/error state whenever the URL changes so stale errored state
  // doesn't permanently hide a valid image after tab switches or URL updates.
  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [thumbUrl]);
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
          src={ensureProxied(thumbUrl)}
          alt={description}
          referrerPolicy="no-referrer"
          crossOrigin="anonymous"
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

// ── GridTile — lazy-loading image card for the grid browser ─────────────────
// Uses IntersectionObserver so images only load when scrolled into view.
// Broken images are hidden gracefully (no broken-image icon cluttering the grid).
interface GridTileProps {
  url: string;
  title: string;
  attribution?: string;
  licence?: string;
  pageUrl?: string;
  selected?: boolean;
  onSelect: () => void;
  onUse: () => void;
  isSaving?: boolean;
  source?: "wikimedia" | "pexels";
}

function GridTile({ url, title, attribution, licence, pageUrl, selected, onSelect, onUse, isSaving, source, batchDelay = 0, fullResUrl }: GridTileProps & { batchDelay?: number; fullResUrl?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const [active, setActive] = useState(batchDelay === 0); // Start immediately if no delay
  const prevUrl = useRef<string | null>(null);

  // Staggered activation — wait batchDelay ms before starting the image request
  useEffect(() => {
    if (batchDelay === 0) { setActive(true); return; }
    const t = setTimeout(() => setActive(true), batchDelay);
    return () => clearTimeout(t);
  }, [batchDelay]);

  // Reset state when URL changes
  useEffect(() => {
    if (prevUrl.current !== url) {
      prevUrl.current = url;
      setLoaded(false);
      setErrored(false);
      setActive(batchDelay === 0);
      if (batchDelay > 0) {
        const t = setTimeout(() => setActive(true), batchDelay);
        return () => clearTimeout(t);
      }
    }
  }, [url, batchDelay]);

  return (
    <div
      onClick={onSelect}
      className={cn(
        "group relative rounded-lg overflow-hidden cursor-pointer bg-muted/30 transition-all duration-150",
        "hover:ring-2 hover:ring-primary/60 hover:ring-offset-1 hover:ring-offset-background",
        selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        errored && "opacity-40 cursor-not-allowed"
      )}
      style={{ aspectRatio: "4/3" }}
    >
      {/* Skeleton shimmer while loading */}
      {!loaded && !errored && (
        <div className="absolute inset-0 bg-muted/50 animate-pulse" />
      )}

      {/* Image — only rendered after batchDelay to stagger proxy requests */}
      {!errored && active && (
        <img
          src={useFallback && fullResUrl ? ensureProxied(fullResUrl) : ensureProxied(url)}
          alt={title}
          referrerPolicy="no-referrer"
          className={cn(
            "absolute inset-0 w-full h-full object-cover transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (!useFallback && fullResUrl && fullResUrl !== url) {
              // Try full-res URL as fallback
              setUseFallback(true);
              setLoaded(false);
            } else {
              setErrored(true);
            }
          }}
        />
      )}

      {/* No-preview placeholder for permanently errored tiles */}
      {errored && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground/40">
          <ImageIcon className="w-6 h-6" />
          <span className="text-[9px]">No preview</span>
        </div>
      )}

      {/* Hover overlay — title + attribution + Use button */}
      <div className={cn(
        "absolute inset-0 flex flex-col justify-end p-2 bg-gradient-to-t from-black/80 via-black/20 to-transparent",
        "opacity-0 group-hover:opacity-100 transition-opacity duration-150",
        selected && "opacity-100"
      )}>
        <p className="text-[10px] text-white/90 font-medium leading-tight line-clamp-2 mb-1">{title}</p>
        {attribution && <p className="text-[9px] text-white/60 leading-tight truncate">© {attribution}</p>}
        <div className="flex items-center gap-1.5 mt-1.5">
          {licence && (
            <span className="text-[8px] bg-white/10 text-white/70 px-1 py-0.5 rounded">{licence}</span>
          )}
          {pageUrl && (
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[8px] text-blue-300/80 hover:text-blue-200 ml-auto"
            >
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
        <Button
          size="sm"
          className="mt-1.5 h-6 text-[10px] gap-1 w-full"
          onClick={(e) => { e.stopPropagation(); onUse(); }}
          disabled={isSaving}
        >
          {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Use this
        </Button>
      </div>

      {/* Selected badge */}
      {selected && (
        <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
          <Check className="w-3 h-3 text-primary-foreground" />
        </div>
      )}
    </div>
  );
}

// ── WikimediaSearchModal — grid layout ───────────────────────────────────────
interface WikimediaSearchModalProps {
  open: boolean;
  onClose: () => void;
  initialQuery: string;
  storyId: number;
  slotIndex: number;
  slotRole: string;
}

function WikimediaSearchModal({ open, onClose, initialQuery, storyId, slotIndex, slotRole }: WikimediaSearchModalProps) {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [allResults, setAllResults] = useState<any[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const CHIPS = slotRole === "aircraft"
    ? ["Boeing 737", "Airbus A320", "Boeing 777", "Airbus A380", "Boeing 787", "Airbus A350", "Boeing 757", "Airbus A220"]
    : ["Airport terminal", "Runway", "Air traffic control", "Aircraft cockpit", "Baggage claim"];

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setSubmittedQuery(initialQuery);
      setSelectedIdx(null);
      setOffset(0);
      setAllResults([]);
    }
  }, [open, initialQuery]);

  // Track which query the current pageResults belong to — prevents stale results
  // from a previous query overwriting the cleared state when submittedQuery changes.
  const lastFetchedQuery = useRef(initialQuery);
  const lastFetchedOffset = useRef(0);

  const { data: pageResults = [], isFetching, isError } = trpc.wikimediaSearch.useQuery(
    { query: submittedQuery, limit: 40, offset },
    { enabled: open && submittedQuery.trim().length > 0, refetchOnWindowFocus: false, refetchOnReconnect: false }
  );

  // Accumulate results — only apply when results belong to the current query+offset
  useEffect(() => {
    if (isFetching) return; // Wait until settled
    if (lastFetchedQuery.current !== submittedQuery) return; // Stale result from old query
    if (lastFetchedOffset.current !== offset) return; // Stale result from old offset
    if (offset === 0) {
      setAllResults(pageResults);
    } else if (pageResults.length > 0) {
      setAllResults(prev => [...prev, ...pageResults]);
    }
  }, [pageResults, isFetching, submittedQuery, offset]);

  const results = allResults;

  useEffect(() => {
    // Reset state and record the new query being fetched
    setSelectedIdx(null);
    setOffset(0);
    setAllResults([]);
    lastFetchedQuery.current = submittedQuery;
    lastFetchedOffset.current = 0;
  }, [submittedQuery]);

  // Track offset changes too
  useEffect(() => {
    lastFetchedOffset.current = offset;
  }, [offset]);

  const pickImage = trpc.stories.pickWikimediaImage.useMutation({
    onSuccess: () => {
      toast.success("Image replaced — slot updated");
      utils.stories.list.invalidate();
      onClose();
    },
    onError: (e) => toast.error(`Failed to update slot: ${e.message}`),
  });

  const handleSearch = () => { if (query.trim()) setSubmittedQuery(query.trim()); };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") handleSearch(); };

  const handleUse = useCallback((img: typeof results[number]) => {
    pickImage.mutate({
      storyId,
      slotIndex,
      image: {
        thumbUrl: img.thumbUrl,
        url: img.url,
        title: img.title,
        attribution: img.attribution ?? undefined,
        licence: img.licence ?? undefined,
        pageUrl: img.pageUrl ?? undefined,
        description: img.description ?? undefined,
      },
    });
  }, [pickImage, storyId, slotIndex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
      <div className="bg-background border border-border rounded-xl shadow-2xl flex flex-col" style={{ width: "min(900px, 95vw)", height: "90vh" }}>

        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-border/50 shrink-0 flex items-center gap-2">
          <Search className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Browse Wikimedia Commons</span>
          <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", slotRole === "aircraft" ? "border-blue-500/40 text-blue-400" : "border-purple-500/40 text-purple-400")}>
            {slotRole === "aircraft" ? "✈ Aircraft" : "🌍 Context"}
          </Badge>
          {results.length > 0 && !isFetching && (
            <span className="ml-auto text-xs text-muted-foreground">{results.length} photos</span>
          )}
          <button onClick={onClose} className="ml-2 text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Search bar */}
        <div className="px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Delta Airlines, Boeing 737, Airbus A380…"
              className="flex-1 h-9 text-sm"
              autoFocus
            />
            <Button size="sm" className="h-9 px-4 gap-1.5 shrink-0" onClick={handleSearch} disabled={isFetching}>
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </Button>
          </div>
          {/* Quick-search chips */}
          <div className="flex flex-wrap gap-1.5 mt-2 pb-1">
            {CHIPS.map(chip => (
              <button
                key={chip}
                onClick={() => { setQuery(chip); setSubmittedQuery(chip); }}
                className={cn(
                  "text-[11px] px-2.5 py-0.5 rounded-full border transition-colors",
                  submittedQuery === chip
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border/60 text-muted-foreground hover:border-primary/50 hover:text-foreground"
                )}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Grid area — fills all remaining height, scrolls independently */}
        <div className="overflow-y-auto p-4" style={{ flex: "1 1 0", minHeight: 0 }}>

          {isFetching && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="rounded-lg bg-muted/30 animate-pulse" style={{ aspectRatio: "16/9" }} />
              ))}
            </div>
          )}

          {!isFetching && isError && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <p className="text-sm text-destructive">Search failed — check your connection and try again.</p>
            </div>
          )}

          {!isFetching && !isError && results.length === 0 && submittedQuery && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Search className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No photos found for <strong>{submittedQuery}</strong></p>
              <p className="text-xs text-muted-foreground/60">Try just the airline name, or just the aircraft type.</p>
            </div>
          )}

          {results.length > 0 && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {results.map((img, i) => (
                <GridTile
                  key={img.thumbUrl + i}
                  url={img.thumbUrl}
                  fullResUrl={img.url}
                  title={img.title}
                  attribution={img.attribution ?? undefined}
                  licence={img.licence ?? undefined}
                  pageUrl={img.pageUrl ?? undefined}
                  selected={selectedIdx === i}
                  onSelect={() => setSelectedIdx(i)}
                  onUse={() => handleUse(img)}
                  isSaving={pickImage.isPending}
                  source="wikimedia"
                  batchDelay={0}
                />
              ))}
            </div>
          )}

          {/* Load more */}
          {!isFetching && results.length > 0 && pageResults.length === 40 && (
            <div className="flex flex-col items-center gap-1 mt-4 pb-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setOffset(prev => prev + 200)}
              >
                Load more photos
              </Button>
              <span className="text-[10px] text-muted-foreground/50">{results.length} loaded so far</span>
            </div>
          )}

          {isFetching && offset > 0 && (
            <div className="flex justify-center mt-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border/30 flex items-center justify-between shrink-0">
          <p className="text-xs text-muted-foreground">Click any photo to select, then click <strong>Use this</strong></p>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>

      </div>
    </div>
  );
}

// ── PexelsSearchModal — grid layout ──────────────────────────────────────────
interface PexelsSearchModalProps {
  open: boolean;
  onClose: () => void;
  initialQuery: string;
  storyId: number;
  slotIndex: number;
  slotRole: string;
}

function PexelsSearchModal({ open, onClose, initialQuery, storyId, slotIndex, slotRole }: PexelsSearchModalProps) {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQuery(initialQuery); setSubmittedQuery(initialQuery); setSelectedIdx(null); }
  }, [open, initialQuery]);

  const { data: results = [], isFetching, isError } = trpc.pexelsSearch.useQuery(
    { query: submittedQuery, limit: 30 },
    { enabled: open && submittedQuery.trim().length > 0, refetchOnWindowFocus: false, refetchOnReconnect: false }
  );

  useEffect(() => { setSelectedIdx(null); }, [submittedQuery]);

  const pickImage = trpc.stories.pickWikimediaImage.useMutation({
    onSuccess: () => { toast.success("Image replaced — slot updated"); utils.stories.list.invalidate(); onClose(); },
    onError: (e) => toast.error(`Failed to update slot: ${e.message}`),
  });

  const handleSearch = () => { if (query.trim()) setSubmittedQuery(query.trim()); };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") handleSearch(); };

  const handleUse = useCallback((img: typeof results[number]) => {
    pickImage.mutate({
      storyId, slotIndex,
      image: { thumbUrl: img.thumbUrl, url: img.url, title: img.title, attribution: img.attribution, licence: img.licence, pageUrl: img.pageUrl, description: img.description },
    });
  }, [pickImage, storyId, slotIndex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
      <div className="bg-background border border-border rounded-xl shadow-2xl flex flex-col" style={{ width: "min(900px, 95vw)", height: "90vh" }}>

        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-border/50 shrink-0 flex items-center gap-2">
          <span className="text-sm font-semibold text-green-400">Pexels</span>
          <span className="text-sm text-muted-foreground">— slot {slotIndex + 1}</span>
          {results.length > 0 && !isFetching && (
            <span className="ml-auto text-xs text-muted-foreground">{results.length} photos</span>
          )}
          <button onClick={onClose} className="ml-2 text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Search bar */}
        <div className="px-4 py-3 border-b border-border/30 flex gap-2 shrink-0">
          <Input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Search Pexels photos…" className="flex-1 h-9 text-sm" autoFocus />
          <Button size="sm" className="h-9 px-4 gap-1.5 shrink-0" onClick={handleSearch} disabled={isFetching}>
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Search
          </Button>
        </div>

        {/* Grid area */}
        <div className="overflow-y-auto p-4" style={{ flex: "1 1 0", minHeight: 0 }}>

          {isFetching && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="rounded-lg bg-muted/30 animate-pulse" style={{ aspectRatio: "16/9" }} />
              ))}
            </div>
          )}

          {!isFetching && isError && (
            <p className="px-4 py-4 text-sm text-destructive">Search failed. Check your Pexels API key.</p>
          )}

          {!isFetching && results.length === 0 && submittedQuery && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Search className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No results — try a different search term</p>
            </div>
          )}

          {!isFetching && results.length > 0 && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {results.map((img, i) => (
                <GridTile
                  key={img.thumbUrl + i}
                  url={img.thumbUrl}
                  title={img.title}
                  attribution={img.attribution ?? undefined}
                  licence={img.licence ?? undefined}
                  pageUrl={img.pageUrl ?? undefined}
                  selected={selectedIdx === i}
                  onSelect={() => setSelectedIdx(i)}
                  onUse={() => handleUse(img)}
                  isSaving={pickImage.isPending}
                  source="pexels"
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border/30 flex items-center justify-between shrink-0">
          <p className="text-xs text-muted-foreground">Click any photo to select, then click <strong>Use this</strong></p>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>

      </div>
    </div>
  );
}

interface ApprovedCardProps {
  story: any;
  pkg: any;
  onUnapprove: () => void;
  isUnapproving: boolean;
}

function ApprovedCard({ story, pkg, onUnapprove, isUnapproving }: ApprovedCardProps) {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ article: true, images: true });
  const [editingArticle, setEditingArticle] = useState(false);
  const [articleDraft, setArticleDraft] = useState(pkg?.soyunciArticle ?? "");
  const [editingHeadline, setEditingHeadline] = useState(false);
  const [headlineDraft, setHeadlineDraft] = useState(pkg?.selectedHeadline ?? "");
  const toggle = (key: string) => setExpanded(p => ({ ...p, [key]: !p[key] }));

  // Wikimedia browse modal state
  const [wikiModal, setWikiModal] = useState<{ open: boolean; query: string; slotIndex: number; slotRole: string } | null>(null);
  // Pexels browse modal state
  const [pexelModal, setPexelModal] = useState<{ open: boolean; query: string; slotIndex: number; slotRole: string } | null>(null);
  // Image picker panel: which slot is open, current search query
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerSubmitted, setPickerSubmitted] = useState("");
  const pickerFileRef = useRef<HTMLInputElement>(null);

  const uploadCustom = trpc.imageSearch.uploadCustom.useMutation({
    onSuccess: (data) => {
      toast.success("Image uploaded");
      if (pickerSlot !== null) {
        const newRec = {
          description: data.title, source: "Custom upload", licence: "Custom",
          attributionRequired: "No", copyrightRisk: "Low",
          whyItFits: "Manually uploaded image", canvaUse: "Use as hero image",
          imageUrl: data.url, thumbUrl: data.thumbUrl, pageUrl: data.pageUrl,
          attribution: data.attribution, imageSource: "custom",
          role: imageRecs[pickerSlot]?.role ?? "aircraft", title: data.title,
        };
        const newRecs = [...imageRecs];
        newRecs[pickerSlot] = newRec;
        utils.stories.list.setData(
          { approvalStatus: "approved" },
          (old: any) => (old ?? []).map((item: any) =>
            item.story.id === story.id ? { ...item, package: { ...item.package, imageRecommendations: newRecs } } : item
          )
        );
      }
      setPickerSlot(null);
    },
    onError: (e) => toast.error(`Upload failed: ${e.message}`),
  });

  const pickFromSearch = trpc.stories.pickWikimediaImage.useMutation({
    onSuccess: () => { toast.success("Image set"); utils.stories.list.invalidate(); setPickerSlot(null); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, slotIndex: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("File too large — max 10 MB"); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      uploadCustom.mutate({ dataUrl, filename: file.name });
    };
    reader.readAsDataURL(file);
  };

  const updateArticle = trpc.stories.updateArticle.useMutation({
    onSuccess: () => { toast.success("Article saved"); setEditingArticle(false); utils.stories.list.invalidate(); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const regenerate = trpc.stories.regenerateSoyunci.useMutation({
    onSuccess: () => { toast.success("Regenerating — this takes 20–40 seconds"); utils.stories.list.invalidate(); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const regenImages = trpc.stories.regenerateImages.useMutation({
    onSuccess: (data) => { toast.success(`Found ${data.count} photo${data.count === 1 ? "" : "s"} — refreshing`); utils.stories.list.invalidate(); },
    onError: (e) => toast.error(`Image search failed: ${e.message}`),
  });

  const swapImage = trpc.stories.swapImage.useMutation({
    onSuccess: (data) => {
      toast.success(`Swapped — ${data.remainingCandidates} more option${data.remainingCandidates !== 1 ? "s" : ""} available`);
      utils.stories.list.invalidate();
    },
    onError: (e) => toast.error(`Swap failed: ${e.message}`),
  });

  const reResearch = trpc.stories.reResearch.useMutation({
    onSuccess: (data) => {
      toast.success(`Re-research complete — ${data.sourcesResearched} source${data.sourcesResearched !== 1 ? 's' : ''} fetched`);
      utils.stories.list.invalidate();
    },
    onError: (e) => toast.error(`Re-research failed: ${e.message}`),
  });

  const rewriteArticle = trpc.stories.rewriteArticle.useMutation({
    onSuccess: () => { toast.success("Article rewritten"); utils.stories.list.invalidate(); },
    onError: (e) => toast.error(`Rewrite failed: ${e.message}`),
  });

  const hasResearch = !!(pkg?.storySummary || (pkg?.extractedFacts && pkg.extractedFacts !== "[]") || pkg?.researchExtracted);
  const isProcessing = pkg?.processingStatus === "processing" || pkg?.processingStatus === "queued" || (!hasResearch && pkg?.processingStatus !== "failed");
  const isFailed = pkg?.processingStatus === "failed";
  const score = story.overrideScore ?? story.viralScore ?? 0;

  const handleLogPost = () => {
    const params = new URLSearchParams();
    if (pkg?.selectedHeadline) params.set("headline", pkg.selectedHeadline);
    if (story.category) params.set("category", story.category);
    if (pkg?.viralAngle) params.set("viralAngle", pkg.viralAngle);
    if (pkg?.soyunciArticle) params.set("article", pkg.soyunciArticle.slice(0, 500));
    if (story.id) params.set("storyId", String(story.id));
    // Pass all headlines so the user can pick which variant they used
    const allH: string[] = Array.isArray(pkg?.allHeadlines)
      ? pkg.allHeadlines
      : (() => { try { return JSON.parse(pkg?.allHeadlines ?? "[]"); } catch { return []; } })();
    if (allH.length > 0) params.set("allHeadlines", JSON.stringify(allH));
    setLocation(`/historical?${params.toString()}`);
  };

  const imageRecs: any[] = (() => {
    try { return Array.isArray(pkg?.imageRecommendations) ? pkg.imageRecommendations : JSON.parse(pkg?.imageRecommendations ?? "[]"); }
    catch { return []; }
  })();

  const imageCandidatesMap: Record<string, any[]> = (() => {
    if (!pkg?.imageCandidates) return {};
    if (typeof pkg.imageCandidates === "object" && !Array.isArray(pkg.imageCandidates)) return pkg.imageCandidates as Record<string, any[]>;
    try { return JSON.parse(typeof pkg.imageCandidates === "string" ? pkg.imageCandidates : "{}"); }
    catch { return {}; }
  })();

  const altHeadlines: string[] = (() => {
    if (Array.isArray(pkg?.allHeadlines)) return pkg.allHeadlines;
    try { return JSON.parse(pkg?.allHeadlines ?? "[]"); }
    catch { return []; }
  })();

  const hashtags: string[] = (() => {
    if (Array.isArray(pkg?.hashtags)) return pkg.hashtags;
    try { return JSON.parse(pkg?.hashtags ?? "[]"); }
    catch { return typeof pkg?.hashtags === "string" ? pkg.hashtags.split(/\s+/) : []; }
  })();

  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-start gap-3 bg-muted/20">
        <div className="flex flex-col items-center gap-0.5 shrink-0 mt-0.5">
          <span className={cn("text-lg font-bold tabular-nums leading-none", score >= 80 ? "text-green-400" : score >= 60 ? "text-yellow-400" : "text-muted-foreground")}>{score}</span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wide">score</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-snug line-clamp-2">{story.title}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-xs text-muted-foreground">{story.sourceName}</span>
            {story.category && <Badge variant="outline" className="text-[10px] h-4 px-1.5">{story.category}</Badge>}
            {pkg?.sourcesResearched != null && (() => {
              const n = pkg.sourcesResearched;
              const quality = n >= 3 ? 'full' : n >= 1 ? 'partial' : 'rss';
              const colours = {
                full:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                partial: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                rss:     'bg-red-500/10 text-red-400 border-red-500/20',
              }[quality];
              const label = {
                full:    `${n} sources`,
                partial: `${n} source${n !== 1 ? 's' : ''}`,
                rss:     'RSS only',
              }[quality];
              const tip = {
                full:    `Full research: ${n} articles fetched and read`,
                partial: `Partial research: only ${n} source${n !== 1 ? 's' : ''} fetched — consider Re-Research`,
                rss:     'Article scraping failed — written from RSS snippet only. Click Re-Research & Rewrite to retry.',
              }[quality];
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border cursor-default ${colours}`}>
                      <FlaskConical className="w-2.5 h-2.5" />
                      {label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs max-w-[220px]">{tip}</TooltipContent>
                </Tooltip>
              );
            })()}
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
                <TooltipContent side="bottom" className="text-xs max-w-[260px]">
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
            <span className="text-xs text-muted-foreground ml-auto">Approved {formatDate(story.updatedAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {story.sourceUrl && (
            <a href={story.sourceUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="ghost" size="icon" className="h-7 w-7"><ExternalLink className="w-3.5 h-3.5" /></Button>
            </a>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground" onClick={() => regenImages.mutate({ id: story.id })} disabled={regenImages.isPending || isProcessing} title="Refresh photos only">
            <Image className={cn("w-3 h-3", regenImages.isPending && "animate-spin")} />{regenImages.isPending ? "Searching…" : "Photos"}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground" onClick={() => regenerate.mutate({ id: story.id })} disabled={regenerate.isPending || isProcessing}>
            <RefreshCw className={cn("w-3 h-3", regenerate.isPending && "animate-spin")} />Regen
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 text-primary/80 hover:text-primary font-medium"
            onClick={() => { copyText(buildResearchCopy(story, pkg), "Research package"); }}
            disabled={isProcessing || !hasResearch}
            title="Copy complete research package ready to paste into ChatGPT"
          >
            <Copy className="w-3 h-3" />Copy Research
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5 text-primary/80 hover:text-primary" onClick={handleLogPost} disabled={isProcessing} title="Pre-fill Performance Data form with this story">
            <ClipboardList className="w-3 h-3" />Log Post
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-destructive" onClick={onUnapprove} disabled={isUnapproving}>
            {isUnapproving ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}Un-approve
          </Button>
        </div>
      </div>

      {isProcessing && <ProcessingState storyId={story.id} />}
      {isFailed && (
        <div className="px-4 py-4 text-center">
          <p className="text-sm text-destructive mb-2">Soyunci pipeline failed</p>
          {pkg?.processingError && <p className="text-xs text-muted-foreground mb-3">{pkg.processingError}</p>}
          <Button size="sm" variant="outline" onClick={() => regenerate.mutate({ id: story.id })} disabled={regenerate.isPending}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />Retry
          </Button>
        </div>
      )}

      {!isProcessing && !isFailed && hasResearch && (
        <div className="divide-y divide-border/40">
          {/* ── Research Package ── */}
          {/* Story Summary */}
          {pkg?.storySummary && (
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <BookOpen className="w-3 h-3" />Story Summary
              </p>
              <p className="text-sm text-foreground/90 leading-relaxed">{pkg.storySummary}</p>
              {pkg?.sourceConfirmation && (
                <p className="text-xs text-muted-foreground/70 mt-1.5 italic">{pkg.sourceConfirmation}</p>
              )}
            </div>
          )}

          {/* Extracted Information & Quotes — unified collapsible box */}
          {(() => {
            const extracted: string[] = (() => {
              if (Array.isArray(pkg?.researchExtracted)) return pkg.researchExtracted;
              if (Array.isArray(pkg?.extractedFacts)) return pkg.extractedFacts;
              try { return JSON.parse(pkg?.extractedFacts ?? "[]"); } catch { return []; }
            })();
            const quotes: Record<string, string[]> = (() => {
              if (pkg?.researchQuotes && typeof pkg.researchQuotes === "object" && !Array.isArray(pkg.researchQuotes)) return pkg.researchQuotes as Record<string, string[]>;
              try { return JSON.parse(pkg?.researchQuotes ?? "{}") as Record<string, string[]>; } catch { return {}; }
            })();
            const quoteEntries = Object.entries(quotes).filter(([, arr]) => Array.isArray(arr) && (arr as string[]).length > 0);
            const totalQuotes = quoteEntries.reduce((n, [, arr]) => n + (arr as string[]).length, 0);
            if (extracted.length === 0 && quoteEntries.length === 0) return null;
            return (
              <div>
                <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" onClick={() => toggle("extracted")}>
                  <span className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5" />Extracted Info &amp; Quotes
                    {extracted.length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/15">{extracted.length} facts</span>
                    )}
                    {totalQuotes > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">{totalQuotes} quote{totalQuotes !== 1 ? "s" : ""}</span>
                    )}
                  </span>
                  {expanded.extracted ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                {expanded.extracted && (
                  <div className="px-4 pb-3 space-y-3">
                    {extracted.length > 0 && (
                      <ol className="space-y-1">
                        {extracted.map((fact: string, i: number) => (
                          <li key={i} className="flex gap-2 text-sm text-foreground/85 leading-relaxed">
                            <span className="text-muted-foreground shrink-0 tabular-nums text-xs mt-0.5 w-5">{i + 1}.</span>
                            <span>{fact}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {extracted.length > 0 && quoteEntries.length > 0 && (
                      <div className="border-t border-border/30" />
                    )}
                    {quoteEntries.length > 0 && (
                      <div className="space-y-3">
                        {quoteEntries.map(([source, qs]) => (
                          <div key={source}>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{source}</p>
                            {(qs as string[]).map((q: string, i: number) => (
                              <blockquote key={i} className="border-l-2 border-amber-500/40 pl-3 py-0.5 text-sm text-foreground/80 italic leading-relaxed mb-1">"{q}"</blockquote>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Timeline */}
          {pkg?.researchTimeline && (
            <div>
              <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" onClick={() => toggle("timeline")}>
                <span className="flex items-center gap-2"><Hash className="w-3.5 h-3.5" />Timeline</span>
                {expanded.timeline ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {expanded.timeline && (
                <div className="px-4 pb-3">
                  <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">{pkg.researchTimeline}</p>
                </div>
              )}
            </div>
          )}

          {/* Sources */}
          {(() => {
            const sources: Array<{ name: string; url?: string; type: string }> = (() => {
              if (Array.isArray(pkg?.researchSources)) return pkg.researchSources;
              try { return JSON.parse(pkg?.researchSources ?? "[]"); } catch { return []; }
            })();
            if (sources.length === 0) return null;
            return (
              <div>
                <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" onClick={() => toggle("sources")}>
                  <span className="flex items-center gap-2">
                    <FlaskConical className="w-3.5 h-3.5" />Sources
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">{sources.length} source{sources.length !== 1 ? "s" : ""}</span>
                  </span>
                  {expanded.sources ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                {expanded.sources && (
                  <div className="px-4 pb-3 space-y-1">
                    {sources.map((s: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${
                          s.type === "primary" ? "bg-emerald-500/10 text-emerald-400" :
                          s.type === "official" ? "bg-blue-500/10 text-blue-400" :
                          "bg-muted/50 text-muted-foreground"
                        }`}>{s.type ?? "source"}</span>
                        {s.url ? (
                          <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-foreground/80 hover:text-primary hover:underline flex items-center gap-1">
                            {s.name} <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        ) : (
                          <span className="text-foreground/80">{s.name}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Contradictions */}
          {pkg?.researchContradictions && pkg.researchContradictions !== "None identified" && (
            <div>
              <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-amber-400/80 hover:text-amber-400 transition-colors" onClick={() => toggle("contradictions")}>
                <span className="flex items-center gap-2"><span className="text-sm">⚠</span>Contradictions</span>
                {expanded.contradictions ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {expanded.contradictions && (
                <div className="px-4 pb-3">
                  <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">{pkg.researchContradictions}</p>
                </div>
              )}
            </div>
          )}

          {/* Missing Information */}
          {pkg?.researchMissingInfo && pkg.researchMissingInfo !== "Not assessed" && (
            <div>
              <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" onClick={() => toggle("missing")}>
                <span className="flex items-center gap-2"><span className="text-sm">?</span>Missing Information</span>
                {expanded.missing ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {expanded.missing && (
                <div className="px-4 pb-3">
                  <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">{pkg.researchMissingInfo}</p>
                </div>
              )}
            </div>
          )}

          {/* Image recs — skeleton shown while image regeneration is in progress */}
          {regenImages.isPending && (
            <div className="border-t border-border/40 px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Image className="w-3.5 h-3.5 text-primary/50 animate-pulse" />
                <span className="text-xs text-muted-foreground/60">Searching for photos…</span>
              </div>
              <Skeleton className="w-full rounded-lg" style={{aspectRatio:'16/9'}} />
              <div className="flex gap-2 mt-2">
                <Skeleton className="h-3 w-2/3 rounded" />
                <Skeleton className="h-3 w-1/4 rounded ml-auto" />
              </div>
            </div>
          )}

          {/* Image recs */}
          {imageRecs.length > 0 && !regenImages.isPending && (
            <div>
              <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" onClick={() => toggle("images")}>
                <span className="flex items-center gap-2"><Image className="w-3.5 h-3.5" />Images ({imageRecs.filter((r: any) => r.imageUrl || r.thumbUrl).length} photo{imageRecs.filter((r: any) => r.imageUrl || r.thumbUrl).length !== 1 ? 's' : ''})</span>
                {expanded.images ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {expanded.images && (
                <div className="px-4 pb-3 space-y-4">
                  {imageRecs.map((img: any, i: number) => {
                    const isTextRec = img.imageSource === "text-rec" || (!img.imageUrl && !img.thumbUrl);
                    const browseQuery = img.searchQuery ?? img.title ?? story.title ?? "";

                    return (
                    <div key={i} className="rounded-lg overflow-hidden text-xs bg-muted/20 border border-border/30">

                      {/* ── Slot header ── */}
                      <div className="px-3 pt-2.5 pb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          {img.role && (
                            <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", img.role === "aircraft" ? "border-blue-500/40 text-blue-400" : "border-purple-500/40 text-purple-400")}>
                              {img.role === "aircraft" ? "✈ Aircraft" : "🌍 Context"}
                            </Badge>
                          )}
                          <span className="text-muted-foreground/60 text-[10px]">{img.source}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {/* Slot 0 (aircraft) → Wikimedia only; Slot 1+ (context) → Pexels only */}
                          {i === 0 ? (
                            <Button size="sm" variant="ghost"
                              className="h-6 text-[10px] gap-1 px-2 text-blue-400 hover:text-blue-300"
                              onClick={() => setWikiModal({ open: true, query: browseQuery, slotIndex: i, slotRole: "aircraft" })}
                            >
                              <ExternalLink className="w-3 h-3" /> Browse Wikimedia
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost"
                              className="h-6 text-[10px] gap-1 px-2 text-green-400 hover:text-green-300"
                              onClick={() => setPexelModal({ open: true, query: browseQuery, slotIndex: i, slotRole: "context" })}
                            >
                              <Search className="w-3 h-3" /> Browse Pexels
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* ── Current selected image ── */}
                      {!isTextRec && img.thumbUrl && (
                        <HeroImageSlot
                          key={img.thumbUrl}
                          thumbUrl={img.thumbUrl}
                          description={img.description ?? img.title ?? ""}
                          isAiGenerated={img.imageSource === "ai-generated"}
                          aiPrompt={img.aiPrompt}
                        />
                      )}
                      {isTextRec && (
                        <div className="mx-3 mb-2 rounded-md bg-background/70 border border-border/50 px-3 py-2">
                          <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-1 font-semibold">Suggested search</p>
                          <p className="text-sm font-bold text-foreground leading-snug">{browseQuery}</p>
                        </div>
                      )}

                      {/* ── Image attribution ── */}
                      {!isTextRec && img.title && (
                        <div className="mx-3 mt-1 mb-1.5">
                          <p className="text-[10px] text-muted-foreground/60 leading-snug line-clamp-1">{img.title}</p>
                          {img.attribution && <p className="text-[10px] text-muted-foreground/40">© {img.attribution}</p>}
                        </div>
                      )}



                    </div>
                    );
                  })}

                </div>
              )}
            </div>
          )}

          {/* Canva brief */}
          {pkg?.canvaHeadline && (
            <div>
              <button className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" onClick={() => toggle("canva")}>
                <span className="flex items-center gap-2"><Palette className="w-3.5 h-3.5" />Canva Brief</span>
                {expanded.canva ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {expanded.canva && (
                <div className="px-4 pb-3">
                  <div className="bg-muted/30 rounded-lg p-3 space-y-1.5 text-xs">
                    {[["Headline",pkg.canvaHeadline],["Aspect Ratio",pkg.canvaAspectRatio],["Visual Idea",pkg.canvaVisualIdea],["Aircraft",pkg.canvaAircraftToShow],["Mood",pkg.canvaMood],["Background",pkg.canvaBackground],["Hierarchy",pkg.canvaHierarchy],["Circle Insert",pkg.canvaCircleInsert]]
                      .filter(([,v]) => v).map(([label, value]) => (
                        <div key={label} className="flex gap-2">
                          <span className="text-muted-foreground w-24 shrink-0">{label}</span>
                          <span className="text-foreground/80">{value}</span>
                        </div>
                      ))}
                  </div>
                  <Button size="sm" variant="ghost" className="h-6 text-xs gap-1 mt-2" onClick={() => {
                    const brief = [["Headline",pkg.canvaHeadline],["Aspect Ratio",pkg.canvaAspectRatio],["Visual Idea",pkg.canvaVisualIdea],["Aircraft",pkg.canvaAircraftToShow],["Mood",pkg.canvaMood],["Background",pkg.canvaBackground],["Hierarchy",pkg.canvaHierarchy],["Circle Insert",pkg.canvaCircleInsert]]
                      .filter(([,v]) => v).map(([l,v]) => `${l}: ${v}`).join("\n");
                    copyText(brief, "Canva brief");
                  }}><Copy className="w-3 h-3" />Copy brief</Button>
                </div>
              )}
            </div>
          )}

          {/* Pipeline progress bar — shown while processing or after completion */}
          {(isProcessing || isFailed || hasResearch) && (() => {
            const steps = [
              { label: "Research",  done: !!(pkg?.researchContext) },
              { label: "Summary",   done: !!(pkg?.storySummary) },
              { label: "Facts",     done: !!(pkg?.extractedFacts && pkg.extractedFacts !== "[]") },
              { label: "Timeline",  done: !!(pkg?.researchTimeline) },
              { label: "Quotes",    done: !!(pkg?.researchQuotes && pkg.researchQuotes !== "{}") },
              { label: "Images",    done: !!(pkg?.imageRecommendations && (Array.isArray(pkg.imageRecommendations) ? pkg.imageRecommendations : JSON.parse(pkg.imageRecommendations ?? "[]")).length > 0) },
            ];
            const doneCount = steps.filter(s => s.done).length;
            return (
              <div className="px-4 py-2.5 border-b border-border/40">
                <div className="flex items-center gap-2 mb-1.5">
                  {isProcessing && <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />}
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    {isProcessing ? `Pipeline running — ${doneCount}/6 steps` : isFailed ? "Pipeline failed" : `Research complete — ${doneCount}/6 steps`}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {steps.map((step, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                      <div className={cn(
                        "h-1 w-full rounded-full transition-colors",
                        step.done ? (isFailed ? "bg-red-500/60" : "bg-primary") : isProcessing && i === doneCount ? "bg-primary/40 animate-pulse" : "bg-muted"
                      )} />
                      <span className={cn("text-[9px] leading-none", step.done ? "text-foreground/60" : "text-muted-foreground/40")}>{step.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Re-Research button — always available on complete cards */}
          {!isProcessing && !isFailed && (
            <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                className="text-xs gap-1.5 border-sky-500/30 text-sky-400 hover:bg-sky-500/10"
                onClick={() => reResearch.mutate({ storyId: story.id })}
                disabled={reResearch.isPending}
                title="Re-run research pipeline — images are NOT regenerated"
              >
                {reResearch.isPending ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Re-researching...</>
                ) : (
                  <><FlaskConical className="w-3 h-3" /> Re-Research</>
                )}
              </Button>
              {pkg?.sourcesResearched != null && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  {pkg.sourcesResearched} source{pkg.sourcesResearched !== 1 ? "s" : ""} fetched
                </span>
              )}
              <span className="text-[10px] text-muted-foreground italic">Images are preserved</span>
            </div>
          )}
        </div>
      )}

      {!isProcessing && !isFailed && hasResearch && (
        <FeedbackBar storyId={story.id} currentRating={pkg?.soyunciRating} currentNote={pkg?.soyunciFeedbackNote} />
      )}

      {/* Wikimedia image browser modal */}
      {wikiModal && (
        <WikimediaSearchModal
          open={wikiModal.open}
          onClose={() => setWikiModal(null)}
          initialQuery={wikiModal.query}
          storyId={story.id}
          slotIndex={wikiModal.slotIndex}
          slotRole={wikiModal.slotRole}
        />
      )}
      {/* Pexels image browser modal */}
      {pexelModal && (
        <PexelsSearchModal
          open={pexelModal.open}
          onClose={() => setPexelModal(null)}
          initialQuery={pexelModal.query}
          storyId={story.id}
          slotIndex={pexelModal.slotIndex}
          slotRole={pexelModal.slotRole}
        />
      )}
    </div>
  );
}

export default function ApprovedQueue() {
  const utils = trpc.useUtils();
  const { data: items = [], isLoading } = trpc.stories.list.useQuery({ approvalStatus: "approved" });
  const [unapprovingId, setUnapprovingId] = useState<number | null>(null);
  const unapprove = trpc.stories.unapprove.useMutation({
    onMutate: async ({ id }) => {
      // Optimistically remove the card immediately
      await utils.stories.list.cancel();
      const prev = utils.stories.list.getData({ approvalStatus: "approved" });
      utils.stories.list.setData(
        { approvalStatus: "approved" },
        (old: any) => (old ?? []).filter((item: any) => item.story.id !== id)
      );
      return { prev };
    },
    onSuccess: () => {
      toast.success("Story moved back to pending");
      // Refetch both lists and the pending count badge
      utils.stories.list.invalidate();
      utils.stories.pendingCount.invalidate();
      setUnapprovingId(null);
    },
    onError: (e, _vars, ctx: any) => {
      // Rollback optimistic update on error
      if (ctx?.prev) utils.stories.list.setData({ approvalStatus: "approved" }, ctx.prev);
      toast.error(`Failed: ${e.message}`);
      setUnapprovingId(null);
    },
  });
  const handleUnapprove = (id: number) => { setUnapprovingId(id); unapprove.mutate({ id }); };

  return (
    <FlightLayout>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>Approved Queue</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{items.length} {items.length === 1 ? "story" : "stories"} ready to post</p>
          </div>
          {items.length > 0 && (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => exportToCSV(items as any)}>
              <Download className="w-4 h-4" />Export CSV
            </Button>
          )}
        </div>
        <Separator className="mb-6" />
        {isLoading && <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}
        {!isLoading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4"><Inbox className="w-8 h-8 text-muted-foreground" /></div>
            <h3 className="text-lg font-semibold text-foreground mb-1">No approved stories yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm">Approve stories from the Dashboard and Soyunci will automatically research and write the full content package.</p>
          </div>
        )}
        <div className="space-y-4">
          {(items as any[]).map(({ story, package: pkg }: any) => (
            <ApprovedCard key={story.id} story={story} pkg={pkg} onUnapprove={() => handleUnapprove(story.id)} isUnapproving={unapprovingId === story.id && unapprove.isPending} />
          ))}
        </div>
      </div>
    </FlightLayout>
  );
}
