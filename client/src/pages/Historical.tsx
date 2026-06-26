import { useState, useEffect } from "react";
import FlightLayout from "@/components/FlightLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Plus, Loader2, TrendingUp, Eye, Heart, MessageCircle, Share2,
  DollarSign, Users, Brain, RefreshCw, ChevronDown, ChevronUp,
  Zap, Target, PenLine, Lightbulb, Upload, CheckCircle2, X, Instagram,
  ChevronRight, Clock, ArrowLeft, Download
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface FormData {
  headline: string;
  article: string;
  category: string;
  postingTime: string;
  views: string;
  likes: string;
  comments: string;
  shares: string;
  saves: string;
  followersGained: string;
  revenue: string;
  netFollows: string;
  platform: string;
  airline: string;
  imageType: string;
  sourceType: string;
  aircraftType: string;
  storyType: string;
  viralAngle: string;
  selectedHeadline: string;
  usedHeadlineVariant: string;
}

const emptyForm: FormData = {
  headline: "",
  article: "",
  category: "",
  postingTime: "",
  views: "",
  likes: "",
  comments: "",
  shares: "",
  saves: "",
  followersGained: "",
  revenue: "",
  netFollows: "",
  platform: "",
  airline: "",
  imageType: "",
  sourceType: "",
  aircraftType: "",
  storyType: "",
  viralAngle: "",
  selectedHeadline: "",
  usedHeadlineVariant: "",
};

/** Parse smart number strings: "8.5k" → 8500, "2m" → 2000000, "450k" → 450000 */
function parseSmartNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const s = raw.replace(/,/g, "").toLowerCase().trim();
  if (s.endsWith("k")) return Math.round(parseFloat(s) * 1_000);
  if (s.endsWith("m")) return Math.round(parseFloat(s) * 1_000_000);
  if (s.endsWith("b")) return Math.round(parseFloat(s) * 1_000_000_000);
  const n = parseFloat(s);
  return isNaN(n) ? undefined : Math.round(n);
}

function StatBadge({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs", color)}>
      <Icon className="w-3 h-3" />
      <span className="font-semibold">{typeof value === "number" ? value.toLocaleString() : value}</span>
      <span className="text-current opacity-70">{label}</span>
    </div>
  );
}

function InsightChip({ text }: { text: string }) {
  return (
    <span className="inline-block bg-primary/10 text-primary text-xs px-2.5 py-1 rounded-full border border-primary/20">
      {text}
    </span>
  );
}

interface ParsedHeadline {
  headline: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

function parseHeadlineBatch(raw: string): ParsedHeadline[] {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const results: ParsedHeadline[] = [];
  let current: ParsedHeadline | null = null;
  let pendingHeadlineLines: string[] = [];

  const parseNum = (s: string): number => {
    const n = s.replace(/,/g, "").toLowerCase().trim();
    if (n.endsWith("k")) return Math.round(parseFloat(n) * 1_000);
    if (n.endsWith("m")) return Math.round(parseFloat(n) * 1_000_000);
    return parseInt(n) || 0;
  };

  const parseNumWithWords = (numPart: string, rest: string): number => {
    const combined = (numPart + " " + rest).toLowerCase().trim();
    if (/million/.test(combined)) return Math.round(parseFloat(numPart.replace(/,/g, "")) * 1_000_000);
    if (/billion/.test(combined)) return Math.round(parseFloat(numPart.replace(/,/g, "")) * 1_000_000_000);
    return parseNum(numPart);
  };

  const numRe = "(\\d[\\d.,]*(?:[km])?)(?:\\s*(?:million|billion))?";
  const viewsRe = new RegExp(numRe + "\\s*views?", "i");
  const likesRe = new RegExp(numRe + "\\s*(?:likes?|reacts?)", "i");
  const commentsRe = new RegExp(numRe + "\\s*comments?", "i");
  const sharesRe = new RegExp(numRe + "\\s*(?:shares?|reposts?)", "i");

  const extractMetric = (line: string, re: RegExp): number | undefined => {
    const m = line.match(re);
    if (!m) return undefined;
    const numStr = m[1];
    const afterNum = line.slice(line.indexOf(numStr) + numStr.length);
    return parseNumWithWords(numStr, afterNum);
  };

  const isMetricLine = (line: string) =>
    /^[⁃•\-\*]/.test(line) ||
    /\d[\d.,]*(?:[km]|\s*million|\s*billion)?\s*(?:views?|likes?|reacts?|comments?|shares?|reposts?)/i.test(line);

  const isStructuredKey = (line: string) =>
    /^(Views|Engagement|Shares|Comments|Net|Revenue|Ranking|Category|Posted|Headline):/i.test(line);

  const isSeparator = (line: string) => /^[⸻—\-]{2,}$/.test(line);

  const flushPending = () => {
    if (pendingHeadlineLines.length > 0) {
      const joined = pendingHeadlineLines.join(" ").replace(/^[\d]+\.\s*/, "").trim();
      if (current && current.headline) results.push(current);
      current = { headline: joined };
      pendingHeadlineLines = [];
    }
  };

  for (const line of lines) {
    if (isSeparator(line)) { flushPending(); continue; }
    if (isStructuredKey(line)) {
      flushPending();
      const headlineMatch = line.match(/^Headline:\s*(.+)/i);
      if (headlineMatch) {
        if (current && current.headline) results.push(current);
        current = { headline: headlineMatch[1].trim() };
      } else if (current) {
        const viewsMatch = line.match(/^Views:\s*([\d.,km]+(?:\s*million|\s*billion)?)/i);
        const engMatch = line.match(/^Engagement:\s*([\d.,km]+(?:\s*million|\s*billion)?)/i);
        if (viewsMatch) current.views = parseNumWithWords(viewsMatch[1].split(/\s/)[0], viewsMatch[1]);
        if (engMatch) current.likes = parseNumWithWords(engMatch[1].split(/\s/)[0], engMatch[1]);
      }
      continue;
    }
    if (isMetricLine(line)) {
      flushPending();
      if (current) {
        const v = extractMetric(line, viewsRe);
        const l = extractMetric(line, likesRe);
        const c = extractMetric(line, commentsRe);
        const s = extractMetric(line, sharesRe);
        if (v !== undefined) current.views = v;
        if (l !== undefined) current.likes = l;
        if (c !== undefined) current.comments = c;
        if (s !== undefined) current.shares = s;
      }
      continue;
    }
    if (line.length > 5) {
      if (current && (current.views != null || current.likes != null || current.comments != null || current.shares != null)) {
        results.push(current);
        current = null;
        pendingHeadlineLines = [line];
      } else if (pendingHeadlineLines.length > 0) {
        pendingHeadlineLines.push(line);
      } else if (current && !current.views && !current.likes) {
        pendingHeadlineLines = [current.headline, line];
        current = null;
      } else {
        pendingHeadlineLines = [line];
      }
    }
  }

  flushPending();
  if (current && current.headline) results.push(current);
  return results.filter(h => h.headline.length > 5);
}

/** Smart number input — shows raw text while typing, shows formatted value when blurred */
function SmartNumberInput({
  label,
  placeholder,
  value,
  onChange,
  icon: Icon,
  iconColor,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  icon: any;
  iconColor: string;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Icon className={cn("w-3 h-3", iconColor)} />
        {label}
      </Label>
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm bg-muted/30 border-border h-9"
      />
      {value && parseSmartNumber(value) !== undefined && (
        <p className="text-[10px] text-muted-foreground mt-0.5 pl-0.5">
          = {parseSmartNumber(value)!.toLocaleString()}
        </p>
      )}
    </div>
  );
}

export default function Historical() {
  const [formStep, setFormStep] = useState<0 | 1 | 2>(0); // 0=hidden, 1=step1 content, 2=step2 stats
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [parsedHeadlines, setParsedHeadlines] = useState<ParsedHeadline[]>([]);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [showInsights, setShowInsights] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [prefillHeadlines, setPrefillHeadlines] = useState<string[]>([]);
  const utils = trpc.useUtils();

  // Prefill form from URL query params (set by Approved Queue "Log Post" shortcut)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const headline = params.get("headline");
    if (!headline) return;
    const prefill: Partial<FormData> = {};
    if (headline) prefill.headline = headline;
    const category = params.get("category");
    if (category) prefill.category = category;
    const viralAngle = params.get("viralAngle");
    if (viralAngle) prefill.viralAngle = viralAngle;
    const article = params.get("article");
    if (article) prefill.article = article;
    prefill.selectedHeadline = headline;
    prefill.usedHeadlineVariant = "selected";
    setForm(prev => ({ ...prev, ...prefill }));
    setFormStep(1);
    const allH = params.get("allHeadlines");
    if (allH) {
      try { setPrefillHeadlines(JSON.parse(allH)); } catch { /* ignore */ }
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const { data: posts, isLoading } = trpc.historicalPosts.list.useQuery();
  const { data: insights, isLoading: insightsLoading } = trpc.historicalPosts.performanceInsights.useQuery();

  const analyseNow = trpc.historicalPosts.analyseNow.useMutation({
    onSuccess: () => {
      toast.success("Analysis complete — Soyunci prompts updated");
      utils.historicalPosts.performanceInsights.invalidate();
    },
    onError: (err) => toast.error(`Analysis failed: ${err.message}`),
  });

  const uploadHeadlines = trpc.historicalPosts.uploadHeadlines.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.saved} headlines saved — Soyunci prompts updated`);
      setBulkText("");
      setParsedHeadlines([]);
      setShowBulkUpload(false);
      utils.historicalPosts.list.invalidate();
      utils.historicalPosts.performanceInsights.invalidate();
    },
    onError: (err) => toast.error(`Upload failed: ${err.message}`),
  });

  const handleBulkParse = () => {
    const parsed = parseHeadlineBatch(bulkText);
    setParsedHeadlines(parsed);
    if (parsed.length === 0) toast.error("No headlines detected — check the format");
    else toast.success(`Detected ${parsed.length} headlines — review and confirm`);
  };

  const handleBulkUpload = () => {
    if (parsedHeadlines.length === 0) return;
    uploadHeadlines.mutate({ headlines: parsedHeadlines });
  };

  const create = trpc.historicalPosts.create.useMutation({
    onSuccess: () => {
      toast.success("Post logged — Soyunci will learn from this");
      setForm(emptyForm);
      setFormStep(0);
      setShowAdvanced(false);
      utils.historicalPosts.list.invalidate();
      utils.historicalPosts.performanceInsights.invalidate();
    },
    onError: (err) => {
      toast.error(`Failed to save: ${err.message}`);
    },
  });

  const handleSubmit = () => {
    if (!form.headline.trim()) {
      toast.error("Headline is required");
      return;
    }
    create.mutate({
      headline: form.headline,
      article: form.article || undefined,
      category: form.category || undefined,
      postingTime: form.postingTime || undefined,
      views: parseSmartNumber(form.views),
      likes: parseSmartNumber(form.likes),
      comments: parseSmartNumber(form.comments),
      shares: parseSmartNumber(form.shares),
      saves: parseSmartNumber(form.saves),
      followersGained: parseSmartNumber(form.followersGained),
      revenue: form.revenue ? parseFloat(form.revenue) : undefined,
      netFollows: parseSmartNumber(form.netFollows),
      platform: form.platform || undefined,
      airline: form.airline || undefined,
      imageType: form.imageType || undefined,
      sourceType: form.sourceType || undefined,
      aircraftType: form.aircraftType || undefined,
      storyType: form.storyType || undefined,
      viralAngle: form.viralAngle || undefined,
      selectedHeadline: form.selectedHeadline || undefined,
      usedHeadlineVariant: form.usedHeadlineVariant || undefined,
    });
  };

  const closeForm = () => {
    setFormStep(0);
    setForm(emptyForm);
    setShowAdvanced(false);
    setPrefillHeadlines([]);
  };

  const postCount = (posts || []).length;
  const hasInsights = !!insights;

  const { data: igStatus, isLoading: igLoading } = trpc.instagram.verifyToken.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const syncInstagram = trpc.instagram.syncPosts.useMutation({
    onSuccess: (data) => {
      toast.success(`Instagram sync complete — ${data.synced} new posts imported`);
      utils.historicalPosts.list.invalidate();
      utils.historicalPosts.performanceInsights.invalidate();
    },
    onError: (err) => toast.error(`Instagram sync failed: ${err.message}`),
  });

  return (
    <FlightLayout>
      <div className="p-6 max-w-3xl mx-auto">

        {/* ── Header ── */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
              Performance Data
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Log your posts to teach Soyunci what works
            </p>
          </div>
          <div className="flex items-center gap-2">
            {postCount >= 3 && (
              <Button
                variant="outline"
                onClick={() => analyseNow.mutate()}
                disabled={analyseNow.isPending}
                className="gap-2 text-xs h-8"
              >
                {analyseNow.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Analyse Now
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => { setShowBulkUpload(!showBulkUpload); setFormStep(0); }}
              className="gap-2 text-xs h-8"
            >
              <Upload className="w-3.5 h-3.5" />
              Bulk Upload
            </Button>
            {igStatus?.ok && (
              <Button
                variant="outline"
                onClick={() => syncInstagram.mutate({ limit: 50 })}
                disabled={syncInstagram.isPending}
                className="gap-2 text-xs h-8 border-pink-500/30 text-pink-400 hover:bg-pink-500/10"
                title={`Sync from @${igStatus.username}`}
              >
                {syncInstagram.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Instagram className="w-3.5 h-3.5" />}
                {syncInstagram.isPending ? "Syncing..." : "Sync Instagram"}
              </Button>
            )}
          </div>
        </div>

        {/* ── Instagram status banners ── */}
        {!igLoading && igStatus && !igStatus.ok && (
          <div className="flex items-center gap-3 bg-pink-500/10 border border-pink-500/20 rounded-xl px-4 py-3 mb-4">
            <Instagram className="w-4 h-4 text-pink-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-pink-300">Instagram not connected</p>
              <p className="text-xs text-pink-400/70 mt-0.5">
                Add your <code className="bg-pink-500/10 px-1 rounded">INSTAGRAM_ACCESS_TOKEN</code> in Settings → Secrets to enable automatic post syncing.
              </p>
            </div>
          </div>
        )}
        {!igLoading && igStatus?.ok && (
          <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 mb-4">
            <Instagram className="w-4 h-4 text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-300">
              Connected as <span className="font-semibold">@{igStatus.username}</span> — posts sync automatically every hour.
            </p>
          </div>
        )}

        {/* ── Prominent "Log a Post" CTA (when form is hidden) ── */}
        {formStep === 0 && !showBulkUpload && (
          <button
            onClick={() => setFormStep(1)}
            className="w-full flex items-center justify-between bg-primary/10 hover:bg-primary/15 border border-primary/30 hover:border-primary/50 rounded-xl px-5 py-4 mb-6 transition-all group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors">
                <Plus className="w-5 h-5 text-primary" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-foreground">Log a Post</p>
                <p className="text-xs text-muted-foreground">Add a headline, article and stats to improve Soyunci</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </button>
        )}

        {/* ── Two-step Log Post form ── */}
        {formStep > 0 && (
          <div className="bg-card border border-border rounded-xl mb-6 overflow-hidden">

            {/* Step indicator */}
            <div className="flex items-center gap-0 border-b border-border">
              <button
                onClick={() => setFormStep(1)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 text-xs font-semibold transition-colors",
                  formStep === 1
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold",
                  formStep === 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}>1</span>
                Content
              </button>
              <button
                onClick={() => { if (form.headline.trim()) setFormStep(2); else toast.error("Add a headline first"); }}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 text-xs font-semibold transition-colors",
                  formStep === 2
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold",
                  formStep === 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}>2</span>
                Stats
              </button>
              <button onClick={closeForm} className="px-4 py-3 text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Step 1 — Content */}
            {formStep === 1 && (
              <div className="p-5 space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">
                    Headline you actually posted <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    placeholder="The exact headline you used on Instagram"
                    value={form.headline}
                    onChange={(e) => setForm(prev => ({ ...prev, headline: e.target.value }))}
                    className="text-sm bg-muted/30 border-border"
                    autoFocus
                  />
                </div>

                {/* Headline variant picker — shown when prefill headlines available */}
                {prefillHeadlines.length > 0 && (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Zap className="w-3 h-3 text-primary" />
                      Which variant did you post?
                    </Label>
                    <div className="space-y-1.5">
                      <button
                        type="button"
                        onClick={() => setForm(p => ({ ...p, usedHeadlineVariant: "selected", headline: form.selectedHeadline || prefillHeadlines[0] || p.headline }))}
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors",
                          form.usedHeadlineVariant === "selected"
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                        )}
                      >
                        <span className="text-[10px] font-semibold text-primary uppercase tracking-wide mr-2">AI Pick</span>
                        {form.selectedHeadline || prefillHeadlines[0]}
                      </button>
                      {prefillHeadlines.map((h, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setForm(p => ({ ...p, usedHeadlineVariant: `alt_${i + 1}`, headline: h }))}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors",
                            form.usedHeadlineVariant === `alt_${i + 1}`
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                          )}
                        >
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mr-2">Alt {i + 1}</span>
                          {h}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setForm(p => ({ ...p, usedHeadlineVariant: "custom" }))}
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors",
                          form.usedHeadlineVariant === "custom"
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                        )}
                      >
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mr-2">Custom</span>
                        I wrote my own headline
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">
                    Article / caption <span className="text-muted-foreground/50">(optional — paste the full text)</span>
                  </Label>
                  <Textarea
                    placeholder="Paste the article or caption you posted..."
                    value={form.article}
                    onChange={(e) => setForm(prev => ({ ...prev, article: e.target.value }))}
                    className="text-sm bg-muted/30 border-border min-h-[100px] resize-none"
                  />
                </div>

                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={() => {
                      if (!form.headline.trim()) { toast.error("Add a headline first"); return; }
                      setFormStep(2);
                    }}
                    className="gap-2"
                  >
                    Next: Add Stats
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" onClick={closeForm}>Cancel</Button>
                </div>
              </div>
            )}

            {/* Step 2 — Stats */}
            {formStep === 2 && (
              <div className="p-5 space-y-5">
                {/* Headline preview */}
                <div className="bg-muted/30 rounded-lg px-3 py-2.5 flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-foreground font-medium leading-snug line-clamp-2">{form.headline}</p>
                </div>

                {/* Core stats */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Engagement Stats</p>
                  <div className="grid grid-cols-2 gap-3">
                    <SmartNumberInput label="Views" placeholder="e.g. 2.1m or 450k" value={form.views} onChange={v => setForm(p => ({ ...p, views: v }))} icon={Eye} iconColor="text-blue-400" />
                    <SmartNumberInput label="Likes" placeholder="e.g. 8.5k or 12000" value={form.likes} onChange={v => setForm(p => ({ ...p, likes: v }))} icon={Heart} iconColor="text-pink-400" />
                    <SmartNumberInput label="Comments" placeholder="e.g. 850" value={form.comments} onChange={v => setForm(p => ({ ...p, comments: v }))} icon={MessageCircle} iconColor="text-purple-400" />
                    <SmartNumberInput label="Shares" placeholder="e.g. 3.2k" value={form.shares} onChange={v => setForm(p => ({ ...p, shares: v }))} icon={Share2} iconColor="text-amber-400" />
                    <SmartNumberInput label="Saves" placeholder="e.g. 1.4k" value={form.saves} onChange={v => setForm(p => ({ ...p, saves: v }))} icon={Download} iconColor="text-indigo-400" />
                    <SmartNumberInput label="Followers Gained" placeholder="e.g. 320" value={form.followersGained} onChange={v => setForm(p => ({ ...p, followersGained: v }))} icon={Users} iconColor="text-teal-400" />
                  </div>
                </div>

                {/* Posting time — date+time picker */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
                    <Clock className="w-3 h-3 text-muted-foreground" />
                    When did you post it?
                  </Label>
                  <Input
                    type="datetime-local"
                    value={form.postingTime}
                    onChange={(e) => setForm(prev => ({ ...prev, postingTime: e.target.value }))}
                    className="text-sm bg-muted/30 border-border h-9"
                  />
                </div>

                {/* Viral angle */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
                    <Zap className="w-3 h-3 text-amber-400" />
                    Viral angle <span className="text-muted-foreground/50 font-normal">(optional)</span>
                  </Label>
                  <Input
                    placeholder="e.g. Safety Crisis, Accountability, Passenger Outrage"
                    value={form.viralAngle}
                    onChange={(e) => setForm(prev => ({ ...prev, viralAngle: e.target.value }))}
                    className="text-sm bg-muted/30 border-border h-9"
                  />
                </div>

                {/* Advanced toggle */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {showAdvanced ? "Hide advanced fields" : "Show advanced fields (category, aircraft, source…)"}
                </button>

                {showAdvanced && (
                  <div className="space-y-3 border-t border-border pt-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Platform</Label>
                        <Input placeholder="e.g. Instagram, TikTok, Facebook" value={form.platform} onChange={e => setForm(p => ({ ...p, platform: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Airline / Subject</Label>
                        <Input placeholder="e.g. Ryanair, British Airways" value={form.airline} onChange={e => setForm(p => ({ ...p, airline: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Image Type</Label>
                        <Input placeholder="e.g. Aircraft photo, AI poster, Text card" value={form.imageType} onChange={e => setForm(p => ({ ...p, imageType: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Category</Label>
                        <Input placeholder="e.g. Safety & Accountability" value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Story Type</Label>
                        <Input placeholder="e.g. Crash, Pay, Outrage" value={form.storyType} onChange={e => setForm(p => ({ ...p, storyType: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Aircraft Type</Label>
                        <Input placeholder="e.g. Boeing 737 MAX" value={form.aircraftType} onChange={e => setForm(p => ({ ...p, aircraftType: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1.5 block">Source</Label>
                        <Input placeholder="e.g. BBC, Simple Flying" value={form.sourceType} onChange={e => setForm(p => ({ ...p, sourceType: e.target.value }))} className="text-sm bg-muted/30 border-border h-8" />
                      </div>
                      <SmartNumberInput label="Revenue (£)" placeholder="e.g. 42.50" value={form.revenue} onChange={v => setForm(p => ({ ...p, revenue: v }))} icon={DollarSign} iconColor="text-emerald-400" />
                      <SmartNumberInput label="Net Follows" placeholder="e.g. 1.2k" value={form.netFollows} onChange={v => setForm(p => ({ ...p, netFollows: v }))} icon={Users} iconColor="text-cyan-400" />
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="ghost" size="sm" onClick={() => setFormStep(1)} className="gap-1.5 text-xs">
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back
                  </Button>
                  <Button onClick={handleSubmit} disabled={create.isPending} className="gap-2 flex-1">
                    {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    Save Post
                  </Button>
                  <Button variant="outline" onClick={closeForm}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Performance Insights Panel ── */}
        {(hasInsights || insightsLoading) && (
          <div className="bg-card border border-border rounded-xl mb-6 overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/20 transition-colors"
              onClick={() => setShowInsights(!showInsights)}
            >
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Brain className="w-4 h-4 text-primary" />
                </div>
                <div className="text-left">
                  <span className="text-sm font-semibold text-foreground">Learned Performance Insights</span>
                  {insights && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {insights.postsAnalysed} posts analysed · updated {new Date(insights.analysedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              {showInsights ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>

            {showInsights && (
              <div className="px-5 pb-5 border-t border-border">
                {insightsLoading ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading insights...
                  </div>
                ) : insights ? (
                  <div className="space-y-4 pt-4">
                    {insights.summary && (
                      <p className="text-sm text-muted-foreground leading-relaxed border-l-2 border-primary/40 pl-3">
                        {insights.summary}
                      </p>
                    )}

                    {/* Headline A/B Variant Breakdown */}
                    {(() => {
                      const allPosts = posts || [];
                      const withVariant = allPosts.filter((p: any) => p.usedHeadlineVariant);
                      if (withVariant.length < 2) return null;
                      const counts: Record<string, number> = {};
                      const totalViews: Record<string, number> = {};
                      withVariant.forEach((p: any) => {
                        const v = p.usedHeadlineVariant as string;
                        counts[v] = (counts[v] || 0) + 1;
                        totalViews[v] = (totalViews[v] || 0) + (p.views || 0);
                      });
                      const variants = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                      const labelFor = (v: string) => v === "selected" ? "AI Pick" : v === "custom" ? "Custom" : v.replace("_", " ").toUpperCase();
                      const colorFor = (v: string) => v === "selected" ? "text-primary" : v === "custom" ? "text-amber-400" : "text-purple-400";
                      return (
                        <div className="border border-border/50 rounded-xl p-4 col-span-full">
                          <div className="flex items-center gap-1.5 mb-3">
                            <Zap className="w-3.5 h-3.5 text-primary" />
                            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Headline Variant Win Rate</span>
                            <span className="text-xs text-muted-foreground ml-1">({withVariant.length} tracked posts)</span>
                          </div>
                          <div className="space-y-2">
                            {variants.map(([v, count]) => {
                              const pct = Math.round((count / withVariant.length) * 100);
                              const avgViews = totalViews[v] ? Math.round(totalViews[v] / count) : null;
                              return (
                                <div key={v} className="flex items-center gap-3">
                                  <span className={cn("text-[10px] font-semibold uppercase tracking-wide shrink-0 w-16", colorFor(v))}>{labelFor(v)}</span>
                                  <div className="flex-1 bg-muted/40 rounded-full h-1.5 overflow-hidden">
                                    <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span className="text-xs text-muted-foreground shrink-0 w-10 text-right">{pct}%</span>
                                  <span className="text-xs text-muted-foreground shrink-0">{count}×</span>
                                  {avgViews !== null && avgViews > 0 && (
                                    <span className="text-xs text-muted-foreground shrink-0">{avgViews.toLocaleString()} avg views</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {insights.topAngles.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <Zap className="w-3.5 h-3.5 text-amber-400" />
                            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Top Viral Angles</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {insights.topAngles.map((a, i) => <InsightChip key={i} text={a} />)}
                          </div>
                        </div>
                      )}
                      {insights.topCategories.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <Target className="w-3.5 h-3.5 text-blue-400" />
                            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Top Categories</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {insights.topCategories.map((c, i) => <InsightChip key={i} text={c} />)}
                          </div>
                        </div>
                      )}
                      {insights.headlinePatterns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <PenLine className="w-3.5 h-3.5 text-purple-400" />
                            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Headline Patterns</span>
                          </div>
                          <ul className="space-y-1">
                            {insights.headlinePatterns.map((p, i) => (
                              <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                                <span className="text-primary shrink-0">·</span>{p}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {insights.writingTips.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <Lightbulb className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Writing Tips for Soyunci</span>
                          </div>
                          <ul className="space-y-1">
                            {insights.writingTips.map((t, i) => (
                              <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                                <span className="text-emerald-400 shrink-0">·</span>{t}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* ── Nudge: need more posts ── */}
        {!hasInsights && !insightsLoading && postCount > 0 && postCount < 3 && (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 mb-6 flex items-start gap-3">
            <Brain className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Log <strong className="text-foreground">{3 - postCount} more {3 - postCount === 1 ? "post" : "posts"}</strong> with views/likes to unlock performance insights. Once you have 3+ posts, Soyunci will automatically learn which angles and headline styles perform best for FlightDrama.
            </p>
          </div>
        )}

        {/* ── Bulk Upload Panel ── */}
        {showBulkUpload && (
          <div className="bg-card border border-border rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Bulk Headline Upload</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Paste your headlines with engagement data — any format works
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setShowBulkUpload(false); setBulkText(""); setParsedHeadlines([]); }}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {parsedHeadlines.length === 0 ? (
              <>
                <Textarea
                  placeholder={`Paste your headlines here — any format works. Examples:\n\nHEATHROW JUST ENDED THE LIQUIDS AND LAPTOP RULE FOR MILLIONS OF PASSENGERS\n⁃ 8.5k likes , 689 comments , 1k shares , 2 million views\n\nMan Eats His Passport On Ryanair Flight From Milan To London\n⁃ 61k likes , 1k comments , 402 shares , 5.5 million views\n\nOr structured format:\nHeadline: British Airways 787 spends nearly 9 hours airborne before returning to Heathrow\nViews: 244,323\nEngagement: 10,810`}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="text-sm bg-muted/30 border-border min-h-[200px] resize-none font-mono text-xs mb-3"
                />
                <Button onClick={handleBulkParse} disabled={!bulkText.trim()} className="gap-2">
                  <Brain className="w-4 h-4" />
                  Parse Headlines
                </Button>
              </>
            ) : (
              <>
                <div className="bg-muted/20 rounded-lg p-3 mb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-semibold text-foreground">{parsedHeadlines.length} headlines detected</span>
                    <Button variant="ghost" size="sm" className="ml-auto text-xs h-6" onClick={() => setParsedHeadlines([])}>Re-parse</Button>
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {parsedHeadlines.map((h, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0 w-5 text-right">{i + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-foreground font-medium leading-snug">{h.headline}</p>
                          <div className="flex gap-2 mt-0.5 flex-wrap">
                            {h.views != null && <span className="text-blue-400">{h.views.toLocaleString()} views</span>}
                            {h.likes != null && <span className="text-pink-400">{h.likes.toLocaleString()} likes</span>}
                            {h.comments != null && <span className="text-purple-400">{h.comments.toLocaleString()} comments</span>}
                            {h.shares != null && <span className="text-amber-400">{h.shares.toLocaleString()} shares</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleBulkUpload} disabled={uploadHeadlines.isPending} className="gap-2">
                    {uploadHeadlines.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    Save {parsedHeadlines.length} Headlines
                  </Button>
                  <Button variant="outline" onClick={() => { setShowBulkUpload(false); setBulkText(""); setParsedHeadlines([]); }}>Cancel</Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Posts list ── */}
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (posts || []).length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <TrendingUp className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">No performance data yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Log your historical posts with views and likes to help Soyunci learn what works for FlightDrama.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {(posts || []).map((post) => (
              <div key={post.id} className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground leading-snug">{post.headline}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {post.viralAngle && (
                        <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                          {post.viralAngle}
                        </span>
                      )}
                      {post.category && (
                        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{post.category}</span>
                      )}
                      {post.aircraftType && (
                        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{post.aircraftType}</span>
                      )}
                      {post.storyType && (
                        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{post.storyType}</span>
                      )}
                      {post.postingTime && (
                        <span className="text-xs text-muted-foreground">{post.postingTime}</span>
                      )}
                      {(post as any).usedHeadlineVariant && (
                        <span className={cn(
                          "text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border",
                          (post as any).usedHeadlineVariant === "selected"
                            ? "text-primary bg-primary/10 border-primary/30"
                            : (post as any).usedHeadlineVariant === "custom"
                            ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
                            : "text-purple-400 bg-purple-500/10 border-purple-500/30"
                        )}>
                          {(post as any).usedHeadlineVariant === "selected" ? "AI Pick" : (post as any).usedHeadlineVariant === "custom" ? "Custom" : (post as any).usedHeadlineVariant.replace("_", " ").toUpperCase()}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(post.createdAt).toLocaleDateString()}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {post.views != null && <StatBadge icon={Eye} label="views" value={post.views} color="bg-blue-500/10 text-blue-400" />}
                  {post.likes != null && <StatBadge icon={Heart} label="likes" value={post.likes} color="bg-pink-500/10 text-pink-400" />}
                  {post.comments != null && <StatBadge icon={MessageCircle} label="comments" value={post.comments} color="bg-purple-500/10 text-purple-400" />}
                  {post.shares != null && <StatBadge icon={Share2} label="shares" value={post.shares} color="bg-amber-500/10 text-amber-400" />}
                  {(post as any).saves != null && <StatBadge icon={Download} label="saves" value={(post as any).saves} color="bg-indigo-500/10 text-indigo-400" />}
                  {(post as any).followersGained != null && <StatBadge icon={Users} label="followers gained" value={(post as any).followersGained} color="bg-teal-500/10 text-teal-400" />}
                  {post.revenue != null && <StatBadge icon={DollarSign} label="revenue" value={`£${post.revenue.toFixed(2)}`} color="bg-emerald-500/10 text-emerald-400" />}
                  {post.netFollows != null && <StatBadge icon={Users} label="net follows" value={post.netFollows} color="bg-cyan-500/10 text-cyan-400" />}
                </div>
                {((post as any).platform || (post as any).airline || (post as any).imageType) && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(post as any).platform && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20">{(post as any).platform}</span>
                    )}
                    {(post as any).airline && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">{(post as any).airline}</span>
                    )}
                    {(post as any).imageType && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">{(post as any).imageType}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </FlightLayout>
  );
}
