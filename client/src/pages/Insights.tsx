import { trpc } from "@/lib/trpc";
import FlightLayout from "@/components/FlightLayout";
import { cn } from "@/lib/utils";
import { Loader2, BrainCircuit, ArrowUp, ArrowDown, Minus, BookOpen, Sliders, Clock, Sparkles, Zap, ZapOff, ToggleLeft, ToggleRight, TrendingUp, CheckCircle, AlertTriangle, BarChart2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { useState } from "react";
import { toast } from "sonner";

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreDelta(original: number, override: number) {
  const delta = override - original;
  if (delta > 0) return { delta, dir: "up" as const };
  if (delta < 0) return { delta, dir: "down" as const };
  return { delta: 0, dir: "same" as const };
}

function labelColor(label: string | null) {
  switch (label) {
    case "must_post": return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
    case "strong_candidate": return "text-blue-400 bg-blue-500/10 border-blue-500/20";
    case "maybe": return "text-amber-400 bg-amber-500/10 border-amber-500/20";
    case "reject": return "text-red-400 bg-red-500/10 border-red-500/20";
    default: return "text-muted-foreground bg-muted border-border";
  }
}

function labelText(label: string | null) {
  switch (label) {
    case "must_post": return "Must Post";
    case "strong_candidate": return "Strong";
    case "maybe": return "Maybe";
    case "reject": return "Reject";
    default: return label ?? "—";
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Insights() {
  const [activeTab, setActiveTab] = useState<"overrides" | "rules" | "stat" | "calibration" | "cost">("overrides");

  const { data: calibration, isLoading: loadingCalibration } = trpc.stories.calibrationInsights.useQuery();

  const { data: overrides, isLoading: loadingOverrides } = trpc.stories.overrideHistory.useQuery();
  const { data: insights, isLoading: loadingInsights } = trpc.stories.scoringInsights.useQuery();
  const utils = trpc.useUtils();
  const { data: costConfig, isLoading: loadingCost } = trpc.costControl.get.useQuery();
  const setCost = trpc.costControl.set.useMutation({
    onSuccess: () => { toast.success("Cost settings saved"); utils.costControl.get.invalidate(); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const totalOverrides = overrides?.length ?? 0;
  const avgDelta = overrides && overrides.length > 0
    ? Math.round(
        overrides.reduce((sum, o) => sum + ((o.overrideScore ?? 0) - o.viralScore), 0) / overrides.length
      )
    : null;
  const upCount = overrides?.filter(o => (o.overrideScore ?? 0) > o.viralScore).length ?? 0;
  const downCount = overrides?.filter(o => (o.overrideScore ?? 0) < o.viralScore).length ?? 0;

  return (
    <FlightLayout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
              <BrainCircuit className="w-4 h-4 text-violet-400" />
            </div>
            <h1
              className="text-2xl font-bold text-foreground"
              style={{ fontFamily: "Space Grotesk, sans-serif" }}
            >
              Learning Insights
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-11">
            How your overrides are shaping the AI scoring system
          </p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            {
              label: "Total Overrides",
              value: totalOverrides,
              color: "text-foreground",
              bg: "bg-muted/40 border-border",
              icon: <Sliders className="w-3.5 h-3.5 text-muted-foreground" />,
            },
            {
              label: "Scored Up",
              value: upCount,
              color: "text-emerald-400",
              bg: "bg-emerald-500/10 border-emerald-500/20",
              icon: <ArrowUp className="w-3.5 h-3.5 text-emerald-400" />,
            },
            {
              label: "Scored Down",
              value: downCount,
              color: "text-red-400",
              bg: "bg-red-500/10 border-red-500/20",
              icon: <ArrowDown className="w-3.5 h-3.5 text-red-400" />,
            },
            {
              label: "Avg Delta",
              value: avgDelta !== null ? (avgDelta > 0 ? `+${avgDelta}` : `${avgDelta}`) : "—",
              color: avgDelta !== null && avgDelta > 0 ? "text-emerald-400" : avgDelta !== null && avgDelta < 0 ? "text-red-400" : "text-muted-foreground",
              bg: "bg-muted/40 border-border",
              icon: <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />,
            },
          ].map(({ label, value, color, bg, icon }) => (
            <div key={label} className={cn("rounded-xl border p-3", bg)}>
              <div className="flex items-center gap-1.5 mb-1">{icon}<span className="text-xs text-muted-foreground">{label}</span></div>
              <p className={cn("text-2xl font-bold", color)} style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* Last learned banner */}
        {insights?.lastLearnedAt && (
          <div className="flex items-center gap-2 text-xs text-violet-400 bg-violet-500/8 border border-violet-500/20 rounded-lg px-3 py-2 mb-5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>
              Scoring rules last updated {formatDate(insights.lastLearnedAt)}
              {insights.lastLearnedExamplesCount !== null && (
                <> using {insights.lastLearnedExamplesCount} override examples</>
              )}
            </span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-5 border-b border-border">
          {[
            { id: "overrides" as const, label: "Override History", icon: Sliders },
            { id: "rules" as const, label: "Learned Rules", icon: BookOpen },
            { id: "stat" as const, label: "Stat Learner", icon: BarChart2 },
            { id: "calibration" as const, label: "Score Calibration", icon: TrendingUp },
            { id: "cost" as const, label: "Cost Control", icon: Zap },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === id
                  ? "border-violet-400 text-violet-400"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Override History Tab */}
        {activeTab === "overrides" && (
          <>
            {loadingOverrides ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : !overrides || overrides.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <Sliders className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-semibold text-foreground mb-1">No overrides yet</h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Override a story's score on the Dashboard and it will appear here. The system learns from each one.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {overrides.map((o, i) => {
                  const { delta, dir } = scoreDelta(o.viralScore, o.overrideScore ?? o.viralScore);
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-4 rounded-xl border border-border bg-card/40 px-4 py-3 hover:bg-card/70 transition-colors"
                    >
                      {/* Delta indicator */}
                      <div className={cn(
                        "shrink-0 w-10 h-10 rounded-lg flex flex-col items-center justify-center text-xs font-bold",
                        dir === "up" ? "bg-emerald-500/15 text-emerald-400" :
                        dir === "down" ? "bg-red-500/15 text-red-400" :
                        "bg-muted text-muted-foreground"
                      )}>
                        {dir === "up" ? <ArrowUp className="w-3.5 h-3.5 mb-0.5" /> :
                         dir === "down" ? <ArrowDown className="w-3.5 h-3.5 mb-0.5" /> :
                         <Minus className="w-3.5 h-3.5 mb-0.5" />}
                        <span>{dir === "up" ? `+${delta}` : delta}</span>
                      </div>

                      {/* Story info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground font-medium leading-snug line-clamp-2 mb-1.5">
                          {o.title}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Original score */}
                          <span className="text-xs text-muted-foreground">
                            AI: <span className="font-mono font-semibold text-foreground">{o.viralScore}</span>
                          </span>
                          <span className="text-muted-foreground text-xs">→</span>
                          {/* Override score */}
                          <span className="text-xs text-muted-foreground">
                            Override: <span className="font-mono font-semibold text-foreground">{o.overrideScore}</span>
                          </span>
                          {/* Override label */}
                          {o.overrideLabel && (
                            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium border", labelColor(o.overrideLabel))}>
                              {labelText(o.overrideLabel)}
                            </span>
                          )}
                          {/* Category */}
                          {o.category && (
                            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                              {o.category}
                            </span>
                          )}
                        </div>
                        {/* Original AI reason */}
                        {o.viralReason && (
                          <p className="text-xs text-muted-foreground mt-1.5 italic line-clamp-1">
                            AI reason: {o.viralReason}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Learned Rules Tab */}
        {activeTab === "rules" && (
          <>
            {loadingInsights ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : !insights?.learnedRules && !insights?.learnedWeights && !insights?.learnedInsights ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mb-4">
                  <BrainCircuit className="w-6 h-6 text-violet-400" />
                </div>
                <h3 className="text-base font-semibold text-foreground mb-1">No learned rules yet</h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Override at least 3 stories on the Dashboard. The system will automatically analyse the patterns and generate personalised scoring rules.
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {insights?.learnedInsights && (
                  <section className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-5">
                    <h2 className="text-sm font-semibold text-violet-300 mb-3 flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5" /> Editor Taste Profile
                    </h2>
                    <p className="text-sm text-foreground/80 leading-relaxed">{insights.learnedInsights}</p>
                  </section>
                )}

                {insights?.learnedRules && (
                  <section className="rounded-xl border border-border bg-card/40 p-5">
                    <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                      <BookOpen className="w-3.5 h-3.5 text-muted-foreground" /> Learned Scoring Rules
                    </h2>
                    <div className="prose prose-sm prose-invert max-w-none text-foreground/80">
                      <Markdown>{insights.learnedRules}</Markdown>
                    </div>
                  </section>
                )}

                {insights?.learnedWeights && (
                  <section className="rounded-xl border border-border bg-card/40 p-5">
                    <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                      <Sliders className="w-3.5 h-3.5 text-muted-foreground" /> Category Weights
                    </h2>
                    <div className="prose prose-sm prose-invert max-w-none text-foreground/80">
                      <Markdown>{insights.learnedWeights}</Markdown>
                    </div>
                  </section>
                )}
              </div>
            )}
          </>
        )}
        {/* Stat Learner Tab */}
        {activeTab === "stat" && (
          <div className="space-y-5">
            {loadingInsights ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Overall drift */}
                {insights?.statOverallDrift && (
                  <div className={cn(
                    "rounded-xl border p-4 flex items-start gap-3",
                    insights.statOverallDrift.includes("too generous") ? "border-amber-500/20 bg-amber-500/5" :
                    insights.statOverallDrift.includes("too conservative") ? "border-blue-500/20 bg-blue-500/5" :
                    "border-emerald-500/20 bg-emerald-500/5"
                  )}>
                    <BarChart2 className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-foreground mb-0.5">Scoring Drift</p>
                      <p className="text-sm text-foreground/80">{insights.statOverallDrift}</p>
                      {insights.statExamplesCount !== null && (
                        <p className="text-xs text-muted-foreground mt-1">Based on {insights.statExamplesCount} overrides</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Category patterns */}
                {insights?.statCategoryWeights && insights.statCategoryWeights !== "Not enough data per category yet." && (
                  <section className="rounded-xl border border-border bg-card/40 p-5">
                    <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                      <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" /> Category Patterns
                      <span className="text-xs text-muted-foreground font-normal">(negative = AI overestimates, positive = AI underestimates)</span>
                    </h2>
                    <div className="space-y-2">
                      {insights.statCategoryWeights.split("; ").map((entry, i) => {
                        const isNeg = entry.includes("-") && !entry.includes("+");
                        const isPos = entry.includes("+");
                        const pts = entry.match(/([+-]\d+)/);
                        const magnitude = pts ? Math.abs(parseInt(pts[1])) : 0;
                        const label = isNeg
                          ? `AI overestimates — score ${magnitude > 30 ? "much" : "slightly"} lower`
                          : isPos
                          ? `AI underestimates — score ${magnitude > 10 ? "higher" : "slightly higher"}`
                          : "AI is well-calibrated";
                        return (
                          <div key={i} className={cn(
                            "flex items-start justify-between gap-3 rounded px-3 py-2",
                            isNeg && magnitude > 30 ? "bg-red-500/10 border border-red-500/20" :
                            isNeg ? "bg-amber-500/10 border border-amber-500/20" :
                            isPos ? "bg-emerald-500/10 border border-emerald-500/20" :
                            "bg-muted/30"
                          )}>
                            <span className="text-xs text-foreground/80 font-mono flex-1">{entry}</span>
                            <span className={cn(
                              "text-xs shrink-0 font-medium",
                              isNeg && magnitude > 30 ? "text-red-400" :
                              isNeg ? "text-amber-400" :
                              isPos ? "text-emerald-400" :
                              "text-muted-foreground"
                            )}>{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Keyword boosts and penalties */}
                <div className="grid grid-cols-2 gap-4">
                  {insights?.statKeywordBoosts && insights.statKeywordBoosts !== "none yet" && (
                    <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                      <h2 className="text-xs font-semibold text-emerald-400 mb-2 flex items-center gap-1.5">
                        <ArrowUp className="w-3 h-3" /> Words You Consistently Boost
                      </h2>
                      <p className="text-xs text-foreground/70 leading-relaxed">{insights.statKeywordBoosts}</p>
                    </section>
                  )}
                  {insights?.statKeywordPenalties && insights.statKeywordPenalties !== "none yet" && (
                    <section className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                      <h2 className="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1.5">
                        <ArrowDown className="w-3 h-3" /> Words You Consistently Reject
                      </h2>
                      <p className="text-xs text-foreground/70 leading-relaxed">{insights.statKeywordPenalties}</p>
                    </section>
                  )}
                </div>

                {/* Performance keywords (from historical posts) */}
                {(insights?.statPerfHighKeywords || insights?.statPerfLowKeywords) && (
                  <div className="grid grid-cols-2 gap-4">
                    {insights?.statPerfHighKeywords && insights.statPerfHighKeywords !== "" && (
                      <section className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
                        <h2 className="text-xs font-semibold text-blue-400 mb-2 flex items-center gap-1.5">
                          <ArrowUp className="w-3 h-3" /> High-Engagement Headline Words
                        </h2>
                        <p className="text-xs text-foreground/70 leading-relaxed">{insights.statPerfHighKeywords}</p>
                        {insights.statPerfPostsCount && (
                          <p className="text-xs text-muted-foreground mt-1">From {insights.statPerfPostsCount} logged posts</p>
                        )}
                      </section>
                    )}
                    {insights?.statPerfLowKeywords && insights.statPerfLowKeywords !== "" && (
                      <section className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                        <h2 className="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1.5">
                          <ArrowDown className="w-3 h-3" /> Low-Engagement Headline Words
                        </h2>
                        <p className="text-xs text-foreground/70 leading-relaxed">{insights.statPerfLowKeywords}</p>
                      </section>
                    )}
                  </div>
                )}

                {/* Empty state */}
                {!insights?.statOverallDrift && !insights?.statCategoryWeights && !insights?.statKeywordBoosts && (
                  <div className="flex flex-col items-center justify-center py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
                      <BarChart2 className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground mb-1">No stat data yet</h3>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      Override at least 3 stories on the Dashboard. The statistical learner runs automatically on every override.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Score Calibration Tab */}
        {activeTab === "calibration" && (
          <div className="space-y-5">
            {/* Explanation banner */}
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="w-4 h-4 text-violet-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-violet-300 mb-1">Performance Feedback Loop</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This compares your score overrides against what actually performed on Instagram. Over time it shows you where your instincts are most accurate and where the AI's original score was closer to the truth.
                  </p>
                </div>
              </div>
            </div>

            {loadingCalibration ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : !calibration || calibration.status === "no_data" ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <BarChart2 className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-semibold text-foreground mb-1">No Instagram data yet</h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Log your Instagram post stats in the Historical section. Once you have posts with views and likes recorded, calibration will appear here automatically.
                </p>
              </div>
            ) : calibration.status === "insufficient_data" ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <BarChart2 className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-base font-semibold text-foreground mb-1">Building calibration data</h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  {calibration.message}
                </p>
                <p className="text-xs text-muted-foreground mt-2">{calibration.totalLoggedPosts} posts logged so far</p>
              </div>
            ) : (
              <>
                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-border bg-card/40 p-4">
                    <p className="text-xs text-muted-foreground mb-1">Your Override Accuracy</p>
                    <p className="text-2xl font-bold text-emerald-400" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                      {calibration.editorAccuracy}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">avg drift: {calibration.avgEditorDrift} pts from true score</p>
                  </div>
                  <div className="rounded-xl border border-border bg-card/40 p-4">
                    <p className="text-xs text-muted-foreground mb-1">AI Base Score Accuracy</p>
                    <p className="text-2xl font-bold text-blue-400" style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                      {calibration.aiAccuracy}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">avg drift: {calibration.avgAiDrift} pts from true score</p>
                  </div>
                  <div className="rounded-xl border border-border bg-card/40 p-4">
                    <p className="text-xs text-muted-foreground mb-1">Your Override Win Rate</p>
                    <p className={cn(
                      "text-2xl font-bold",
                      (calibration.editorWinRate ?? 0) >= 60 ? "text-emerald-400" : (calibration.editorWinRate ?? 0) >= 40 ? "text-amber-400" : "text-red-400"
                    )} style={{ fontFamily: "Space Grotesk, sans-serif" }}>
                      {calibration.editorWinRate}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">of {calibration.matchedCount} matched posts</p>
                  </div>
                </div>

                {/* Insight banner */}
                <div className={cn(
                  "rounded-xl border p-4 flex items-start gap-3",
                  (calibration.editorWinRate ?? 0) >= 60
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : (calibration.editorWinRate ?? 0) >= 40
                    ? "border-amber-500/20 bg-amber-500/5"
                    : "border-blue-500/20 bg-blue-500/5"
                )}>
                  {(calibration.editorWinRate ?? 0) >= 60
                    ? <CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                    : <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />}
                  <div>
                    <p className="text-sm font-semibold text-foreground mb-0.5">
                      {(calibration.editorWinRate ?? 0) >= 60
                        ? "Your overrides are beating the AI"
                        : (calibration.editorWinRate ?? 0) >= 40
                        ? "Your overrides and the AI are roughly equal"
                        : "The AI base score is currently more accurate than your overrides"}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {(calibration.editorWinRate ?? 0) >= 60
                        ? "Your editorial instincts are consistently closer to the true Instagram performance than the AI's initial score. Keep overriding with confidence."
                        : (calibration.editorWinRate ?? 0) >= 40
                        ? "Your overrides and the AI are performing similarly. The blended score is using both signals equally."
                        : "The AI's rule-based score has been closer to actual Instagram performance in more cases. Consider trusting the AI score more on stories where you're unsure."}
                    </p>
                  </div>
                </div>

                {/* Category breakdown */}
                {calibration.categoryInsights && calibration.categoryInsights.length > 0 && (
                  <div className="rounded-xl border border-border bg-card/40 p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                      <BarChart2 className="w-4 h-4 text-muted-foreground" />
                      Override Accuracy by Category
                    </h3>
                    <p className="text-xs text-muted-foreground mb-4">Lower drift = your overrides in this category are more accurate. Higher drift = the AI's original score was closer.</p>
                    <div className="space-y-2">
                      {calibration.categoryInsights.map((cat: { category: string; avgDrift: number; count: number }) => (
                        <div key={cat.category} className="flex items-center gap-3">
                          <div className="w-36 shrink-0">
                            <p className="text-xs font-medium text-foreground truncate">{cat.category}</p>
                            <p className="text-[10px] text-muted-foreground">{cat.count} posts</p>
                          </div>
                          <div className="flex-1">
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  cat.avgDrift <= 10 ? "bg-emerald-500" : cat.avgDrift <= 20 ? "bg-amber-500" : "bg-red-500"
                                )}
                                style={{ width: `${Math.min(100, cat.avgDrift * 2)}%` }}
                              />
                            </div>
                          </div>
                          <div className="w-20 text-right shrink-0">
                            <span className={cn(
                              "text-xs font-semibold",
                              cat.avgDrift <= 10 ? "text-emerald-400" : cat.avgDrift <= 20 ? "text-amber-400" : "text-red-400"
                            )}>
                              {cat.avgDrift <= 10 ? "Accurate" : cat.avgDrift <= 20 ? "Moderate" : "High drift"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent matched posts */}
                {calibration.recentMatches && calibration.recentMatches.length > 0 && (
                  <div className="rounded-xl border border-border bg-card/40 p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-3">Recent Matched Posts</h3>
                    <p className="text-xs text-muted-foreground mb-4">Stories where we could match your override to a logged Instagram post and compare against true performance.</p>
                    <div className="space-y-2">
                      {calibration.recentMatches.map((m: { title: string; category: string; aiScore: number; overrideScore: number; trueScore: number; editorWon: boolean }, i: number) => (
                        <div key={i} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">{m.title}</p>
                            <p className="text-[10px] text-muted-foreground">{m.category}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 text-xs">
                            <span className="text-muted-foreground">AI: <span className="text-foreground font-medium">{m.aiScore}</span></span>
                            <span className="text-muted-foreground">Override: <span className="text-foreground font-medium">{m.overrideScore}</span></span>
                            <span className="text-muted-foreground">True: <span className="text-amber-400 font-medium">{m.trueScore}</span></span>
                            <span className={cn(
                              "text-[10px] px-1.5 py-0.5 rounded-full border font-medium",
                              m.editorWon ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" : "border-blue-500/30 text-blue-400 bg-blue-500/10"
                            )}>
                              {m.editorWon ? "You won" : "AI won"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Cost Control Tab */}
        {activeTab === "cost" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-start gap-3">
                <Zap className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-300 mb-1">Token Usage Control</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    All toggles below are <strong className="text-foreground">OFF by default</strong> — meaning the site runs for free. Article writing always uses tokens (unavoidable). Everything else is optional.
                  </p>
                </div>
              </div>
            </div>
            {loadingCost ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-3">
                {([
                  {
                    key: "llmScoringEnabled" as const,
                    label: "LLM Story Scoring",
                    desc: "Use AI to score stories on ingest. OFF = free rule-based scoring + your learned adjustments (recommended).",
                    cost: "~1 token call per story ingested",
                    value: costConfig?.llmScoringEnabled ?? false,
                  },
                  {
                    key: "autoPerfAnalysisEnabled" as const,
                    label: "Auto Deep Performance Analysis",
                    desc: "Run AI analysis of your historical posts automatically after each upload. OFF = free statistical analysis only.",
                    cost: "~1 token call per post upload",
                    value: costConfig?.autoPerfAnalysisEnabled ?? false,
                  },
                  {
                    key: "autoKeywordRegenEnabled" as const,
                    label: "Auto Keyword Feed Regeneration",
                    desc: "Automatically regenerate RSS keyword feeds after every 5 good/amazing ratings. OFF = manual only.",
                    cost: "~1 token call per 5 ratings",
                    value: costConfig?.autoKeywordRegenEnabled ?? false,
                  },
                  {
                    key: "autoDeepLearnEnabled" as const,
                    label: "Auto Deep Learn from Overrides",
                    desc: "Run AI analysis of your score overrides in the background (max once per 30 min). OFF = free statistical learning only.",
                    cost: "~1 token call per 30 min (when overrides exist)",
                    value: costConfig?.autoDeepLearnEnabled ?? false,
                  },
                ] as const).map(({ key, label, desc, cost, value }) => (
                  <div key={key} className={cn(
                    "rounded-xl border p-4 flex items-start gap-4 transition-colors",
                    value ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/30"
                  )}>
                    <button
                      onClick={() => setCost.mutate({ [key]: !value })}
                      disabled={setCost.isPending}
                      className="mt-0.5 shrink-0"
                    >
                      {value
                        ? <ToggleRight className="w-6 h-6 text-amber-400" />
                        : <ToggleLeft className="w-6 h-6 text-muted-foreground" />
                      }
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-foreground">{label}</p>
                        <span className={cn(
                          "text-[10px] font-medium px-1.5 py-0.5 rounded-full border",
                          value ? "border-amber-500/40 text-amber-400 bg-amber-500/10" : "border-green-500/30 text-green-400 bg-green-500/8"
                        )}>
                          {value ? "USES TOKENS" : "FREE"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-1.5">{desc}</p>
                      <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                        <Zap className="w-2.5 h-2.5" />{cost}
                      </p>
                    </div>
                  </div>
                ))}
                <div className="rounded-xl border border-border bg-card/30 p-4">
                  <p className="text-xs font-semibold text-foreground mb-1 flex items-center gap-2">
                    <ZapOff className="w-3.5 h-3.5 text-muted-foreground" /> Always Free (no toggle needed)
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-1 mt-2">
                    <li>RSS feed fetching — just HTTP requests</li>
                    <li>Rule-based story scoring + your learned stat adjustments</li>
                    <li>Statistical learning from overrides (instant, on every save)</li>
                    <li>Article style learning from uploaded articles (text analysis)</li>
                    <li>Performance learning from likes/views (pure maths)</li>
                    <li>Image search — regex entity extraction + Wikimedia/Pexels API</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </FlightLayout>
  );
}
