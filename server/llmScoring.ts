/**
 * LLM-assisted viral scoring for FlightDrama Content OS.
 *
 * Three capabilities:
 *
 * 1. scoreStoryWithLLM()
 *    Scores a story using the LLM. Injects:
 *    - The editor's most RELEVANT override history as few-shot examples
 *      (category-matched + most instructive corrections, not just most recent)
 *    - A plain-English editorial philosophy derived from all override history
 *    - Instagram performance data as secondary context
 *    Falls back to rule-based scoring if the LLM call fails.
 *    NOTE: applyStatAdjustments() is NO LONGER applied post-LLM.
 *          The LLM score is the final score. The rule-based score is stored
 *          separately in ruleScore for debugging and comparison only.
 *
 * 2. learnFromOverridesStatistical()   ← FREE, no LLM, runs automatically on every override
 *    Pure statistics: counts, averages, and keyword frequency analysis across
 *    all override history. Produces category weights and keyword boost/penalty
 *    lists stored in scoring_config. Zero cost.
 *
 * 3. learnFromOverrides()              ← Uses LLM credits, call manually only
 *    Analyses all override history and asks the LLM to produce a plain-English
 *    "editorial philosophy" — a nuanced description of the editor's taste.
 *    Replaces the old JSON weight matrix approach.
 */

import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { getOverrideExamplesFromDb, getAllScoringConfig, setScoringConfig, getDb, getHistoricalPosts } from "./db";
import { calculatePerformanceScore } from "./performanceAnalysis";
import { scoreStory, type ScoringResult } from "./viralScoring";
import { labelFromScore } from "@shared/const";
import { stories } from "../drizzle/schema";
import { and, desc, isNotNull, or, sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LLMScoringResult = ScoringResult & {
  scoringMethod: "rule_based" | "llm_assisted";
};

// ── Similarity-based override retrieval ──────────────────────────────────────

/**
 * Extracts meaningful tokens from a title for similarity matching.
 * Returns a set of lowercase words and bigrams, excluding stop words.
 */
function extractTokens(text: string): Set<string> {
  const stopWords = new Set([
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "by","from","as","is","was","are","were","be","been","have","has","had",
    "this","that","after","over","into","not","new","first","last","says","said",
  ]);
  const words = text.toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
  const filtered = words.filter(w => !stopWords.has(w) && w.length > 3);
  const tokens = new Set(filtered);
  // Add bigrams
  for (let i = 0; i < filtered.length - 1; i++) {
    tokens.add(`${filtered[i]} ${filtered[i + 1]}`);
  }
  return tokens;
}

/**
 * Scores similarity between a new story and a past override example.
 * Considers: category match, shared title tokens, and drift magnitude.
 * Returns a number 0–100 (higher = more relevant to show as a few-shot example).
 */
function similarityScore(
  newTitle: string,
  newCategory: string,
  example: { title: string | null; category: string | null; overrideScore: number | null; viralScore: number | null }
): number {
  let score = 0;

  // Category match is the strongest signal
  const exCat = (example.category ?? "").toLowerCase();
  const newCat = newCategory.toLowerCase();
  if (exCat && newCat && (exCat === newCat || exCat.includes(newCat) || newCat.includes(exCat))) {
    score += 40;
  }

  // Token overlap in title
  const newTokens = extractTokens(newTitle);
  const exTokens = extractTokens(example.title ?? "");
  let overlap = 0;
  for (const t of newTokens) {
    if (exTokens.has(t)) overlap++;
  }
  const unionSize = new Set([...newTokens, ...exTokens]).size;
  if (unionSize > 0) {
    score += Math.round((overlap / unionSize) * 40);
  }

  // Prefer examples with large drift (most instructive corrections)
  const drift = Math.abs((example.overrideScore ?? 0) - (example.viralScore ?? 0));
  score += Math.min(20, drift / 2);

  return score;
}

/**
 * Retrieves the most relevant override examples for a given story.
 *
 * Strategy:
 * 1. Fetch all available overrides (up to 200).
 * 2. Score each by similarity to the new story (category + title tokens).
 * 3. Return the top N most relevant, ensuring a mix of recent and instructive.
 */
async function getRelevantOverrides(
  title: string,
  category: string,
  limit = 20
): Promise<Array<{
  id: number;
  title: string | null;
  overrideScore: number | null;
  overrideLabel: string | null;
  viralScore: number | null;
  category: string | null;
  viralReason: string | null;
  viralTriggers: string[] | null;
  updatedAt: Date | null;
}>> {
  const allExamples = await getOverrideExamplesFromDb(200);
  if (allExamples.length === 0) return [];

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const scored = allExamples
    .filter(e => e.overrideScore !== null && e.overrideLabel !== null)
    .map(e => ({
      ...e,
      _similarity: similarityScore(title, category, e),
      _isRecent: e.updatedAt ? (now - new Date(e.updatedAt).getTime()) < thirtyDaysMs : false,
    }))
    // Sort: similarity desc, then recency as tiebreaker
    .sort((a, b) => {
      if (b._similarity !== a._similarity) return b._similarity - a._similarity;
      return (b._isRecent ? 1 : 0) - (a._isRecent ? 1 : 0);
    });

  return scored.slice(0, limit);
}

// ── Build scoring prompt ──────────────────────────────────────────────────────

/**
 * Builds the scoring context for a specific story.
 *
 * Changes from previous version:
 * - Override examples are now SIMILARITY-MATCHED to the story being scored,
 *   not just the 50 most recent.
 * - The editorial philosophy (plain English) replaces the JSON weight matrix.
 * - Instagram performance data is now SECONDARY context, not the primary signal.
 * - Statistical signals are included as light guidance only.
 */
async function buildScoringContext(
  title: string,
  category: string
): Promise<{
  systemPrompt: string;
  hasExamples: boolean;
  exampleTitles: string[];
}> {
  const [relevantExamples, config, historicalPosts, allExamplesForCalibration] = await Promise.all([
    getRelevantOverrides(title, category, 20),
    getAllScoringConfig(),
    getHistoricalPosts(30),
    getOverrideExamplesFromDb(200),
  ]);

  // ── Score calibration: compute editor's actual distribution ──────────────
  const calibrationBlock = (() => {
    const scored = allExamplesForCalibration.filter(e => e.overrideScore !== null);
    if (scored.length < 5) return null;

    const scores = scored.map(e => e.overrideScore as number);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    const bucket0_30 = scores.filter(s => s <= 30).length;
    const bucket31_60 = scores.filter(s => s > 30 && s <= 60).length;
    const bucket61_80 = scores.filter(s => s > 60 && s <= 80).length;
    const bucket81_100 = scores.filter(s => s > 80).length;
    const pct = (n: number) => Math.round((n / scores.length) * 100);

    const sortedScores = [...scores].sort((a, b) => a - b);
    const p75 = sortedScores[Math.floor(sortedScores.length * 0.75)] ?? maxScore;
    const p90 = sortedScores[Math.min(Math.floor(sortedScores.length * 0.9), sortedScores.length - 1)] ?? maxScore;
    const highThreshold = Math.max(p75, 75);
    const mustPostThreshold = Math.max(p90, 70);
    const strongThreshold = Math.max(Math.min(mustPostThreshold - 12, 75), 55);

    const byRecencyThenScore = (a: typeof scored[0], b: typeof scored[0]) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return (b.overrideScore ?? 0) - (a.overrideScore ?? 0);
    };
    const highEx = [...scored].filter(e => (e.overrideScore ?? 0) >= highThreshold).sort(byRecencyThenScore)[0];
    const midEx = [...scored].filter(e => (e.overrideScore ?? 0) >= 55 && (e.overrideScore ?? 0) < highThreshold).sort(byRecencyThenScore)[0];
    const lowEx = [...scored].filter(e => (e.overrideScore ?? 0) <= 35).sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return (a.overrideScore ?? 0) - (b.overrideScore ?? 0);
    })[0];

    const anchors = [highEx, midEx, lowEx]
      .filter(Boolean)
      .map(e => `  Score ${e!.overrideScore}: "${(e!.title ?? "").slice(0, 70)}"`);

    const softCeilingNote = scores.length >= 20
      ? `- Scores above ${maxScore} are very rare for this editor — only use them for genuinely exceptional, once-in-a-year stories`
      : `- This editor's highest score so far is ${maxScore} — calibrate accordingly`;

    return [
      `## CALIBRATION — You MUST match this editor's exact scoring scale`,
      `This editor has scored ${scores.length} stories. Their real distribution is:`,
      `- Score range seen so far: ${minScore}–${maxScore} | Average: ${avgScore}`,
      `- Distribution: ${pct(bucket0_30)}% score 0–30 | ${pct(bucket31_60)}% score 31–60 | ${pct(bucket61_80)}% score 61–80 | ${pct(bucket81_100)}% score 81–100`,
      softCeilingNote,
      `- Most strong stories score ${strongThreshold}–${mustPostThreshold - 1}. Reserve ${mustPostThreshold}+ for genuinely shocking events.`,
      `- DISTRIBUTION RULE: Do NOT cluster scores at the top. Score lower and let the editor correct upward.`,
      ...(anchors.length > 0 ? [`- Recent real score anchors from this editor:`, ...anchors] : []),
      ``,
      `Score thresholds (calibrated to this editor's scale):`,
      `- ${mustPostThreshold}–100 = must_post`,
      `- ${strongThreshold}–${mustPostThreshold - 1} = strong_candidate`,
      `- 50–${strongThreshold - 1} = maybe`,
      `- 0–49 = reject`,
      `- AUTOMATIC REJECT (score 0–15): listicles, travel guides, product reviews, opinion columns, sponsored content, award announcements.`,
    ].join("\n");
  })();

  const staticScoreRanges = `Score this story RELATIVE to what a typical aviation editor would find exceptional.
- Most aviation stories are routine. Score 50–75 for stories with a real hook but nothing extraordinary.
- Score 85+ ONLY if this story is clearly better than a typical aviation incident.
- Score 88+ (must_post) for no more than 15% of stories.
- DISTRIBUTION RULE: Do NOT cluster scores at the top. Spread scores across 45–85.
- AUTOMATIC REJECT (score 0–15): listicles, travel guides, product reviews, opinion columns, sponsored content, award announcements.`;

  // ── Editorial philosophy (plain English, replaces JSON weight matrix) ─────
  const editorialPhilosophy = config["editorial_philosophy"] ?? null;

  // ── Instagram performance data — SECONDARY context ────────────────────────
  const postsWithMetrics = historicalPosts.filter(
    p => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0
  );
  const rankedPosts = postsWithMetrics
    .map(p => ({ ...p, _perfScore: calculatePerformanceScore(p) }))
    .filter(p => p._perfScore > 0)
    .sort((a, b) => b._perfScore - a._perfScore);

  const topPerformers = rankedPosts.slice(0, 10);
  const bottomPerformers = rankedPosts.slice(-5);
  const toEngagementRank = (s: number) => Math.max(1, Math.min(10, Math.round(s / 10)));

  const instagramBlock = topPerformers.length > 0
    ? [
        `## SECONDARY CONTEXT: Real FlightDrama Instagram Performance`,
        `These are actual posts and their real engagement. Use these to understand what topics and angles resonate with the audience.`,
        `NOTE: This is secondary context. Joshua's explicit score corrections (above) always take precedence over audience performance data.`,
        `The engagement-rank (e.g. "eng:9/10") is a relative engagement metric — it is NOT your story quality score.`,
        ``,
        `### TOP PERFORMERS:`,
        ...topPerformers.map((p, i) => {
          const stats = [
            p.views ? `${(p.views / 1000).toFixed(0)}k views` : null,
            p.likes ? `${p.likes.toLocaleString()} likes` : null,
          ].filter(Boolean).join(" | ");
          return `#${i + 1} [eng:${toEngagementRank(p._perfScore)}/10] "${p.headline}" | ${p.category ?? "unknown"} | ${stats}`;
        }),
        ``,
        `### BOTTOM PERFORMERS:`,
        ...bottomPerformers.map(p => `[eng:${toEngagementRank(p._perfScore)}/10] "${p.headline}" | ${p.category ?? "unknown"}`),
      ].join("\n")
    : null;

  // ── Statistical signals — light guidance only ─────────────────────────────
  const statWeights = config["stat_category_weights"] ?? null;
  const statKeywordBoosts = config["stat_keyword_boosts"] ?? null;
  const statKeywordPenalties = config["stat_keyword_penalties"] ?? null;

  // ── Build the examples block ──────────────────────────────────────────────
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const exampleTitles: string[] = [];
  const examplesBlock = relevantExamples.length > 0
    ? relevantExamples
        .map((e, i) => {
          const drift = (e.overrideScore ?? 0) - (e.viralScore ?? 0);
          const driftStr = drift > 0
            ? `+${drift} (Joshua scored HIGHER — AI undervalued this)`
            : drift < 0
            ? `${drift} (Joshua scored LOWER — AI overvalued this)`
            : `0 (agreed)`;
          const recency = e.updatedAt && (now - new Date(e.updatedAt).getTime()) < thirtyDaysMs ? " [recent]" : "";
          exampleTitles.push(e.title ?? "");
          return `${i + 1}.${recency} "${e.title}"\n   AI: ${e.viralScore} → Joshua: ${e.overrideScore} (${e.overrideLabel}) | Drift: ${driftStr}\n   Category: ${e.category ?? "unknown"}`;
        })
        .join("\n\n")
    : null;

  // ── Build the full system prompt ──────────────────────────────────────────
  // STRUCTURE:
  // 1. Persona — editorial apprentice, not a generic scoring engine
  // 2. Editor's past corrections — PRIMARY SIGNAL (most similar examples first)
  // 3. Editorial philosophy — plain-English taste summary
  // 4. Instagram performance — SECONDARY context
  // 5. Statistical signals — light guidance
  // 6. Hard scoring constraints — LAST

  let systemPrompt = `You are Joshua's editorial apprentice for FlightDrama, an aviation Instagram/TikTok/YouTube account.

Your ONLY goal is to predict the score Joshua would give this story, based on his past corrections.
Do NOT use generic "aviation drama = high score" logic. Study Joshua's actual corrections and apply his specific taste.
When Joshua has corrected similar stories before, those corrections are your most important instruction.`;

  // 1. Editor's past corrections — PRIMARY SIGNAL
  if (examplesBlock) {
    systemPrompt += `\n\n## JOSHUA'S PAST CORRECTIONS — YOUR PRIMARY INSTRUCTION
These are the most relevant stories Joshua has already scored. They are selected because they are similar to the story you are about to score.
[recent] = last 30 days (most representative of current taste).

PAY ATTENTION TO THE DRIFT: when Joshua scored LOWER than the AI, the AI overvalued that type of story. When he scored HIGHER, the AI undervalued it. Apply this directly to the new story.

${examplesBlock}

CRITICAL: Look at the range of scores above. If Joshua's corrections cluster in the 45–70 range for similar stories, the new story should land there too unless it is clearly exceptional. Do NOT score above Joshua's typical range for this story type unless the new story is genuinely more dramatic.`;
  }

  // 2. Editorial philosophy — plain English taste summary
  if (editorialPhilosophy) {
    systemPrompt += `\n\n## JOSHUA'S EDITORIAL PHILOSOPHY (derived from all his corrections)
${editorialPhilosophy}`;
  }

  // 3. Instagram performance — SECONDARY context
  if (instagramBlock) {
    systemPrompt += `\n\n${instagramBlock}`;
  }

  // 4. Statistical signals — light guidance
  if (statWeights || statKeywordBoosts || statKeywordPenalties) {
    systemPrompt += `\n\n## Statistical Patterns (light guidance — Joshua's corrections above take precedence)`;
    if (statWeights) systemPrompt += `\nCategory tendencies: ${statWeights}`;
    if (statKeywordBoosts) systemPrompt += `\nKeywords Joshua tends to score HIGHER: ${statKeywordBoosts}`;
    if (statKeywordPenalties) systemPrompt += `\nKeywords Joshua tends to score LOWER: ${statKeywordPenalties}`;
  }

  // 5. Hard scoring constraints — LAST
  systemPrompt += `\n\n## SCORING RULES (MANDATORY)\n${calibrationBlock ?? staticScoreRanges}
- CRITICAL: The engagement ranks (eng:X/10) in the Instagram data above are engagement metrics, NOT score targets. Do not copy them into your score.
- CRITICAL: A score of 100 means a once-in-a-year story. Do not give 100 unless the story is genuinely unprecedented.
- WHEN IN DOUBT: Score LOWER. Joshua will correct you upward if needed.`;

  systemPrompt += `\n\nRespond ONLY with a valid JSON object in this exact format:
{
  "score": <integer 0-100>,
  "statusLabel": "<must_post|strong_candidate|maybe|reject>",
  "category": "<category string>",
  "viralReason": "<one sentence explanation of the score>",
  "viralExplanation": "<two to three sentences explaining WHY this would or would not go viral>",
  "triggers": ["<trigger 1>", "<trigger 2>"],
  "apprenticeConfidence": "<High|Medium|Low — High if 3+ very similar past corrections exist, Low if no similar examples>",
  "apprenticeReasoning": "<one to two sentences explaining how Joshua's past corrections influenced this specific score>"
}`;

  return {
    systemPrompt,
    hasExamples: relevantExamples.length > 0,
    exampleTitles,
  };
}

// ── Score a single story ──────────────────────────────────────────────────────

/**
 * Score a story using the LLM with similarity-matched override examples as context.
 *
 * Key changes:
 * - applyStatAdjustments() is NO LONGER called post-LLM. The LLM score is final.
 * - The rule-based score is stored in ruleScore for debugging only.
 * - Override examples are similarity-matched to the story being scored.
 * - The LLM returns apprenticeConfidence and apprenticeReasoning for transparency.
 *
 * Two-tier model strategy:
 * - Initial pass: llama-3.1-8b-instant (fast, cheap)
 * - Safety net: if 8B scores ≥ 75, verify with llama-3.3-70b-versatile
 */
export async function scoreStoryWithLLM(
  title: string,
  content: string
): Promise<LLMScoringResult> {
  const ruleResult = scoreStory(title, content);
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
        apprenticeConfidence?: string;
        apprenticeReasoning?: string;
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
      parsed.score = Math.min(95, parsed.score);
      return parsed;
    } catch {
      return null;
    }
  };

  try {
    const { systemPrompt, exampleTitles } = await buildScoringContext(title, ruleResult.category);
    const truncatedContent = content?.slice(0, 1200) ?? "";
    const userMessage = `Score this aviation story:\n\nTitle: "${title}"\n\nContent excerpt: "${truncatedContent}"`;

    // ── Pass 1: 8B model (cheap) ──────────────────────────────────────────
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
      // Fallback: use rule score as-is (no stat adjustment applied)
      return {
        ...ruleResult,
        ruleScore: ruleResult.score,
        scoringMethod: "rule_based",
      };
    }

    // ── Pass 2: 70B safety net for potential viral stories ────────────────
    if (parsed8b.score >= 88 && scoringModel !== verifyModel) {
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
          const llmCategory = parsed70b.category ?? ruleResult.category;
          const llmScore = Math.round(parsed70b.score);
          const derivedLabel70b = labelFromScore(llmScore) as ScoringResult["statusLabel"];
          console.log(`[LLMScoring] 70B result: 8B=${parsed8b.score} → 70B=${llmScore} label=${derivedLabel70b}`);
          return {
            score: llmScore,
            statusLabel: derivedLabel70b,
            category: llmCategory,
            viralReason: parsed70b.viralReason ?? ruleResult.viralReason,
            triggers: Array.isArray(parsed70b.triggers) ? parsed70b.triggers : ruleResult.triggers,
            viralExplanation: parsed70b.viralExplanation ?? ruleResult.viralExplanation,
            ruleScore: ruleResult.score,
            apprenticeConfidence: parsed70b.apprenticeConfidence ?? "Medium",
            apprenticeReasoning: parsed70b.apprenticeReasoning,
            similarExamplesUsed: exampleTitles.slice(0, 5),
            scoringMethod: "llm_assisted",
          };
        }
      } catch (verifyErr) {
        console.warn("[LLMScoring] 70B safety check failed, using 8B result:", verifyErr);
      }
    }

    // ── Use 8B result ─────────────────────────────────────────────────────
    const llmCategory = parsed8b.category ?? ruleResult.category;
    const llmScore = Math.round(parsed8b.score);
    const derivedLabel8b = labelFromScore(llmScore) as ScoringResult["statusLabel"];
    return {
      score: llmScore,
      statusLabel: derivedLabel8b,
      category: llmCategory,
      viralReason: parsed8b.viralReason ?? ruleResult.viralReason,
      triggers: Array.isArray(parsed8b.triggers) ? parsed8b.triggers : ruleResult.triggers,
      viralExplanation: parsed8b.viralExplanation ?? ruleResult.viralExplanation,
      ruleScore: ruleResult.score,
      apprenticeConfidence: parsed8b.apprenticeConfidence ?? "Medium",
      apprenticeReasoning: parsed8b.apprenticeReasoning,
      similarExamplesUsed: exampleTitles.slice(0, 5),
      scoringMethod: "llm_assisted",
    };
  } catch (err) {
    console.error("[LLMScoring] Error calling LLM, falling back to rule-based:", err);
    // Fallback: use rule score as-is (no stat adjustment)
    return {
      ...ruleResult,
      ruleScore: ruleResult.score,
      scoringMethod: "rule_based",
    };
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
 * Key changes:
 * - applyStatAdjustments() is NO LONGER called post-LLM.
 * - Each story in the batch uses the shared context built from the first story's
 *   category. For batches with mixed categories, individual scoring is preferred.
 * - The LLM returns apprenticeConfidence and apprenticeReasoning per story.
 */
export async function batchScoreStoriesWithLLM(
  stories: BatchScoringInput[]
): Promise<LLMScoringResult[]> {
  if (stories.length === 0) return [];

  const scoringModel = ENV.scoringLlmModel || ENV.defaultLlmModel || "llama-3.1-8b-instant";
  const verifyModel = ENV.defaultLlmModel || "llama-3.3-70b-versatile";

  // Build context using the first story's title/category as the anchor.
  // This gives the best coverage for homogeneous batches (same ingest run).
  const firstStory = stories[0];
  const { systemPrompt, exampleTitles } = await buildScoringContext(
    firstStory.title,
    firstStory.ruleScore.category
  );

  // Modify system prompt for batch output
  const batchSystemPrompt = systemPrompt.replace(
    /Respond ONLY with a valid JSON object[\s\S]*/,
    `Respond ONLY with a valid JSON array of ${stories.length} objects, one per story, in the same order as the input. Each object must have:
{ "score": <integer 0-100>, "statusLabel": "<must_post|strong_candidate|maybe|reject>", "category": "<category>", "viralReason": "<one sentence>", "viralExplanation": "<two to three sentences>", "triggers": ["<trigger 1>", "<trigger 2>"], "apprenticeConfidence": "<High|Medium|Low>", "apprenticeReasoning": "<one sentence on how past corrections influenced this score>" }
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
      return Promise.all(stories.map(s => scoreStoryWithLLM(s.title, s.content)));
    }

    const parsedArray = JSON.parse(jsonMatch[0]) as Array<{
      score: number;
      statusLabel: string;
      category: string;
      viralReason: string;
      triggers: string[];
      viralExplanation?: string;
      apprenticeConfidence?: string;
      apprenticeReasoning?: string;
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
        // Invalid entry — fall back to rule-based for this story (no stat adjustment)
        results.push({
          ...s.ruleScore,
          ruleScore: s.ruleScore.score,
          scoringMethod: "rule_based",
        });
        continue;
      }

      // 70B safety net for high-scoring stories
      if (p.score >= 88 && scoringModel !== verifyModel) {
        try {
          const verified = await scoreStoryWithLLM(s.title, s.content);
          results.push(verified);
          continue;
        } catch {
          // Verification failed — use batch result
        }
      }

      const llmCategory = p.category ?? s.ruleScore.category;
      const llmScore = Math.min(95, Math.round(p.score));
      const derivedLabel = labelFromScore(llmScore) as ScoringResult["statusLabel"];
      results.push({
        score: llmScore,
        statusLabel: derivedLabel,
        category: llmCategory,
        viralReason: p.viralReason ?? s.ruleScore.viralReason,
        triggers: Array.isArray(p.triggers) ? p.triggers : s.ruleScore.triggers,
        viralExplanation: p.viralExplanation ?? s.ruleScore.viralExplanation,
        ruleScore: s.ruleScore.score,
        apprenticeConfidence: p.apprenticeConfidence ?? "Medium",
        apprenticeReasoning: p.apprenticeReasoning,
        similarExamplesUsed: exampleTitles.slice(0, 5),
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
 * Results are stored in scoring_config and used as light guidance in the prompt.
 */
export async function learnFromOverridesStatistical(): Promise<{
  success: boolean;
  summary: string;
  examplesUsed: number;
}> {
  const db = await getDb();
  if (!db) return { success: false, summary: "Database not available", examplesUsed: 0 };

  const { stories: storiesTable } = await import("../drizzle/schema");

  const examples = await db
    .select({
      title: storiesTable.title,
      content: storiesTable.content,
      overrideScore: storiesTable.overrideScore,
      overrideLabel: storiesTable.overrideLabel,
      viralScore: storiesTable.viralScore,
      category: storiesTable.category,
      viralReason: storiesTable.viralReason,
    })
    .from(storiesTable)
    .where(and(isNotNull(storiesTable.overrideScore), isNotNull(storiesTable.overrideLabel)))
    .orderBy(desc(storiesTable.updatedAt))
    .limit(200);

  if (examples.length < 3) {
    return {
      success: false,
      summary: "Not enough overrides yet — override at least 3 stories to start learning.",
      examplesUsed: 0,
    };
  }

  // ── 1. Category bias analysis ─────────────────────────────────────────────
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
  let totalDrift = 0;
  for (const ex of examples) {
    if (ex.overrideScore !== null && ex.viralScore !== null) totalDrift += ex.overrideScore - ex.viralScore;
  }
  const avgOverallDrift = examples.length > 0 ? totalDrift / examples.length : 0;

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
  const ABSOLUTE_THRESHOLD = 15;

  const boostedTitles = examples
    .filter(e => e.overrideScore !== null && (e.overrideScore - avgEditorScore) >= ABSOLUTE_THRESHOLD)
    .map(e => `${e.title ?? ""} ${e.content?.slice(0, 300) ?? ""}`.toLowerCase());

  const penalisedTitles = examples
    .filter(e => e.overrideScore !== null && (avgEditorScore - e.overrideScore) >= ABSOLUTE_THRESHOLD)
    .map(e => `${e.title ?? ""} ${e.content?.slice(0, 300) ?? ""}`.toLowerCase());

  function extractKeywords(texts: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
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
      const words = text.match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
      for (const word of words) {
        if (!stopWords.has(word) && word.length > 3) {
          counts[word] = (counts[word] ?? 0) + 1;
        }
      }
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

  const driftDesc = avgOverallDrift > 3
    ? `Editor scores ${Math.round(avgOverallDrift)} pts HIGHER than rules on average — rules are too conservative.`
    : avgOverallDrift < -3
    ? `Editor scores ${Math.round(Math.abs(avgOverallDrift))} pts LOWER than rules on average — rules are too generous.`
    : `Editor scores closely match the rules on average (drift: ${avgOverallDrift.toFixed(1)} pts).`;

  const summary = `Statistical learning from ${examples.length} overrides: ${driftDesc} Top boosted categories: ${catEntries.slice(0, 3).join("; ") || "none yet"}.`;

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
 * Analyses all editor overrides and asks the LLM to produce a plain-English
 * "editorial philosophy" — a nuanced description of the editor's taste.
 *
 * KEY CHANGE: This no longer produces a JSON weight matrix (learned_structured_weights).
 * Instead it produces a plain-English editorial_philosophy that is injected into
 * the scoring prompt as natural language context. This allows the LLM to reason
 * with the philosophy rather than being constrained by rigid numeric weights.
 *
 * NOTE: This uses LLM credits. Use learnFromOverridesStatistical() for free
 * automatic learning. Only call this when you want a deep qualitative analysis.
 */
export async function learnFromOverrides(): Promise<{ success: boolean; summary: string; examplesUsed: number }> {
  // Always run the free statistical learner first
  learnFromOverridesStatistical().catch(err =>
    console.warn("[StatLearn] Background stat learn failed:", err)
  );

  const config = await getAllScoringConfig();
  const previousPhilosophy = config["editorial_philosophy"] ?? null;
  const lastLearnedAt = config["last_learned_at"] ?? null;

  const sinceDate = lastLearnedAt && previousPhilosophy ? new Date(lastLearnedAt) : undefined;
  const newExamples = await getOverrideExamplesFromDb(undefined, sinceDate);

  if (newExamples.length < 3 && !previousPhilosophy) {
    return {
      success: false,
      summary: "Not enough override examples yet — override at least 3 stories before running this.",
      examplesUsed: 0,
    };
  }

  let filteredExamples = newExamples;
  if (sinceDate && newExamples.length < 20 && previousPhilosophy) {
    const recentContext = await getOverrideExamplesFromDb(20);
    const seenIds = new Set(newExamples.map(e => e.id));
    const contextOnly = recentContext.filter(e => !seenIds.has(e.id));
    filteredExamples = [...newExamples, ...contextOnly];
  }

  if (filteredExamples.length === 0) {
    return {
      success: true,
      summary: "No override examples available — existing philosophy unchanged.",
      examplesUsed: 0,
    };
  }

  const historicalPostsData = await getHistoricalPosts(100);
  const postsWithMetrics = historicalPostsData.filter(p => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0);
  const rankedPosts = postsWithMetrics
    .map(p => ({ ...p, _perf: calculatePerformanceScore(p) }))
    .filter(p => p._perf > 0)
    .sort((a, b) => b._perf - a._perf);

  const validExamples = filteredExamples
    .filter(e => e.overrideScore !== null && e.overrideLabel !== null)
    .slice(0, 50);

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const examplesText = validExamples
    .map((e, i) => {
      const drift = (e.overrideScore ?? 0) - (e.viralScore ?? 0);
      const driftStr = drift > 0 ? `+${drift} (AI undervalued)` : drift < 0 ? `${drift} (AI overvalued)` : `0 (agreed)`;
      const recency = e.updatedAt && (now - new Date(e.updatedAt).getTime()) < thirtyDaysMs ? " [RECENT]" : "";
      const contentSnippet = e.content ? `\n   Excerpt: "${e.content.slice(0, 120).replace(/\n/g, ' ')}..."` : "";
      return `${i + 1}.${recency} "${e.title}"${contentSnippet}\n   AI: ${e.viralScore} → Joshua: ${e.overrideScore} (${e.overrideLabel}) | Drift: ${driftStr} | Category: ${e.category ?? "unknown"}`;
    })
    .join("\n\n");

  const instagramText = rankedPosts.length > 0
    ? `\n\n## Real FlightDrama Instagram Performance (secondary context)\nTOP PERFORMERS:\n${rankedPosts.slice(0, 15).map((p, i) => {
        const stats = [p.views ? `${Math.round(p.views/1000)}k views` : null, p.likes ? `${p.likes} likes` : null].filter(Boolean).join(" | ");
        return `#${i+1} "${p.headline}" | ${p.category ?? "unknown"} | ${stats}`;
      }).join("\n")}`
    : "";

  const previousPhilosophyBlock = previousPhilosophy
    ? `\n\n## Previously Established Editorial Philosophy (REFINE and EXTEND — do NOT discard)\n${previousPhilosophy}\n\nYour job is to refine this philosophy with the new examples. Keep what holds true. Update what the new examples contradict. Add new nuances for new patterns.`
    : "";

  const isFirstRun = !previousPhilosophy;

  const systemPrompt = `You are an expert editorial analyst for FlightDrama, an aviation Instagram/TikTok/YouTube account.${previousPhilosophyBlock}

Your job is to study Joshua's score corrections and produce a plain-English editorial philosophy that captures his taste.
Focus on PATTERNS: what types of stories does he consistently value? What does he consistently reject? What nuances distinguish a 45 from a 75 from a 90 in his mind?
Be specific and concrete. Reference actual story patterns from the examples.
The Instagram performance data is provided as secondary context — Joshua's explicit corrections are the primary signal.`;

  const userMessage = `${isFirstRun ? `Analyse these ${validExamples.length} editor override examples` : `Refine the existing philosophy with these ${validExamples.length} new override examples`}:

${examplesText}${instagramText}

Return ONLY a JSON object with these THREE fields:

1. "editorial_philosophy" (string): A comprehensive plain-English description of Joshua's editorial taste. Write this as 3-5 paragraphs. Be specific: name the story types he values, the patterns he rejects, the nuances that distinguish his high scores from his low scores. This will be injected directly into the AI scoring prompt as Joshua's voice.

2. "summary" (string): One sentence describing what changed or was reinforced.

3. "examples_used" (integer): Count of examples analysed.

IMPORTANT: All field values must be plain text. Do NOT use backticks or code blocks inside string values.`;

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

    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.error("[LLMScoring] No JSON block found in response:", raw.slice(0, 200));
      return { success: false, summary: "Could not parse LLM response — no JSON block found.", examplesUsed: validExamples.length };
    }

    let jsonStr = raw.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/(?<=[":,{\[]\s*"[^"]*?)\n(?=[^"]*?")/g, ' ');

    let parsed: {
      editorial_philosophy: string;
      summary: string;
      examples_used?: number;
    };
    try {
      parsed = JSON.parse(jsonStr) as typeof parsed;
    } catch (parseErr) {
      console.warn("[LLMScoring] JSON.parse failed, trying field extraction:", parseErr);
      const extract = (key: string) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,'s'));
        return m ? m[1].replace(/\\n/g, '\n').replace(/\\t/g, ' ') : '';
      };
      parsed = {
        editorial_philosophy: extract('editorial_philosophy'),
        summary: extract('summary'),
      };
      if (!parsed.editorial_philosophy) {
        return { success: false, summary: "Could not parse LLM response — JSON malformed.", examplesUsed: validExamples.length };
      }
    }

    await Promise.all([
      setScoringConfig("editorial_philosophy", parsed.editorial_philosophy ?? ""),
      setScoringConfig("last_learned_at", new Date().toISOString()),
      setScoringConfig("last_learned_examples_count", String(validExamples.length)),
    ]);

    console.log(`[LLMScoring] Editorial philosophy updated from ${validExamples.length} overrides. Summary: ${parsed.summary}`);

    return {
      success: true,
      summary: parsed.summary ?? `Editorial philosophy updated from ${validExamples.length} override examples.`,
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
