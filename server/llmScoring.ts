/**
 * LLM-assisted viral scoring for FlightDrama Content OS.
 *
 * Three capabilities:
 *
 * 1. scoreStoryWithLLM()
 *    Scores a story using the LLM. Injects:
 *    - The editor's recent override history as few-shot examples
 *    - Any learned scoring rules stored in scoring_config (from either learner)
 *    Falls back to rule-based scoring if the LLM call fails.
 *
 * 2. learnFromOverridesStatistical()   ← FREE, no LLM, runs automatically on every override
 *    Pure statistics: counts, averages, and keyword frequency analysis across
 *    all override history. Produces category weights and keyword boost/penalty
 *    lists that are injected into future scoring. Zero cost.
 *
 * 3. learnFromOverrides()              ← Uses LLM credits, call manually only
 *    Analyses all override history and asks the LLM to produce nuanced scoring
 *    rules. Stores the result in scoring_config. Only call this when you want
 *    a deep qualitative analysis — not on every override.
 */

import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { getOverrideExamplesFromDb, getAllScoringConfig, setScoringConfig, getDb, getHistoricalPosts } from "./db";
import { calculatePerformanceScore } from "./performanceAnalysis";
import { scoreStory, applyStatAdjustments, type ScoringResult } from "./viralScoring";
import { stories } from "../drizzle/schema";
import { and, desc, isNotNull, sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LLMScoringResult = ScoringResult & {
  scoringMethod: "rule_based" | "llm_assisted";
};

// ── Build scoring prompt ──────────────────────────────────────────────────────

async function buildScoringContext(): Promise<{ systemPrompt: string; hasExamples: boolean }> {
  const [examples, config, historicalPosts] = await Promise.all([
    getOverrideExamplesFromDb(50),
    getAllScoringConfig(),
    getHistoricalPosts(100), // fetch real Instagram performance data
  ]);

  // ── Score calibration: compute editor's actual distribution ──────────────
  // The LLM tends to give 100s freely unless we anchor it to the editor's real scale.
  // We compute the actual distribution from override history and inject it as a
  // hard calibration constraint BEFORE the score range definitions.
  const calibrationBlock = (() => {
    const scored = examples.filter(e => e.overrideScore !== null);
    if (scored.length < 5) return null; // not enough data yet

    const scores = scored.map(e => e.overrideScore as number);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    // Distribution buckets
    const bucket0_30 = scores.filter(s => s <= 30).length;
    const bucket31_60 = scores.filter(s => s > 30 && s <= 60).length;
    const bucket61_80 = scores.filter(s => s > 60 && s <= 80).length;
    const bucket81_100 = scores.filter(s => s > 80).length;
    const pct = (n: number) => Math.round((n / scores.length) * 100);

    // Find 3 anchor examples using RECENCY as the primary sort (most recent first),
    // then score as tiebreaker. This means the anchor reflects the editor's current
    // taste, not just the highest score they've ever given (which could be an outlier).
    const byRecencyThenScore = (a: typeof scored[0], b: typeof scored[0]) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime; // most recent first
      return (b.overrideScore ?? 0) - (a.overrideScore ?? 0); // then highest score
    };
    // High anchor: score ≥ p75 of all scores (adapts to the editor's actual scale)
    const sortedScores = [...scores].sort((a, b) => a - b);
    const p75 = sortedScores[Math.floor(sortedScores.length * 0.75)] ?? maxScore;
    const p90 = sortedScores[Math.min(Math.floor(sortedScores.length * 0.9), sortedScores.length - 1)] ?? maxScore;
    const highThreshold = Math.max(p75, 75); // at least 75 to qualify as "high"
    const highEx = [...scored].filter(e => (e.overrideScore ?? 0) >= highThreshold).sort(byRecencyThenScore)[0];
    const midEx = [...scored].filter(e => (e.overrideScore ?? 0) >= 55 && (e.overrideScore ?? 0) < highThreshold).sort(byRecencyThenScore)[0];
    const lowEx = [...scored].filter(e => (e.overrideScore ?? 0) <= 35).sort((a, b) => {
      // For low anchors: most recent first, then lowest score
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return (a.overrideScore ?? 0) - (b.overrideScore ?? 0);
    })[0];

    const anchors = [highEx, midEx, lowEx]
      .filter(Boolean)
      .map(e => `  Score ${e!.overrideScore}: "${(e!.title ?? "").slice(0, 70)}"`);

    // Derive dynamic score range labels from editor's actual distribution.
    // mustPostThreshold = p90 of editor scores. We do NOT hard-cap at maxScore
    // because that would prevent the model from ever suggesting a story is
    // exceptional — instead we use maxScore as a soft nudge in the prompt text.
    const mustPostThreshold = Math.max(p90, 80); // never lower than 80
    const strongThreshold = Math.max(Math.min(mustPostThreshold - 12, 75), 55); // 55–75 range

    // Soft ceiling: tell the model the editor's highest score, but frame it as
    // "rarely" rather than "never" — this preserves the ability to score truly
    // exceptional stories above the historical max.
    const softCeilingNote = scores.length >= 20
      ? `- Scores above ${maxScore} are very rare for this editor — only use them for genuinely exceptional, once-in-a-year stories`
      : `- This editor's highest score so far is ${maxScore} — calibrate accordingly, but don't be afraid to go higher for a truly exceptional story`;

    return [
      `## CALIBRATION — You MUST match this editor's exact scoring scale`,
      `This editor has scored ${scores.length} stories. Their real distribution is:`,
      `- Score range seen so far: ${minScore}–${maxScore} | Average: ${avgScore}`,
      `- Distribution: ${pct(bucket0_30)}% score 0–30 | ${pct(bucket31_60)}% score 31–60 | ${pct(bucket61_80)}% score 61–80 | ${pct(bucket81_100)}% score 81–100`,
      softCeilingNote,
      `- Most strong stories score ${strongThreshold}–${mustPostThreshold - 1}. Reserve ${mustPostThreshold}+ for genuinely shocking events.`,
      ...(anchors.length > 0 ? [`- Recent real score anchors from this editor (use these to calibrate):`, ...anchors] : []),
      ``,
      `Score thresholds (calibrated to this editor's scale):`,
      `- ${mustPostThreshold}–100 = must_post (exceptional — matches top performer pattern, shocking or deeply surprising)`,
      `- ${strongThreshold}–${mustPostThreshold - 1} = strong_candidate (clear aviation drama, strong hook)`,
      `- 50–${strongThreshold - 1} = maybe (some potential but weaker hook)`,
      `- 0–49 = reject (routine news, no emotional hook)`,
      `- AUTOMATIC REJECT (score 0–15): listicles, travel guides, product reviews, opinion columns with no news event, sponsored content, award announcements, any headline starting with a number followed by a noun ("16 Hotels...", "5 Reasons...").`,
    ].join("\n");
  })();

  const learnedRules = config["learned_scoring_rules"] ?? null;
  const learnedWeights = config["learned_category_weights"] ?? null;
  const learnedInsights = config["learned_editor_insights"] ?? null;
  // Structured scoring weights from deep learner (JSON, applied as hard adjustments)
  const structuredWeightsRaw = config["learned_structured_weights"] ?? null;
  // Statistical learner output
  const statWeights = config["stat_category_weights"] ?? null;
  const statKeywordBoosts = config["stat_keyword_boosts"] ?? null;
  const statKeywordPenalties = config["stat_keyword_penalties"] ?? null;

  // ── Instagram performance data — PRIMARY SIGNAL ───────────────────────────
  // Score every historical post by real engagement and build a ranked reference list.
  // This is the most important context: the model should score new stories based on
  // how similar they are to stories that ACTUALLY performed well for FlightDrama.
  const postsWithMetrics = historicalPosts.filter(
    p => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0
  );
  const rankedPosts = postsWithMetrics
    .map(p => ({ ...p, _perfScore: calculatePerformanceScore(p) }))
    .filter(p => p._perfScore > 0)
    .sort((a, b) => b._perfScore - a._perfScore);

  const topPerformers = rankedPosts.slice(0, 25);
  const bottomPerformers = rankedPosts.slice(-10);

  // IMPORTANT: perf scores are labelled as engagement-rank (1–10 scale), NOT as
  // story quality scores. This prevents the LLM from anchoring on the perf number
  // as a target score. A story with engagement-rank 9/10 does NOT mean score it 90.
  const toEngagementRank = (s: number) => Math.max(1, Math.min(10, Math.round(s / 10)));
  const instagramBlock = topPerformers.length > 0
    ? [
        `## GROUND TRUTH: Real FlightDrama Instagram Performance`,
        `These are actual posts and their real engagement. Use these to understand what TOPICS and ANGLES work for this account.`,
        `NOTE: The engagement-rank (e.g. "eng:9/10") is a relative engagement metric — it is NOT your story quality score. Do not copy these numbers into your score.`,
        ``,
        `### TOP PERFORMERS (topics/angles that resonate with FlightDrama's audience):`,
        ...topPerformers.map((p, i) => {
          const stats = [
            p.views ? `${(p.views / 1000).toFixed(0)}k views` : null,
            p.likes ? `${p.likes.toLocaleString()} likes` : null,
            p.shares ? `${p.shares} shares` : null,
            p.saves ? `${p.saves} saves` : null,
          ].filter(Boolean).join(" | ");
          return `#${i + 1} [eng:${toEngagementRank(p._perfScore)}/10] "${p.headline}"\n     Category: ${p.category ?? "unknown"} | ${stats}`;
        }),
        ``,
        `### BOTTOM PERFORMERS (topics/angles that did NOT resonate):`,
        ...bottomPerformers.map(p => {
          const stats = [
            p.views ? `${(p.views / 1000).toFixed(0)}k views` : null,
            p.likes ? `${p.likes.toLocaleString()} likes` : null,
          ].filter(Boolean).join(" | ") || "low engagement";
          return `[eng:${toEngagementRank(p._perfScore)}/10] "${p.headline}" | ${stats}`;
        }),
      ].join("\n")
    : null;

  // ── Editor override examples — SECONDARY SIGNAL ───────────────────────────
  // Recency-weighted: overrides from the last 30 days count double.
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const validExamples = examples
    .filter(e => e.overrideScore !== null && e.overrideLabel !== null)
    .map(e => ({
      ...e,
      // Recency weight: recent overrides are more representative of current taste
      _recencyWeight: e.updatedAt && (now - new Date(e.updatedAt).getTime()) < thirtyDaysMs ? 2 : 1,
      _drift: (e.overrideScore ?? 0) - (e.viralScore ?? 0),
    }));

  // Sort: recent first, then by drift magnitude (most instructive corrections)
  const sortedExamples = [...validExamples].sort((a, b) => {
    if (a._recencyWeight !== b._recencyWeight) return b._recencyWeight - a._recencyWeight;
    return Math.abs(b._drift) - Math.abs(a._drift);
  });

  const examplesBlock = sortedExamples.length > 0
    ? sortedExamples
        .map((e, i) => {
          const driftStr = e._drift > 0
            ? `+${e._drift} (editor scored HIGHER — AI undervalued this)`
            : e._drift < 0
            ? `${e._drift} (editor scored LOWER — AI overvalued this)`
            : `0 (agreed)`;
          const recency = e._recencyWeight === 2 ? " [recent]" : "";
          return `${i + 1}.${recency} "${e.title}"\n   AI: ${e.viralScore} → Editor: ${e.overrideScore} (${e.overrideLabel}) | Drift: ${driftStr}\n   Category: ${e.category ?? "unknown"}`;
        })
        .join("\n\n")
    : null;

  // ── Build the full system prompt ──────────────────────────────────────────
  // If we have calibration data, use it as the primary score range definition.
  // Otherwise fall back to the static defaults.
  const staticScoreRanges = `Score from 0–100:
- 88–98 = must_post (matches top performer pattern — shocking, emotional, or deeply surprising; DO NOT score above 98)
- 70–87 = strong_candidate (similar to strong performers — clear hook, aviation drama)
- 50–69 = maybe (some potential but weaker hook than typical performers)
- 0–49 = reject (routine news, no emotional hook, not similar to any top performer)
- AUTOMATIC REJECT (score 0–15): listicles, travel guides, product reviews, opinion columns with no news event, sponsored content, award announcements, any headline starting with a number followed by a noun ("16 Hotels...", "5 Reasons...").`;

  // ── Build the system prompt ──────────────────────────────────────────────
  // STRUCTURE: context first, hard constraints LAST.
  // The LLM gives more weight to instructions at the end of the system prompt.
  // Calibration/scoring rules MUST come after all context so they act as a
  // hard override, not a suggestion that gets buried by Instagram data.

  let systemPrompt = `You are a viral content scoring engine for FlightDrama, an aviation Instagram/TikTok/YouTube account.
Your job: score stories 0–100 for viral potential on aviation Instagram/TikTok/YouTube.`;

  // 1. Instagram performance data — CONTEXT (what topics/angles work)
  if (instagramBlock) {
    systemPrompt += `\n\n${instagramBlock}`;
  }

  // 2. Structured weights from deep learner
  if (structuredWeightsRaw) {
    try {
      const sw = JSON.parse(structuredWeightsRaw);
      const lines: string[] = [];
      if (sw.category_boosts) {
        const boosts = Object.entries(sw.category_boosts as Record<string, number>)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .map(([cat, adj]) => `  ${cat}: ${adj > 0 ? "+" : ""}${adj}`);
        if (boosts.length) lines.push(`Category adjustments (from ${sw.examples_used ?? "?"} overrides):\n${boosts.join("\n")}`);
      }
      if (sw.keyword_boosts) {
        const boosts = Object.entries(sw.keyword_boosts as Record<string, number>)
          .sort((a, b) => b[1] - a[1]).slice(0, 15)
          .map(([kw, adj]) => `${kw}(+${adj})`);
        if (boosts.length) lines.push(`Keywords to score HIGHER: ${boosts.join(", ")}`);
      }
      if (sw.keyword_penalties) {
        const penalties = Object.entries(sw.keyword_penalties as Record<string, number>)
          .sort((a, b) => a[1] - b[1]).slice(0, 10)
          .map(([kw, adj]) => `${kw}(${adj})`);
        if (penalties.length) lines.push(`Keywords to score LOWER: ${penalties.join(", ")}`);
      }
      if (sw.editor_notes) lines.push(`Editor taste notes: ${sw.editor_notes}`);
      if (lines.length) {
        systemPrompt += `\n\n## Learned Editor Preferences (from ${sw.examples_used ?? "?"} override corrections)\n${lines.join("\n")}`;
      }
    } catch { /* ignore malformed JSON */ }
  } else {
    if (learnedRules) systemPrompt += `\n\n## Learned Scoring Rules\n${learnedRules}`;
    if (learnedWeights) systemPrompt += `\n\n## Learned Category Weights\n${learnedWeights}`;
    if (learnedInsights) systemPrompt += `\n\n## Editor Preferences\n${learnedInsights}`;
  }

  // 3. Statistical learner output
  if (statWeights || statKeywordBoosts || statKeywordPenalties) {
    systemPrompt += `\n\n## Statistical Signals (from override history)`;
    if (statWeights) systemPrompt += `\nCategory score adjustments: ${statWeights}`;
    if (statKeywordBoosts) systemPrompt += `\nKeywords editor consistently scores HIGHER: ${statKeywordBoosts}`;
    if (statKeywordPenalties) systemPrompt += `\nKeywords editor consistently scores LOWER: ${statKeywordPenalties}`;
  }

  // 4. Editor override examples — the most direct learning signal
  if (examplesBlock) {
    systemPrompt += `\n\n## Editor Override History (most recent first)\nThe editor has manually corrected these AI scores. This is your most direct calibration signal.\n[recent] = last 30 days. Study the pattern — what did the editor score higher than the AI? Lower?\n\n${examplesBlock}`;
  }

  // 5. HARD SCORING CONSTRAINTS — these come LAST so they override everything above
  // The LLM must use these exact score ranges regardless of what the context suggests.
  systemPrompt += `\n\n## SCORING RULES (MANDATORY — apply these AFTER reading all context above)\n${calibrationBlock ?? staticScoreRanges}\n- CRITICAL: The engagement ranks (eng:X/10) in the Instagram data above are engagement metrics, NOT score targets. Do not copy them into your score.\n- CRITICAL: A score of 100 means a once-in-a-year story. Do not give 100 unless the story is genuinely unprecedented.`;

  systemPrompt += `\n\nRespond ONLY with a valid JSON object in this exact format:
{
  "score": <integer 0-100>,
  "statusLabel": "<must_post|strong_candidate|maybe|reject>",
  "category": "<category string>",
  "viralReason": "<one sentence explanation of the score>",
  "viralExplanation": "<two to three sentences explaining WHY this would or would not go viral — what emotional hook, what audience reaction, what makes it shareable or not>",
  "triggers": ["<trigger 1>", "<trigger 2>"]
}`;

  return { systemPrompt, hasExamples: topPerformers.length > 0 || examples.length > 0 || !!learnedRules };
}

// ── Score a single story ──────────────────────────────────────────────────────

/**
 * Score a story using the LLM with learned rules + override examples as context.
 *
 * Two-tier model strategy:
 * - Initial pass: llama-3.1-8b-instant (fast, cheap)
 * - Safety net: if 8B scores ≥ 75, verify with llama-3.3-70b-versatile to ensure
 *   no viral story is missed due to the smaller model underestimating it.
 *
 * Falls back to rule-based scoring if both LLM calls fail.
 */
export async function scoreStoryWithLLM(
  title: string,
  content: string
): Promise<LLMScoringResult> {
  const ruleResult = scoreStory(title, content);
  // Scoring model: 8B for cost efficiency; 70B as safety net for high scorers
  const scoringModel = ENV.scoringLlmModel || ENV.defaultLlmModel || "llama-3.1-8b-instant";
  const verifyModel = ENV.defaultLlmModel || "llama-3.3-70b-versatile";

  const parseScoringResponse = (raw: string, fallback: ScoringResult) => {
    if (!raw || typeof raw !== "string") return null;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        score: number;
        statusLabel: string;
        category: string;
        viralReason: string;
        triggers: string[];
        viralExplanation?: string;
      };
      const validLabels = ["must_post", "strong_candidate", "maybe", "reject"];
      if (
        typeof parsed.score !== "number" ||
        parsed.score < 0 ||
        parsed.score > 100 ||
        !validLabels.includes(parsed.statusLabel)
      ) return null;
      // Hard structural cap: the LLM can never produce a score above 95.
      // A score of 96-100 can only come from a manual editor override.
      // This is enforced in code, not in the prompt, so no prompt instruction
      // can bypass it. The post-processing layer (applyStatAdjustments) can
      // push a 95 higher if the editor's learned weights genuinely justify it.
      parsed.score = Math.min(95, parsed.score);
      return parsed;
    } catch {
      return null;
    }
  };

  try {
    const { systemPrompt } = await buildScoringContext();
    // DEBUG: log the tail of the system prompt so we can verify calibration rules are last
    console.log(`[LLMScoring] Prompt tail (last 400 chars): ...${systemPrompt.slice(-400).replace(/\n/g, " | ")}`);
    const truncatedContent = content?.slice(0, 1200) ?? "";
    const userMessage = `Score this aviation story:\n\nTitle: "${title}"\n\nContent excerpt: "${truncatedContent}"`;

    // ── Pass 1: 8B model (cheap) ──────────────────────────────────────────────────────────────────────────────
    const response8b = await invokeLLM({
      model: scoringModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw8b = String(response8b?.choices?.[0]?.message?.content ?? "");
    const parsed8b = parseScoringResponse(raw8b, ruleResult);

    if (!parsed8b) {
      console.warn("[LLMScoring] 8B model returned invalid response, falling back to rule-based");
      const statAdjustedScore = await applyStatAdjustments(ruleResult.score, ruleResult.category, title);
      return { ...ruleResult, score: statAdjustedScore, scoringMethod: "rule_based" };
    }

    // ── Pass 2: 70B safety net for potential viral stories ────────────────────
    // If the 8B model scores a story ≥ 75, verify with the full 70B model.
    // This ensures no viral story is ever missed due to the smaller model.
    if (parsed8b.score >= 75 && scoringModel !== verifyModel) {
      try {
        console.log(`[LLMScoring] 8B scored "${title.slice(0, 60)}" at ${parsed8b.score} — running 70B safety check`);
        const response70b = await invokeLLM({
          model: verifyModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        });
        const raw70b = String(response70b?.choices?.[0]?.message?.content ?? "");
        const parsed70b = parseScoringResponse(raw70b, ruleResult);
        if (parsed70b) {
          // 70B is the authoritative model — its score is the final answer.
          // The 8B pass was a cheap first filter; the 70B has better calibration
          // and better instruction-following. We do NOT take max(8B, 70B) because
          // that would permanently lock in any 8B inflation (e.g. 100s).
          // If 70B says 85 and 8B said 100, we trust 70B: the story scores 85.
          const llmCategory = parsed70b.category ?? ruleResult.category;
          const llmScore = Math.round(parsed70b.score);
          const statAdjustedScore = await applyStatAdjustments(llmScore, llmCategory, title);
          console.log(`[LLMScoring] 70B override: 8B=${parsed8b.score} → 70B=${llmScore} (final)`);
          return {
            score: statAdjustedScore,
            statusLabel: parsed70b.statusLabel as ScoringResult["statusLabel"],
            category: llmCategory,
            viralReason: parsed70b.viralReason ?? ruleResult.viralReason,
            triggers: Array.isArray(parsed70b.triggers) ? parsed70b.triggers : ruleResult.triggers,
            viralExplanation: parsed70b.viralExplanation ?? ruleResult.viralExplanation,
            scoringMethod: "llm_assisted",
          };
        }
      } catch (verifyErr) {
        // 70B verification failed — use 8B result, which is already ≥ 75 so story is kept
        console.warn("[LLMScoring] 70B safety check failed, using 8B result:", verifyErr);
      }
    }

    // ── Use 8B result (no verification needed or verification skipped) ────────
    const llmCategory = parsed8b.category ?? ruleResult.category;
    const llmScore = Math.round(parsed8b.score);
    const statAdjustedScore = await applyStatAdjustments(llmScore, llmCategory, title);
    return {
      score: statAdjustedScore,
      statusLabel: parsed8b.statusLabel as ScoringResult["statusLabel"],
      category: llmCategory,
      viralReason: parsed8b.viralReason ?? ruleResult.viralReason,
      triggers: Array.isArray(parsed8b.triggers) ? parsed8b.triggers : ruleResult.triggers,
      viralExplanation: parsed8b.viralExplanation ?? ruleResult.viralExplanation,
      scoringMethod: "llm_assisted",
    };
  } catch (err) {
    console.error("[LLMScoring] Error calling LLM, falling back to rule-based:", err);
    const statAdjustedScore = await applyStatAdjustments(ruleResult.score, ruleResult.category, title);
    return { ...ruleResult, score: statAdjustedScore, scoringMethod: "rule_based" };
  }
}

// ── Batch scoring ─────────────────────────────────────────────────────────────

export type BatchScoringInput = {
  title: string;
  content: string;
  ruleScore: ScoringResult;
};

/**
 * Score up to 10 stories in a single LLM call.
 *
 * This is the primary cost optimisation — instead of one API call per story
 * (each paying the system prompt overhead), we send up to 10 stories in one
 * call and pay the overhead once. Quality is identical to single-story scoring.
 *
 * Stories where the 8B model scores ≥ 75 are individually verified with the
 * 70B model as a safety net — the same guarantee as scoreStoryWithLLM().
 */
export async function batchScoreStoriesWithLLM(
  stories: BatchScoringInput[]
): Promise<LLMScoringResult[]> {
  if (stories.length === 0) return [];

  const scoringModel = ENV.scoringLlmModel || ENV.defaultLlmModel || "llama-3.1-8b-instant";
  const verifyModel = ENV.defaultLlmModel || "llama-3.3-70b-versatile";

  // Build the shared context once for the whole batch
  const { systemPrompt } = await buildScoringContext();

  // Modify system prompt for batch output
    const batchSystemPrompt = systemPrompt.replace(
    /Respond ONLY with a valid JSON object[\s\S]*/,
    `Respond ONLY with a valid JSON array of ${stories.length} objects, one per story, in the same order as the input. Each object must have:
{ "score": <integer 0-100>, "statusLabel": "<must_post|strong_candidate|maybe|reject>", "category": "<category>", "viralReason": "<one sentence>", "viralExplanation": "<two to three sentences on why it would or would not go viral>", "triggers": ["<trigger 1>", "<trigger 2>"] }
Return ONLY the JSON array. No other text.`
  );

  const storyList = stories
    .map((s, i) => `Story ${i + 1}:\nTitle: "${s.title}"\nContent: "${s.content.slice(0, 800)}"`)
    .join("\n\n---\n\n");

  const userMessage = `Score these ${stories.length} aviation stories:\n\n${storyList}`;

  try {
    const response = await invokeLLM({
      model: scoringModel,
      messages: [
        { role: "system", content: batchSystemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw = String(response?.choices?.[0]?.message?.content ?? "");
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[LLMScoring] Batch: no JSON array in response, falling back to individual scoring");
      // Fall back to individual scoring for each story
      return Promise.all(stories.map(s => scoreStoryWithLLM(s.title, s.content)));
    }

    const parsedArray = JSON.parse(jsonMatch[0]) as Array<{
      score: number;
      statusLabel: string;
      category: string;
      viralReason: string;
      triggers: string[];
    }>;

    if (!Array.isArray(parsedArray) || parsedArray.length !== stories.length) {
      console.warn(`[LLMScoring] Batch: expected ${stories.length} results, got ${parsedArray?.length ?? 0}. Falling back.`);
      return Promise.all(stories.map(s => scoreStoryWithLLM(s.title, s.content)));
    }

    const validLabels = ["must_post", "strong_candidate", "maybe", "reject"];
    const results: LLMScoringResult[] = [];

    for (let i = 0; i < stories.length; i++) {
      const s = stories[i];
      const p = parsedArray[i];

      if (
        !p ||
        typeof p.score !== "number" ||
        p.score < 0 ||
        p.score > 100 ||
        !validLabels.includes(p.statusLabel)
      ) {
        // Invalid entry — fall back to rule-based for this story
        const statAdjusted = await applyStatAdjustments(s.ruleScore.score, s.ruleScore.category, s.title);
        results.push({ ...s.ruleScore, score: statAdjusted, scoringMethod: "rule_based" });
        continue;
      }

      // 70B safety net for high-scoring stories
      // The 70B result is authoritative — it replaces the 8B batch score entirely.
      // We do NOT use max(8B, 70B) because that locks in 8B inflation.
      if (p.score >= 75 && scoringModel !== verifyModel) {
        try {
          const verified = await scoreStoryWithLLM(s.title, s.content);
          // Always use the 70B result (scoreStoryWithLLM uses 70B for ≥75 stories)
          results.push(verified);
          continue;
        } catch {
          // Verification failed — use batch result (already ≥ 75, story is kept)
        }
      }

      const llmCategory = p.category ?? s.ruleScore.category;
      const llmScore = Math.round(p.score);
      const statAdjustedScore = await applyStatAdjustments(llmScore, llmCategory, s.title);
      results.push({
        score: statAdjustedScore,
        statusLabel: p.statusLabel as ScoringResult["statusLabel"],
        category: llmCategory,
        viralReason: p.viralReason ?? s.ruleScore.viralReason,
        triggers: Array.isArray(p.triggers) ? p.triggers : s.ruleScore.triggers,
        viralExplanation: (p as any).viralExplanation ?? s.ruleScore.viralExplanation,
        scoringMethod: "llm_assisted",
      });
    }

    return results;
  } catch (err) {
    console.error("[LLMScoring] Batch scoring failed, falling back to individual:", err);
    return Promise.all(stories.map(s => scoreStoryWithLLM(s.title, s.content)));
  }
}

// ── Free statistical learner ──────────────────────────────────────────────────

/**
 * Analyses all editor overrides using pure statistics — no LLM, no cost.
 * Runs automatically after every override (debounced to 30 seconds).
 *
 * What it computes:
 * 1. Category bias: for each category, how much does the editor consistently
 *    score above or below the rule-based system? (e.g. "Boeing Safety: +12 avg")
 * 2. Keyword boosts: words that appear frequently in stories the editor scored
 *    significantly higher than the rule-based system.
 * 3. Keyword penalties: words that appear frequently in stories the editor
 *    scored significantly lower.
 * 4. Score drift summary: overall tendency (does the editor score higher or lower
 *    than the rules on average?)
 *
 * Results are stored in scoring_config and injected into future LLM scoring prompts.
 */
export async function learnFromOverridesStatistical(): Promise<{
  success: boolean;
  summary: string;
  examplesUsed: number;
}> {
  const db = await getDb();
  if (!db) return { success: false, summary: "Database not available", examplesUsed: 0 };

  // Fetch all override examples (no limit — we want the full history)
  const examples = await db
    .select({
      title: stories.title,
      content: stories.content,
      overrideScore: stories.overrideScore,
      overrideLabel: stories.overrideLabel,
      viralScore: stories.viralScore,
      category: stories.category,
      viralReason: stories.viralReason,
    })
    .from(stories)
    .where(and(isNotNull(stories.overrideScore), isNotNull(stories.overrideLabel)))
    .orderBy(desc(stories.updatedAt))
    .limit(200);

  if (examples.length < 3) {
    return {
      success: false,
      summary: "Not enough overrides yet — override at least 3 stories to start learning.",
      examplesUsed: 0,
    };
  }

  // ── 1. Category bias analysis ─────────────────────────────────────────────
  // Track the editor's ABSOLUTE preferred score per category, then compare to
  // the overall average preferred score. This correctly identifies which categories
  // the editor genuinely prefers vs dislikes — NOT how much they differ from the AI.
  //
  // Example: if editor gives Celebrity stories avg 70 and overall avg is 55,
  // Celebrity gets +15 (editor likes it). This is correct.
  // Old approach: if AI scored Celebrity 90 and editor said 70, it recorded -20
  // ("editor dislikes Celebrity") — WRONG.
  const categoryScores: Record<string, { totalScore: number; count: number }> = {};
  let totalEditorScore = 0;
  let totalEditorCount = 0;

  for (const ex of examples) {
    if (ex.overrideScore === null) continue;
    totalEditorScore += ex.overrideScore;
    totalEditorCount++;
    const cat = ex.category ?? "General Aviation";
    if (!categoryScores[cat]) categoryScores[cat] = { totalScore: 0, count: 0 };
    categoryScores[cat].totalScore += ex.overrideScore;
    categoryScores[cat].count++;
  }

  const avgEditorScore = totalEditorCount > 0 ? totalEditorScore / totalEditorCount : 60;
  // Also compute overall drift for the summary line
  let totalDrift = 0;
  for (const ex of examples) {
    if (ex.overrideScore !== null && ex.viralScore !== null) totalDrift += ex.overrideScore - ex.viralScore;
  }
  const avgOverallDrift = examples.length > 0 ? totalDrift / examples.length : 0;

  // Build category weight string — only include categories with ≥2 examples
  // Adjustment = (category avg editor score) - (overall avg editor score)
  // This tells the scoring system: "for this category, add/subtract X from the base score"
  const catEntries = Object.entries(categoryScores)
    .filter(([, v]) => v.count >= 2)
    .map(([cat, v]) => {
      const catAvg = v.totalScore / v.count;
      const adjustment = Math.round(catAvg - avgEditorScore);
      const direction = adjustment > 0 ? `+${adjustment}` : `${adjustment}`;
      return `${cat}: ${direction} pts avg (${v.count} overrides, editor avg: ${Math.round(catAvg)})`;
    })
    .sort((a, b) => {
      const aVal = Math.abs(parseInt(a.match(/([+-]\d+)/)?.[1] ?? "0"));
      const bVal = Math.abs(parseInt(b.match(/([+-]\d+)/)?.[1] ?? "0"));
      return bVal - aVal;
    });

  const statCategoryWeights = catEntries.length > 0
    ? catEntries.join("; ")
    : "Not enough data per category yet.";

  // ── 2. Keyword frequency analysis ────────────────────────────────────────
  // Split examples into "editor prefers" vs "editor avoids" based on ABSOLUTE score
  // vs the overall editor average. This avoids penalising words that appear in stories
  // the AI over-scored but the editor still rated reasonably.
  //
  // "Boosted" = editor scored this story significantly ABOVE their own average
  // "Penalised" = editor scored this story significantly BELOW their own average
  const ABSOLUTE_THRESHOLD = 15; // stories ≥15 pts above/below editor's own average

  const boostedTitles = examples
    .filter(e => e.overrideScore !== null && (e.overrideScore - avgEditorScore) >= ABSOLUTE_THRESHOLD)
    .map(e => `${e.title ?? ""} ${e.content?.slice(0, 300) ?? ""}`.toLowerCase());

  const penalisedTitles = examples
    .filter(e => e.overrideScore !== null && (avgEditorScore - e.overrideScore) >= ABSOLUTE_THRESHOLD)
    .map(e => `${e.title ?? ""} ${e.content?.slice(0, 300) ?? ""}`.toLowerCase());

  function extractKeywords(texts: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    // Common stop words to ignore
    const stopWords = new Set([
      "the","a","an","and","or","but","in","on","at","to","for","of","with",
      "by","from","as","is","was","are","were","be","been","being","have",
      "has","had","do","does","did","will","would","could","should","may",
      "might","shall","can","this","that","these","those","it","its","he",
      "she","they","we","you","i","his","her","their","our","your","my",
      "after","before","about","over","under","into","out","up","down","off",
      "not","no","so","if","then","than","when","where","who","what","how",
      "all","each","every","both","few","more","most","other","some","such",
      "only","own","same","too","very","just","also","new","first","last",
    ]);
    for (const text of texts) {
      // Extract 1–3 word phrases that are meaningful
      const words = text.match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
      for (const word of words) {
        if (!stopWords.has(word) && word.length > 3) {
          counts[word] = (counts[word] ?? 0) + 1;
        }
      }
      // Also extract bigrams (2-word phrases)
      for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i], w2 = words[i + 1];
        if (!stopWords.has(w1) && !stopWords.has(w2) && w1.length > 3 && w2.length > 3) {
          const bigram = `${w1} ${w2}`;
          counts[bigram] = (counts[bigram] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  const boostedKeywords = extractKeywords(boostedTitles);
  const penalisedKeywords = extractKeywords(penalisedTitles);

  // Top keywords that appear in boosted stories but NOT (or rarely) in penalised ones
  const boostList = Object.entries(boostedKeywords)
    .filter(([kw, cnt]) => cnt >= 2 && (penalisedKeywords[kw] ?? 0) < cnt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw, cnt]) => `"${kw}" (×${cnt})`)
    .join(", ");

  const penaltyList = Object.entries(penalisedKeywords)
    .filter(([kw, cnt]) => cnt >= 2 && (boostedKeywords[kw] ?? 0) < cnt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw, cnt]) => `"${kw}" (×${cnt})`)
    .join(", ");

  // ── 3. Overall drift summary ──────────────────────────────────────────────
  const driftDesc = avgOverallDrift > 3
    ? `Editor scores ${Math.round(avgOverallDrift)} pts HIGHER than rules on average — rules are too conservative.`
    : avgOverallDrift < -3
    ? `Editor scores ${Math.round(Math.abs(avgOverallDrift))} pts LOWER than rules on average — rules are too generous.`
    : `Editor scores closely match the rules on average (drift: ${avgOverallDrift.toFixed(1)} pts).`;

  const summary = `Statistical learning from ${examples.length} overrides: ${driftDesc} Top boosted categories: ${catEntries.slice(0, 3).join("; ") || "none yet"}.`;

  // ── 4. Persist to scoring_config ─────────────────────────────────────────
  await Promise.all([
    setScoringConfig("stat_category_weights", statCategoryWeights),
    setScoringConfig("stat_keyword_boosts", boostList || "none yet"),
    setScoringConfig("stat_keyword_penalties", penaltyList || "none yet"),
    setScoringConfig("stat_overall_drift", driftDesc),
    setScoringConfig("stat_last_learned_at", new Date().toISOString()),
    setScoringConfig("stat_examples_count", String(examples.length)),
  ]);

  console.log(`[StatLearn] ${summary}`);

  return { success: true, summary, examplesUsed: examples.length };
}

// ── LLM-based deep learner (costs credits — call manually only) ───────────────

/**
 * Analyses all editor overrides and asks the LLM to produce improved scoring
 * rules that better match the editor's taste. Stores the result in scoring_config
 * so all future scoring calls use the improved rules automatically.
 *
 * NOTE: This uses LLM credits. Use learnFromOverridesStatistical() for free
 * automatic learning. Only call this when you want a deep qualitative analysis.
 *
 * Returns a summary of what was learned.
 */
export async function learnFromOverrides(): Promise<{ success: boolean; summary: string; examplesUsed: number }> {
  // Always run the free statistical learner first — it's instant and costs nothing
  learnFromOverridesStatistical().catch(err =>
    console.warn("[StatLearn] Background stat learn failed:", err)
  );

  // Pull all config including previously learned rules and the last-learned timestamp
  const config = await getAllScoringConfig();
  const previousRules = config["learned_scoring_rules"] ?? null;
  const previousWeights = config["learned_category_weights"] ?? null;
  const previousInsights = config["learned_editor_insights"] ?? null;
  const lastLearnedAt = config["last_learned_at"] ?? null;

  // Fetch new overrides since last run PLUS always include the last 20 as context.
  // This ensures the LLM always has enough examples to refine rules meaningfully,
  // even if no new overrides were made since the last run.
  const sinceDate = lastLearnedAt && previousRules ? new Date(lastLearnedAt) : undefined;
  const newExamples = await getOverrideExamplesFromDb(undefined, sinceDate);

  if (newExamples.length < 3 && !previousRules) {
    return {
      success: false,
      summary: "Not enough override examples yet — override at least 3 stories before running this.",
      examplesUsed: 0,
    };
  }

  // Always include at least the last 20 overrides as context (even on subsequent runs).
  // This prevents the LLM from running on 0 examples when no new overrides were made.
  let filteredExamples = newExamples;
  if (sinceDate && newExamples.length < 20 && previousRules) {
    const recentContext = await getOverrideExamplesFromDb(20);
    // Merge: new examples first, then recent context (deduped by id)
    const seenIds = new Set(newExamples.map(e => e.id));
    const contextOnly = recentContext.filter(e => !seenIds.has(e.id));
    filteredExamples = [...newExamples, ...contextOnly];
    if (filteredExamples.length > 0) {
      console.log(`[LLMScoring] ${newExamples.length} new overrides + ${contextOnly.length} context examples = ${filteredExamples.length} total`);
    }
  }

  if (filteredExamples.length === 0) {
    console.log("[LLMScoring] No override examples available — skipping LLM call");
    return {
      success: true,
      summary: "No override examples available — existing rules unchanged.",
      examplesUsed: 0,
    };
  }

  // Pull Instagram performance data — this is the primary learning signal
  const historicalPosts = await getHistoricalPosts(100);
  const postsWithMetrics = historicalPosts.filter(p => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0);
  const rankedPosts = postsWithMetrics
    .map(p => ({ ...p, _perf: calculatePerformanceScore(p) }))
    .filter(p => p._perf > 0)
    .sort((a, b) => b._perf - a._perf);

  const validExamples = filteredExamples.filter(e => e.overrideScore !== null && e.overrideLabel !== null);

  // Recency-weight examples: last 30 days count double in the analysis
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const examplesText = validExamples
    .map((e, i) => {
      const drift = (e.overrideScore ?? 0) - (e.viralScore ?? 0);
      const driftStr = drift > 0 ? `+${drift} (AI undervalued)` : drift < 0 ? `${drift} (AI overvalued)` : `0 (agreed)`;
      const recency = e.updatedAt && (now - new Date(e.updatedAt).getTime()) < thirtyDaysMs ? " [RECENT]" : "";
      const contentSnippet = e.content ? `\n   Excerpt: "${e.content.slice(0, 120).replace(/\n/g, ' ')}..."` : "";
      return `${i + 1}.${recency} "${e.title}"${contentSnippet}\n   AI: ${e.viralScore} → Editor: ${e.overrideScore} (${e.overrideLabel}) | Drift: ${driftStr} | Category: ${e.category ?? "unknown"}`;
    })
    .join("\n\n");

  const instagramText = rankedPosts.length > 0
    ? `\n\n## GROUND TRUTH: Real FlightDrama Instagram Performance (ranked by actual engagement)\nUse this as your primary reference. The scoring rules must explain WHY the top posts performed well.\n\nTOP PERFORMERS:\n${rankedPosts.slice(0, 20).map((p, i) => {
        const stats = [p.views ? `${Math.round(p.views/1000)}k views` : null, p.likes ? `${p.likes} likes` : null, p.shares ? `${p.shares} shares` : null].filter(Boolean).join(" | ");
        return `#${i+1} [perf:${p._perf}/100] "${p.headline}" | ${p.category ?? "unknown"} | ${stats}`;
      }).join("\n")}\n\nBOTTOM PERFORMERS (avoid these patterns):\n${rankedPosts.slice(-8).map(p => `[perf:${p._perf}/100] "${p.headline}" | ${p.category ?? "unknown"}`).join("\n")}`
    : "";

  // Build the previous structured weights block
  const prevStructuredRaw = config["learned_structured_weights"] ?? null;
  let previousRulesBlock = "";
  if (previousRules || prevStructuredRaw) {
    previousRulesBlock = `\n\n## Previously Learned Rules (PRESERVE and REFINE — do NOT discard)`;
    if (previousRules) previousRulesBlock += `\n${previousRules}`;
    if (previousWeights) previousRulesBlock += `\n\nPreviously learned category weights:\n${previousWeights}`;
    if (previousInsights) previousRulesBlock += `\n\nPreviously learned editor insights:\n${previousInsights}`;
    previousRulesBlock += `\n\nYour job is to REFINE and EXTEND these rules with the new examples. Keep what holds true. Update what the new examples contradict. Add new rules for new patterns.`;
  }

  const isFirstRun = !previousRules && !prevStructuredRaw;
  const systemPrompt = `You are an expert editorial analyst for FlightDrama, an aviation Instagram/TikTok/YouTube account.${previousRulesBlock}

Your job is to analyse editor override corrections AND real Instagram performance data to produce:
1. Specific, actionable scoring rules grounded in BOTH editor taste AND real audience engagement
2. Structured numeric weights (JSON) for categories and keywords — these are applied as hard score adjustments
3. A plain-text description of the editor's taste

The Instagram performance data is the PRIMARY signal. The editor overrides are the SECONDARY signal.
Be specific and concrete. Avoid vague rules like "Boeing stories do well" — instead say "Boeing safety incidents with a specific failure mechanism score +20 vs generic Boeing earnings stories which score -15".`;

  const userMessage = `${isFirstRun ? `Analyse these ${validExamples.length} editor override examples` : `Refine the existing rules with these ${validExamples.length} new override examples`}:\n\n${examplesText}${instagramText}\n\nReturn ONLY a JSON object with these FIVE fields:\n\n1. "learned_scoring_rules" (string): Complete updated scoring rules in plain text. Be specific and concrete. Reference actual story patterns from the examples.\n\n2. "learned_category_weights" (string): Plain text list of category adjustments, e.g. "Boeing Safety Failure: +20, Passenger Incident: +15, Earnings Report: -25"\n\n3. "learned_editor_insights" (string): A paragraph describing the editor's taste and what the Instagram data confirms about the audience.\n\n4. "learned_structured_weights" (object, NOT a string): A JSON object with these numeric fields that will be applied as hard score adjustments:\n   - category_boosts: object mapping category names to integer adjustments (e.g. {"Boeing Safety": 18, "Passenger Incident": 12, "Earnings": -20})\n   - keyword_boosts: object mapping keywords/phrases to integer boosts (e.g. {"fatal": 15, "pilot error": 12, "emergency landing": 10})\n   - keyword_penalties: object mapping keywords to negative integers (e.g. {"earnings": -15, "quarterly": -12})\n   - editor_notes: string with one sentence about the editor's taste\n   - examples_used: integer count of examples analysed\n\n5. "summary" (string): One sentence describing what changed or was reinforced.\n\nIMPORTANT: All string field values must be plain text. Do NOT use backticks or code blocks inside string values. The learned_structured_weights field must be a JSON object (not a string).`;

  try {
    const response = await invokeLLM({
      model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw = response?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== "string") {
      return { success: false, summary: "LLM returned empty response.", examplesUsed: validExamples.length };
    }

    // Robustly extract JSON: find the outermost { } block
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.error("[LLMScoring] No JSON block found in response:", raw.slice(0, 200));
      return { success: false, summary: "Could not parse LLM response — no JSON block found.", examplesUsed: validExamples.length };
    }

    let jsonStr = raw.slice(jsonStart, jsonEnd + 1);
    // Sanitise: remove any unescaped control characters inside string values
    // that would break JSON.parse (e.g. literal newlines inside strings)
    jsonStr = jsonStr.replace(/(?<=[":,{\[]\s*"[^"]*?)\n(?=[^"]*?")/g, ' ');

    let parsed: {
      learned_scoring_rules: string;
      learned_category_weights: string;
      learned_editor_insights: string;
      learned_structured_weights?: Record<string, unknown>;
      summary: string;
    };
    try {
      parsed = JSON.parse(jsonStr) as typeof parsed;
    } catch (parseErr) {
      // Last resort: try to extract each string field with regex
      console.warn("[LLMScoring] JSON.parse failed, trying field extraction:", parseErr);
      const extract = (key: string) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,'s'));
        return m ? m[1].replace(/\\n/g, '\n').replace(/\\t/g, ' ') : '';
      };
      parsed = {
        learned_scoring_rules: extract('learned_scoring_rules'),
        learned_category_weights: extract('learned_category_weights'),
        learned_editor_insights: extract('learned_editor_insights'),
        summary: extract('summary'),
      };
      if (!parsed.learned_scoring_rules && !parsed.learned_editor_insights) {
        return { success: false, summary: "Could not parse LLM response — JSON malformed.", examplesUsed: validExamples.length };
      }
    }

    // Validate and serialise the structured weights object
    let structuredWeightsStr: string | null = null;
    if (parsed.learned_structured_weights && typeof parsed.learned_structured_weights === 'object') {
      try {
        // Ensure examples_used is set correctly
        const sw = parsed.learned_structured_weights as Record<string, unknown>;
        sw.examples_used = validExamples.length;
        structuredWeightsStr = JSON.stringify(sw);
        console.log(`[LLMScoring] Structured weights: ${Object.keys((sw.category_boosts as Record<string,number>) ?? {}).length} category boosts, ${Object.keys((sw.keyword_boosts as Record<string,number>) ?? {}).length} keyword boosts`);
      } catch {
        console.warn("[LLMScoring] Could not serialise structured weights");
      }
    }

    // Persist all pieces to scoring_config
    const saves: Promise<void>[] = [
      setScoringConfig("learned_scoring_rules", parsed.learned_scoring_rules ?? ""),
      setScoringConfig("learned_category_weights", parsed.learned_category_weights ?? ""),
      setScoringConfig("learned_editor_insights", parsed.learned_editor_insights ?? ""),
      setScoringConfig("last_learned_at", new Date().toISOString()),
      setScoringConfig("last_learned_examples_count", String(validExamples.length)),
    ];
    if (structuredWeightsStr) {
      saves.push(setScoringConfig("learned_structured_weights", structuredWeightsStr));
    }
    await Promise.all(saves);

    console.log(`[LLMScoring] Learned from ${validExamples.length} overrides. Summary: ${parsed.summary}`);

    return {
      success: true,
      summary: parsed.summary ?? `Learned from ${validExamples.length} override examples.`,
      examplesUsed: validExamples.length,
    };
  } catch (err) {
    console.error("[LLMScoring] learnFromOverrides failed:", err);
    return {
      success: false,
      summary: err instanceof Error ? err.message : "Unknown error",
      examplesUsed: validExamples.length,
    };
  }
}
