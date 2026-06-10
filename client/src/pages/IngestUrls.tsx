import { useState } from "react";
import FlightLayout from "@/components/FlightLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Loader2, CheckCircle2, XCircle, AlertCircle, Zap, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "wouter";

type ResultStatus = "complete" | "duplicate_url" | "duplicate_title" | "not_aviation" | "error";

interface ProcessResult {
  url: string;
  status: ResultStatus;
  storyId?: number;
  title?: string;
  viralScore?: number;
  statusLabel?: string;
  error?: string;
}

const STATUS_CONFIG: Record<ResultStatus, { label: string; icon: React.ReactNode; textColor: string }> = {
  complete: { label: "Complete", icon: <CheckCircle2 className="w-4 h-4" />, textColor: "text-emerald-400" },
  duplicate_url: { label: "Duplicate URL", icon: <AlertCircle className="w-4 h-4" />, textColor: "text-amber-400" },
  duplicate_title: { label: "Duplicate Story", icon: <AlertCircle className="w-4 h-4" />, textColor: "text-amber-400" },
  not_aviation: { label: "Not Aviation", icon: <XCircle className="w-4 h-4" />, textColor: "text-zinc-500" },
  error: { label: "Error", icon: <XCircle className="w-4 h-4" />, textColor: "text-red-400" },
};

const LABEL_STYLES: Record<string, string> = {
  must_post: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30",
  strong_candidate: "bg-blue-500/20 text-blue-300 border border-blue-500/30",
  maybe: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
  reject: "bg-red-500/20 text-red-300 border border-red-500/30",
};

const LABEL_NAMES: Record<string, string> = {
  must_post: "Must Post",
  strong_candidate: "Strong Candidate",
  maybe: "Maybe",
  reject: "Reject",
};

export default function IngestUrls() {
  const [urlInput, setUrlInput] = useState("");
  const [results, setResults] = useState<ProcessResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const utils = trpc.useUtils();

  const processUrls = trpc.stories.processUrls.useMutation({
    onSuccess: (data) => {
      const typed = data.results as ProcessResult[];
      setResults(typed);
      const completed = typed.filter((r) => r.status === "complete").length;
      const dupes = typed.filter((r) => r.status.startsWith("duplicate")).length;
      const errors = typed.filter((r) => r.status === "error").length;
      const notAviation = typed.filter((r) => r.status === "not_aviation").length;

      if (completed > 0) {
        toast.success(`${completed} ${completed === 1 ? "story" : "stories"} fully processed`);
        utils.stories.list.invalidate();
      }
      if (dupes > 0) toast.info(`${dupes} duplicate${dupes > 1 ? "s" : ""} skipped`);
      if (notAviation > 0) toast.info(`${notAviation} non-aviation ${notAviation > 1 ? "stories" : "story"} filtered`);
      if (errors > 0) toast.error(`${errors} URL${errors > 1 ? "s" : ""} failed`);
    },
    onError: (err: { message: string }) => {
      toast.error(`Pipeline failed: ${err.message}`);
    },
  });

  const parseUrls = (text: string): string[] =>
    text
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter((u) => u.startsWith("http://") || u.startsWith("https://"));

  const handleSubmit = async () => {
    const urls = parseUrls(urlInput);
    if (urls.length === 0) {
      toast.error("No valid URLs found — make sure each URL starts with http:// or https://");
      return;
    }
    setIsProcessing(true);
    setResults([]);
    try {
      await processUrls.mutateAsync({ urls });
    } finally {
      setIsProcessing(false);
    }
  };

  const urlCount = parseUrls(urlInput).length;
  const completed = results.filter((r) => r.status === "complete").length;

  return (
    <FlightLayout>
      <div className="p-6 max-w-2xl space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
            Add Stories
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paste article URLs below. Each story is fetched, scored, and fully processed by Soyunci — article, headlines, images, and Canva brief — automatically.
          </p>
        </div>

        {/* Input */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <Textarea
            placeholder={`Paste one URL per line:\n\nhttps://simpleflying.com/boeing-737-story/\nhttps://theaviationist.com/some-story/\nhttps://www.bbc.com/news/aviation-story/`}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="min-h-[180px] text-sm font-mono bg-muted/30 border-border resize-y"
            disabled={isProcessing}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {urlCount > 0 ? `${urlCount} URL${urlCount !== 1 ? "s" : ""} detected` : "One URL per line"}
            </p>
            <Button
              onClick={handleSubmit}
              disabled={urlCount === 0 || isProcessing}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {isProcessing ? "Running Pipeline..." : "Run Full Pipeline"}
            </Button>
          </div>
        </div>

        {/* Processing status */}
        {isProcessing && (
          <div className="bg-card border border-border rounded-xl p-4 flex items-start gap-3">
            <Loader2 className="w-5 h-5 text-primary animate-spin flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-foreground">Soyunci is working...</p>
              <p className="text-xs text-muted-foreground mt-1">
                Fetch → Dedupe check → Viral score → Write article → Generate 10 headlines → Image research → Canva brief
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Each story takes 20–40 seconds. Do not close this page.
              </p>
            </div>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">Results</h2>
              <div className="flex gap-3 text-xs text-muted-foreground">
                {completed > 0 && <span className="text-emerald-400 font-medium">{completed} complete</span>}
                {results.filter((r) => r.status === "error").length > 0 && (
                  <span className="text-red-400 font-medium">{results.filter((r) => r.status === "error").length} failed</span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {results.map((result, i) => {
                const cfg = STATUS_CONFIG[result.status];
                return (
                  <div key={i} className="bg-card border border-border rounded-lg p-3">
                    <div className="flex items-start gap-3">
                      <span className={`mt-0.5 flex-shrink-0 ${cfg.textColor}`}>{cfg.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-semibold ${cfg.textColor}`}>{cfg.label}</span>
                          {result.statusLabel && (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${LABEL_STYLES[result.statusLabel] || ""}`}>
                              {LABEL_NAMES[result.statusLabel] || result.statusLabel}
                            </span>
                          )}
                          {result.viralScore !== undefined && (
                            <span className="text-xs text-muted-foreground">Score: {result.viralScore}</span>
                          )}
                        </div>
                        {result.title && (
                          <p className="text-sm text-foreground mt-1 font-medium leading-snug">{result.title}</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1 truncate">{result.url}</p>
                        {result.error && (
                          <p className="text-xs text-red-400 mt-1">{result.error}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {completed > 0 && (
              <Link href="/">
                <Button variant="outline" className="w-full gap-2 border-border">
                  <ArrowRight className="w-4 h-4" />
                  View Dashboard — {completed} new {completed === 1 ? "story" : "stories"} ready
                </Button>
              </Link>
            )}
          </div>
        )}
      </div>
    </FlightLayout>
  );
}
