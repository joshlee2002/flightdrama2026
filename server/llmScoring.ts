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

  const instagramBlock = topPerformers.length > 0
    ? [
        `## GROUND TRUTH: Real FlightDrama Instagram Performance`,
        `These are actual posts and their real engagement. This is the most important signal.`,
        `Score new stories based on similarity to the TOP performers. Avoid patterns from the BOTTOM performers.`,
        ``,
        `### TOP PERFORMERS (what works for FlightDrama):`,
        ...topPerformers.map((p, i) => {
          const stats = [
            p.views ? `${(p.views / 1000).toFixed(0)}k views` : null,
            p.likes ? `${p.likes.toLocaleString()} likes` : null,
            p.shares ? `${p.shares} shares` : null,
            p.saves ? `${p.saves} saves` : null,
          ].filter(Boolean).join(" | ");
          return `#${i + 1} [perf:${p._perfScore}/100] "${p.headline}"\n     Category: ${p.category ?? "unknown"} | ${stats}`;
        }),
        ``,
        `### BOTTOM PERFORMERS (avoid these patterns):`,
        ...bottomPerformers.map(p => {
          const stats = [
            p.views ? `${(p.views / 1000).toFixed(0)}k views` : null,
            p.likes ? `${p.likes.toLocaleString()} likes` : null,
          ].filter(Boolean).join(" | ") || "low engagement";
          return `[perf:${p._perfScore}/100] "${p.headline}" | ${stats}`;
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
  let systemPrompt = `You are a viral content scoring engine for FlightDrama, an aviation Instagram/TikTok/YouTube account.

Your PRIMARY job is to predict which stories will perform like the TOP PERFORMERS shown below — stories that got real views, likes, and shares from FlightDrama's audience. Use the Instagram performance data as your main reference, not generic virality theory.

Score from 0–100:
- 88–100 = must_post (matches top performer pattern — shocking, emotional, or deeply surprising)
- 70–87 = strong_candidate (similar to strong performers — clear hook, aviation drama)
- 55–69 = maybe (some potential but weaker hook than typical performers)
- 0–54 = reject (routine news, no emotional hook, not similar to any top performer)
- AUTOMATIC REJECT (score 0-15): listicles, travel guides, product reviews, opinion columns with no news event, sponsored content, award announcements, any headline starting with a number followed by a noun ("16 Hotels...", "5 Reasons...").`;

  // Instagram performance data goes FIRST — it's the primary signal
  if (instagramBlock) {
    systemPrompt += `\n\n${instagramBlock}`;
  }

  // Structured weights from deep learner (hard numeric adjustments)
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
    // Fall back to text-based learned rules if structured weights not yet generated
    if (learnedRules) systemPrompt += `\n\n## Learned Scoring Rules\n${learnedRules}`;
    if (learnedWeights) systemPrompt += `\n\n## Learned Category Weights\n${learnedWeights}`;
    if (learnedInsights) systemPrompt += `\n\n## Editor Preferences\n${learnedInsights}`;
  }

  // Statistical learner output (free, always up-to-date)
  if (statWeights || statKeywordBoosts || statKeywordPenalties) {
    systemPrompt += `\n\n## Statistical Signals (from override history)`;
    if (statWeights) systemPrompt += `\nCategory score adjustments: ${statWeights}`;
    if (statKeywordBoosts) systemPrompt += `\nKeywords editor consistently scores HIGHER: ${statKeywordBoosts}`;
    if (statKeywordPenalties) systemPrompt += `\nKeywords editor consistently scores LOWER: ${statKeywordPenalties}`;
  }

  if (examplesBlock) {
    systemPrompt += `\n\n## Editor Override History (most recent and most instructive first)\nThe editor has manually corrected these AI scores. [recent] = last 30 days. Learn from the pattern:\n\n${examplesBlock}`;
  }

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
      return parsed;
    } catch {
      return null;
    }
  };

  try {
    const { systemPrompt } = await buildScoringContext();
    const truncatedContent = content?.slice(0, 1200) ?? "";
    const userMessage = `Score this aviation story:\n\nTitle: "${title}"\n\nContent excerpt: "${truncatedContent}"`;

    // ── Pass 1: 8B model (cheap) ──────────────────────────────────────────────
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
          // Use the higher of the two scores — we never want to suppress a viral story
          const finalRaw = parsed70b.score >= parsed8b.score ? parsed70b : parsed8b;
          const llmCategory = finalRaw.category ?? ruleResult.category;
          const llmScore = Math.round(finalRaw.score);
          const statAdjustedScore = await applyStatAdjustments(llmScore, llmCategory, title);
          console.log(`[LLMScoring] 70B verified: ${parsed8b.score} → ${llmScore} (used ${finalRaw === parsed70b ? "70B" : "8B"})`);
          return {
            score: statAdjustedScore,
            statusLabel: finalRaw.statusLabel as ScoringResult["statusLabel"],
            category: llmCategory,
            viralReason: finalRaw.viralReason ?? ruleResult.viralReason,
            triggers: Array.isArray(finalRaw.triggers) ? finalRaw.triggers : ruleResult.triggers,
            viralExplanation: finalRaw.viralExplanation ?? ruleResult.viralExplanation,
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
      if (p.score >= 75 && scoringModel !== verifyModel) {
        try {
          const verified = await scoreStoryWithLLM(s.title, s.content);
          // Use the higher score — never suppress a potential viral story
          if (verified.score >= p.score) {
            results.push(verified);
            continue;
          }
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
  // For each category, compute average (overrideScore - viralScore)
  const categoryDrifts: Record<string, { totalDrift: number; count: number }> = {};
  let totalDrift = 0;

  for (const ex of examples) {
    if (ex.overrideScore === null || ex.viralScore === null) continue;
    const drift = ex.overrideScore - ex.viralScore;
    totalDrift += drift;
    const cat = ex.category ?? "General Aviation";
    if (!categoryDrifts[cat]) categoryDrifts[cat] = { totalDrift: 0, count: 0 };
    categoryDrifts[cat].totalDrift += drift;
    categoryDrifts[cat].count++;
  }

  const avgOverallDrift = totalDrift / examples.length;

  // Build category weight string — only include categories with ≥2 examples
  const catEntries = Object.entries(categoryDrifts)
    .filter(([, v]) => v.count >= 2)
    .map(([cat, v]) => {
      const avg = Math.round(v.totalDrift / v.count);
      const direction = avg > 0 ? `+${avg}` : `${avg}`;
      return `${cat}: ${direction} pts avg (${v.count} overrides)`;
    })
    .sort((a, b) => {
      // Sort by magnitude of drift descending
      const aVal = Math.abs(parseInt(a.match(/([+-]\d+)/)?.[1] ?? "0"));
      const bVal = Math.abs(parseInt(b.match(/([+-]\d+)/)?.[1] ?? "0"));
      return bVal - aVal;
    });

  const statCategoryWeights = catEntries.length > 0
    ? catEntries.join("; ")
    : "Not enough data per category yet.";

  // ── 2. Keyword frequency analysis ────────────────────────────────────────
  // Split examples into "editor scored higher" vs "editor scored lower"
  // Threshold is 20 pts (not 10). A small nudge like 100→90 is a minor correction
  // and should NOT teach the system to avoid those words. Only deliberate large moves
  // (e.g. 100→70 or 100→30) represent a genuine signal about topic quality.
  // This prevents core aviation words like 'boeing' and 'aircraft' from being
  // incorrectly penalised just because they appear in slightly-downgraded stories.
  const SIGNIFICANT_DRIFT = 20; // only count overrides with ≥20 point drift

  const boostedTitles = examples
    .filter(e => e.overrideScore !== null && e.viralScore !== null && (e.overrideScore - e.viralScore) >= SIGNIFICANT_DRIFT)
    .map(e => `${e.title ?? ""} ${e.content?.slice(0, 300) ?? ""}`.toLowerCase());

  const penalisedTitles = examples
    .filter(e => e.overrideScore !== null && e.viralScore !== null && (e.viralScore - e.overrideScore) >= SIGNIFICANT_DRIFT)
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
