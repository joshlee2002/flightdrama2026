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
import { scoreStory, applyStatAdjustments, normaliseToEditorDistribution, type ScoringResult } from "./viralScoring";
import { labelFromScore } from "@shared/const";
import { stories } from "../drizzle/schema";
import { and, desc, isNotNull, or, sql } from "drizzle-orm";

// ── Run-scoped cache for expensive DB reads ───────────────────────────────────
// buildScoringContext() is called once per batch of 10 stories. Without caching,
// every batch independently fetches getAllScoringConfig, getOverrideExamplesFromDb(500),
// and getHistoricalPosts(30) from the DB — for a 128-story rerank that's 39 redundant
// DB round-trips for data that doesn't change during the run.
//
// This cache stores the results for 60 seconds. All batches in the same run share
// one fetch. The cache expires automatically so the next run always gets fresh data.

type ScoringContextCache = {
  config: Record<string, string>;
  overrideExamples: Awaited<ReturnType<typeof getOverrideExamplesFromDb>>;
  historicalPosts: Awaited<ReturnType<typeof getHistoricalPosts>>;
  fetchedAt: number;
};

let _scoringContextCache: ScoringContextCache | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

async function getCachedScoringContext(): Promise<{
  config: Record<string, string>;
  overrideExamples: Awaited<ReturnType<typeof getOverrideExamplesFromDb>>;
  historicalPosts: Awaited<ReturnType<typeof getHistoricalPosts>>;
}> {
  const now = Date.now();
  if (_scoringContextCache && (now - _scoringContextCache.fetchedAt) < CACHE_TTL_MS) {
    return _scoringContextCache;
  }
  // Cache miss or expired — fetch all three in parallel
  const [config, overrideExamples, historicalPosts] = await Promise.all([
    getAllScoringConfig(),
    getOverrideExamplesFromDb(500),
    getHistoricalPosts(30),
  ]);
  _scoringContextCache = { config, overrideExamples, historicalPosts, fetchedAt: now };
  return _scoringContextCache;
}

/** Call this at the start of a rerank or ingest run to pre-warm the cache in one shot. */
export async function prewarmScoringCache(): Promise<void> {
  await getCachedScoringContext();
}

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
  limit = 20,
  preloadedExamples?: Awaited<ReturnType<typeof getOverrideExamplesFromDb>>
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
  // Use pre-loaded examples from the run-scoped cache if available, otherwise fetch
  const allExamples = preloadedExamples ?? await getOverrideExamplesFromDb(500);
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
  category: string,
  additionalCategories?: string[]
): Promise<{
  systemPrompt: string;
  hasExamples: boolean;
  exampleTitles: string[];
}> {
  // Pre-warm the run-scoped cache first so all getRelevantOverrides calls below
  // use in-memory data rather than hitting the DB individually.
  const cachedCtx = await getCachedScoringContext();
  const config = cachedCtx.config;
  const historicalPosts = cachedCtx.historicalPosts;
  const allExamplesForCalibration = cachedCtx.overrideExamples;

  // For mixed-category batches, fetch examples for each category and merge them.
  // These calls now use the cached override list — zero extra DB round-trips.
  const extraCategoryExamples = additionalCategories && additionalCategories.length > 0
    ? await Promise.all(
        additionalCategories
          .filter(c => c.toLowerCase() !== category.toLowerCase())
          .map(c => getRelevantOverrides(c, c, 8, cachedCtx.overrideExamples)) // pass cached list
      )
    : [];

  const primaryExamples = await getRelevantOverrides(
    title,
    category,
    additionalCategories && additionalCategories.length > 1 ? 12 : 20,
    cachedCtx.overrideExamples // pass cached list
  );

  // Merge examples: primary first, then extra-category examples (deduplicated by id)
  const seenIds = new Set(primaryExamples.map(e => e.id));
  const mergedExtras = extraCategoryExamples.flat().filter(e => !seenIds.has(e.id));
  const relevantExamples = [...primaryExamples, ...mergedExtras].slice(0, 25);

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
    const p50 = sortedScores[Math.floor(sortedScores.length * 0.5)] ?? avgScore; // median
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
      `- Score range seen so far: ${minScore}–${maxScore} | Median: ${p50} | Average: ${avgScore}`,
      `- Distribution: ${pct(bucket0_30)}% score 0–30 | ${pct(bucket31_60)}% score 31–60 | ${pct(bucket61_80)}% score 61–80 | ${pct(bucket81_100)}% score 81–100`,
      softCeilingNote,
      `- The MEDIAN score is ${p50}. This is your anchor. A typical story should score around ${p50}, not at the top of the range.`,
      `- Most strong stories score ${strongThreshold}–${mustPostThreshold - 1}. Reserve ${mustPostThreshold}+ for genuinely shocking events.`,
      `- DISTRIBUTION RULE: Do NOT cluster scores at the top. If you are scoring a batch of mixed stories, they CANNOT all be the same score. Spread scores across the full range. Score lower and let the editor correct upward.`,
      `- CRITICAL: Only ${pct(bucket81_100)}% of this editor's overrides are above 80. That means ${100 - pct(bucket81_100)}% of stories score 80 or below. If you are giving more than ${pct(bucket81_100)}% of stories a score above 80, you are wrong.`,
      `- DEFAULT ASSUMPTION: When uncertain, score at or below the median (${p50}). The editor will correct upward if needed. It is much better to score too low than too high.`,
      ...(anchors.length > 0 ? [`- Real score anchors from this editor (use these to calibrate your scale):`, ...anchors] : []),
      ``,
      `Score thresholds (calibrated to this editor's scale):`,
      `- ${mustPostThreshold}–100 = must_post (only ${pct(bucket81_100)}% of stories reach this)`,
      `- ${strongThreshold}–${mustPostThreshold - 1} = strong_candidate`,
      `- 50–${strongThreshold - 1} = maybe`,
      `- 0–49 = reject (${pct(bucket0_30 + bucket31_60)}% of this editor's stories land here)`,
      `- AUTOMATIC REJECT (score 0–15): listicles, travel guides, product reviews, opinion columns, sponsored content, award announcements.`,
    ].join("\n");
  })();

  const staticScoreRanges = `Score this story RELATIVE to what a typical aviation editor would find exceptional.
- Most aviation stories are routine. Score 50–75 for stories with a real hook but nothing extraordinary.
- Score 85+ ONLY if this story is clearly better than a typical aviation incident.
- Score 88+ (must_post) for no more than 15% of stories.
- DISTRIBUTION RULE: Do NOT cluster scores at the top. Spread scores across 45–85.
- AUTOMATIC REJECT (score 0–15): listicles, travel guides, product reviews, opinion columns, sponsored content, award announcements.`;

  // ── Pattern library — per-category scoring rules derived from all overrides ──
  // BUG FIX: patternLibrary was referenced at line ~367 but never declared here.
  // This caused Layer 2 (the most important learned signal) to be silently skipped
  // in every single scoring call, meaning the LLM never saw the per-category rules
  // derived from the editor's 500 overrides.
  const patternLibrary = config["pattern_library"] ?? null;

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

  // ── Drift calibration hint — built from stored per-category offsets ─────────
  // This was previously undefined (a bug), causing the drift offsets to never
  // be injected into the prompt. Now built from drift_calibration_offsets config.
  const driftCalibrationHint = (() => {
    const raw = config["drift_calibration_offsets"] ?? null;
    if (!raw) return null;
    let offsets: Record<string, { offset: number; avgJoshua: number; sampleSize: number }>;
    try {
      offsets = JSON.parse(raw);
    } catch {
      return null;
    }
    const entries = Object.entries(offsets)
      .filter(([, v]) => v.sampleSize >= 3 && Math.abs(v.offset) >= 5)
      .sort((a, b) => Math.abs(b[1].offset) - Math.abs(a[1].offset))
      .slice(0, 12);
    if (entries.length === 0) return null;
    const lines = entries.map(([cat, v]) => {
      const dir = v.offset < 0
        ? `AI scores ${Math.abs(v.offset)} pts TOO HIGH — score ${Math.abs(v.offset)} pts LOWER than your instinct`
        : `AI scores ${v.offset} pts TOO LOW — score ${v.offset} pts HIGHER than your instinct`;
      return `  ${cat}: ${dir} (Joshua avg: ${v.avgJoshua}, n=${v.sampleSize})`;
    }).join("\n");
    return `## SYSTEMATIC BIAS CORRECTIONS (MANDATORY — apply these before finalising your score)
Statistical analysis of ${Object.values(offsets).reduce((s, v) => s + v.sampleSize, 0)} overrides shows the AI has systematic biases per category. Correct for them:
${lines}`;
  })();

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

  // 2a. Structured pattern library — per-category rules (Layer 2, strongest qualitative signal)
  if (patternLibrary) {
    systemPrompt += `\n\n## JOSHUA'S SCORING RULES BY CATEGORY (derived from all his corrections — apply these directly)\n${patternLibrary}\n\nFor any story whose category matches one of the above, apply those rules first. The score range and conditions listed are based on Joshua's actual historical corrections.`;
  }

  // 2b. Editorial philosophy — fallback for categories not in the pattern library
  if (editorialPhilosophy) {
    systemPrompt += `\n\n## JOSHUA'S OVERALL EDITORIAL PHILOSOPHY (fallback for story types not in the pattern library above)\n${editorialPhilosophy}`;
  }

  // 2c. Drift calibration offsets — Layer 3 systematic bias correction
  if (driftCalibrationHint) {
    systemPrompt += `\n\n${driftCalibrationHint}`;
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
- WHEN IN DOUBT about a story type you have not seen before: score it 30–45 so Joshua can see it and make the call. Do NOT score 0 just because you are uncertain — reserve 0–20 for stories with zero aviation relevance whatsoever.
- FlightDrama covers more than crashes and fights. Quirky, fun, or surprising aviation stories are valid content: unusual airline menus, pilot pay reveals, celebrity private planes, unusual liveries, strange airport incidents, and aviation curiosities. If a story is genuinely interesting aviation content but not dramatic, score it 30–50 rather than 0.`;

  // ── Hard ceiling rules based on production data analysis ─────────────────
  // These rules correct systematic over-scoring patterns observed in production.
  systemPrompt += `\n\n## HARD CEILING RULES (override everything else — these are non-negotiable)
- "Celebrity Involvement" category: Joshua's average score for this category is 38. The AI consistently over-scores these. MAXIMUM score for Celebrity Involvement is 75 UNLESS the story involves a named celebrity in an actual aviation incident (crash, emergency, arrest). Airline news tagged as Celebrity Involvement (new routes, orders, CEO statements) scores 40-65.
- Points/miles/credit card stories: MAXIMUM 30. These are travel rewards content, not aviation drama. Reject unless the story is about a major program collapse or fraud.
- Hotel/resort reviews: MAXIMUM 15. These are not aviation content.
- "Passenger Outrage" category: Joshua's average score is 45. Score 55-75 only for genuinely dramatic incidents (assault, removal, medical emergency). Routine complaints (lost luggage, delays, refunds) score 30-50.
- "Pilot & Crew Pay" category: Joshua's average score is 38. Score 50-70 only for major strikes, contract battles, or dramatic pay reveals. Generic salary articles score 25-45.
- Reddit/forum posts ("r/", "How do I", "Tips?", "Anyone else", "RANT:", "Help me"): MAXIMUM 45. These are community posts, not news stories.
- Planespotter photos (planespotters.net, registration codes like "LY-MAU"): MAXIMUM 20. These are hobbyist content.
- Award/points redemption guides ("How to book", "Best ways to use", "Points for", "Miles for"): MAXIMUM 25.`;

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

  // ── Title gate: LLM reads the headline and decides if it's aviation-related ──
  // This runs BEFORE rule scoring and BEFORE the full scoring prompt.
  // It catches non-aviation stories (road trips, wellness, celebrity gossip, etc.)
  // that slip through the keyword gate because their content contains incidental
  // aviation words (e.g. "flight" in a sidebar link or footer).
  // Uses the 8B model with maxTokens:5 — just YES or NO.
  try {
    const titleGateResponse = await invokeLLM({
      model: scoringModel,
      messages: [
        {
          role: "system",
          content: `You are an aviation content filter for FlightDrama, an aviation Instagram account.
Answer YES if the headline is about aviation, airlines, airports, aircraft, pilots, or anything directly related to the aviation industry.
Answer NO if the headline is about road trips, motorcycles, trains, boats, canoes, hiking, wellness, food, hotels, celebrity gossip, politics, immigration, or any non-aviation topic.
Respond with ONLY the word YES or NO. Nothing else.`,
        },
        { role: "user", content: `Headline: "${title}"` },
      ],
      maxTokens: 5,
    });
    const titleGateRaw = String(titleGateResponse?.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
    const isAviation = titleGateRaw.startsWith("YES");
    if (!isAviation) {
      console.log(`[TitleGate] REJECTED non-aviation headline: "${title.slice(0, 80)}"`);
      return {
        score: 5,
        statusLabel: "reject" as ScoringResult["statusLabel"],
        category: ruleResult.category,
        viralReason: "Title gate: headline is not about aviation.",
        triggers: ["Title gate: not aviation"],
        viralExplanation: "This headline is not about aviation and was filtered before full scoring.",
        ruleScore: ruleResult.score,
        apprenticeConfidence: "High",
        apprenticeReasoning: "LLM title gate determined this headline is not aviation-related.",
        scoringMethod: "rule_based",
      };
    }
  } catch (titleGateErr) {
    // If the title gate fails, proceed with normal scoring — don't block on a gate error
    console.warn("[TitleGate] Title gate failed, proceeding with normal scoring:", titleGateErr);
  }

  try {
    const { systemPrompt, exampleTitles } = await buildScoringContext(title, ruleResult.category);
    const truncatedContent = content?.slice(0, 800) ?? ""; // 800 chars matches batch scoring — sufficient for LLM to understand the story
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
          const rawLlmScore = Math.round(parsed70b.score);
          // Step 1: Distribution normalisation — maps raw LLM score to Joshua's actual
          // score distribution. Fixes the 95-clustering problem where the LLM gives 95
          // to everything it considers good, regardless of Joshua's real scale.
          const normalisedScore = await normaliseToEditorDistribution(rawLlmScore);
          // Step 2: Stat adjustment — applies category drift + keyword boosts/penalties
          const llmScore = await applyStatAdjustments(normalisedScore, llmCategory, title);
          const derivedLabel70b = labelFromScore(llmScore) as ScoringResult["statusLabel"];
          console.log(`[LLMScoring] 70B result: 8B=${parsed8b.score} → 70B=${rawLlmScore} → stat-adj=${llmScore} label=${derivedLabel70b}`);
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
    const rawLlmScore8b = Math.round(parsed8b.score);
    // Step 1: Distribution normalisation
    const normalisedScore8b = await normaliseToEditorDistribution(rawLlmScore8b);
    // Step 2: Stat adjustment
    const llmScore = await applyStatAdjustments(normalisedScore8b, llmCategory, title);
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

  // ── Title gate: filter out non-aviation stories before the batch LLM call ──
  // Ask the 8B model to classify all titles in one call (cheaper than individual calls).
  // Stories that fail the gate get score=5/reject immediately without entering the batch.
  const titleGateReject: LLMScoringResult = {
    score: 5,
    statusLabel: "reject" as ScoringResult["statusLabel"],
    category: "Non-Aviation",
    viralReason: "Title gate: headline is not about aviation.",
    triggers: ["Title gate: not aviation"],
    viralExplanation: "This headline is not about aviation and was filtered before full scoring.",
    ruleScore: 5,
    apprenticeConfidence: "High",
    apprenticeReasoning: "LLM title gate determined this headline is not aviation-related.",
    scoringMethod: "rule_based",
  };
  let aviationStories = stories;
  const gateResults: Map<number, LLMScoringResult> = new Map();
  try {
    const titleList = stories.map((s, i) => `${i + 1}. "${s.title}"`).join("\n");
    const gateResponse = await invokeLLM({
      model: scoringModel,
      messages: [
        {
          role: "system",
          content: `You are an aviation content filter. For each numbered headline, answer YES if it is about aviation (airlines, airports, aircraft, pilots, crashes, aviation industry) or NO if it is not (road trips, trains, boats, wellness, food, hotels, celebrity gossip, politics, immigration, nature).\nRespond with ONLY a comma-separated list of YES or NO answers in order. Example: YES,NO,YES,YES,NO`,
        },
        { role: "user", content: titleList },
      ],
      maxTokens: stories.length * 5,
    });
    const gateRaw = String(gateResponse?.choices?.[0]?.message?.content ?? "").trim();
    const gateAnswers = gateRaw.split(/[,\s]+/).map(a => a.trim().toUpperCase());
    if (gateAnswers.length === stories.length) {
      aviationStories = stories.filter((_, i) => {
        const isAviation = gateAnswers[i]?.startsWith("YES");
        if (!isAviation) {
          console.log(`[TitleGate] Batch REJECTED: "${stories[i].title.slice(0, 80)}"`);
          gateResults.set(i, { ...titleGateReject, category: stories[i].ruleScore.category, ruleScore: stories[i].ruleScore.score });
        }
        return isAviation;
      });
    }
  } catch (gateErr) {
    console.warn("[TitleGate] Batch title gate failed, proceeding without gate:", gateErr);
  }
  // If all stories were filtered out, return the gate results
  if (aviationStories.length === 0) {
    return stories.map((_, i) => gateResults.get(i) ?? { ...titleGateReject, category: stories[i].ruleScore.category, ruleScore: stories[i].ruleScore.score });
  }

  // Build context using the most common category in the batch as the anchor.
  // This gives better coverage for mixed-category batches than always using the first story.
  // NOTE: We still build one shared prompt per batch (for cost efficiency), but we now
  // pull override examples for ALL unique categories in the batch, not just the dominant one.
  // This means a batch with 3 Boeing stories + 2 Passenger Outrage stories will get
  // relevant examples for both categories injected into the shared prompt.
  const categoryCounts: Record<string, number> = {};
  for (const s of aviationStories) {
    const cat = s.ruleScore.category ?? "General Aviation";
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }
  const dominantCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "General Aviation";
  const anchorStory = aviationStories.find(s => (s.ruleScore.category ?? "General Aviation") === dominantCategory) ?? aviationStories[0];

  // Collect unique categories in this batch (up to 3 to keep prompt size reasonable)
  const batchCategories = [...new Set(aviationStories.map(s => s.ruleScore.category ?? "General Aviation"))].slice(0, 3);
  const isMixedBatch = batchCategories.length > 1;

  const { systemPrompt, exampleTitles } = await buildScoringContext(
    anchorStory.title,
    dominantCategory,
    isMixedBatch ? batchCategories : undefined
  );

  // Modify system prompt for batch output
  const batchSystemPrompt = systemPrompt.replace(
    /Respond ONLY with a valid JSON object[\s\S]*/,
    `Respond ONLY with a valid JSON array of ${aviationStories.length} objects, one per story, in the same order as the input. Each object must have:
{ "score": <integer 0-100>, "statusLabel": "<must_post|strong_candidate|maybe|reject>", "category": "<category>", "viralReason": "<one sentence>", "viralExplanation": "<two to three sentences>", "triggers": ["<trigger 1>", "<trigger 2>"], "apprenticeConfidence": "<High|Medium|Low>", "apprenticeReasoning": "<one sentence on how past corrections influenced this score>" }
Return ONLY the JSON array. No other text.`
  );

  const storyList = aviationStories
    .map((s, i) => `Story ${i + 1}:\nTitle: "${s.title}"\nContent: "${s.content.slice(0, 800)}"`)
    .join("\n\n---\n\n");

  const userMessage = `Score these ${aviationStories.length} aviation stories:\n\n${storyList}`;

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
      return Promise.all(aviationStories.map(s => scoreStoryWithLLM(s.title, s.content)));
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

    if (!Array.isArray(parsedArray) || parsedArray.length !== aviationStories.length) {
      console.warn(`[LLMScoring] Batch: expected ${aviationStories.length} results, got ${parsedArray?.length ?? 0}. Falling back.`);
      return Promise.all(aviationStories.map(s => scoreStoryWithLLM(s.title, s.content)));
    }

    const validLabels = ["must_post", "strong_candidate", "maybe", "reject"];
    const aviationResults: LLMScoringResult[] = [];

    for (let i = 0; i < aviationStories.length; i++) {
      const s = aviationStories[i];
      const p = parsedArray[i];

      if (
        !p ||
        typeof p.score !== "number" ||
        p.score < 0 ||
        p.score > 100 ||
        !validLabels.includes(p.statusLabel)
      ) {
        // Invalid entry — fall back to rule-based for this story (no stat adjustment)
        aviationResults.push({
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
          aviationResults.push(verified);
          continue;
        } catch {
          // Verification failed — use batch result
        }
      }

      const llmCategory = p.category ?? s.ruleScore.category;
      const rawBatchScore = Math.min(95, Math.round(p.score));
      // Step 1: Distribution normalisation — corrects LLM score clustering at 95
      const normalisedBatchScore = await normaliseToEditorDistribution(rawBatchScore);
      // Step 2: Stat adjustment — category drift + keyword boosts/penalties
      const llmScore = await applyStatAdjustments(normalisedBatchScore, llmCategory, s.title);
      const derivedLabel = labelFromScore(llmScore) as ScoringResult["statusLabel"];
      aviationResults.push({
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

    // Merge gate-rejected results back in, preserving original order
    if (gateResults.size === 0) return aviationResults;
    const aviationIndexes = stories
      .map((_, i) => i)
      .filter(i => !gateResults.has(i));
    const finalResults: LLMScoringResult[] = new Array(stories.length);
    for (const [i, r] of gateResults) finalResults[i] = r;
    for (let j = 0; j < aviationResults.length; j++) finalResults[aviationIndexes[j]] = aviationResults[j];
    return finalResults;
  } catch (err) {
    console.error("[LLMScoring] Batch scoring failed, falling back to individual:", err);
    return Promise.all(aviationStories.map(s => scoreStoryWithLLM(s.title, s.content)));
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
    .limit(500);

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
 * THREE-LAYER EDITORIAL LEARNING SYSTEM
 *
 * Layer 1 — Direct examples (in buildScoringContext): similarity-matched past
 *   overrides injected directly into every scoring prompt. Strongest signal.
 *   Works from day 1, scales to unlimited overrides.
 *
 * Layer 2 — Structured pattern library (this function): LLM reads ALL overrides
 *   and produces a structured per-category breakdown of Joshua's scoring rules.
 *   Replaces the single prose editorial_philosophy paragraph. Stored as JSON.
 *   Scales without losing nuance — each category's rules are maintained separately.
 *
 * Layer 3 — Drift calibration offsets (this function): pure statistics, no LLM.
 *   Computes per-category average drift (Joshua's score minus AI score) across
 *   all historical overrides. Stored as JSON offsets. Applied as a pre-LLM
 *   calibration step so systematic biases are corrected automatically.
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
  const lastLearnedAt = config["last_learned_at"] ?? null;

  // ── Fetch ALL overrides — no cap ─────────────────────────────────────────
  const allOverrides = await getOverrideExamplesFromDb();

  if (allOverrides.length < 3) {
    return {
      success: false,
      summary: "Not enough override examples yet — override at least 3 stories before running this.",
      examplesUsed: 0,
    };
  }

  // ── LAYER 3: Compute drift calibration offsets (free, no LLM) ────────────
  // For each category, compute: average(Joshua's score - AI's score)
  // This tells us how systematically wrong the AI is per category.
  // e.g. "Aviation Safety: AI scores +12 too high on average" → apply -12 offset
  const driftByCategory: Record<string, { totalDrift: number; count: number; avgJoshua: number; totalJoshua: number }> = {};
  for (const ex of allOverrides) {
    if (ex.overrideScore === null || ex.viralScore === null) continue;
    const cat = ex.category ?? "General Aviation";
    if (!driftByCategory[cat]) driftByCategory[cat] = { totalDrift: 0, count: 0, avgJoshua: 0, totalJoshua: 0 };
    driftByCategory[cat].totalDrift += ex.overrideScore - ex.viralScore;
    driftByCategory[cat].totalJoshua += ex.overrideScore;
    driftByCategory[cat].count++;
  }

  const calibrationOffsets: Record<string, { offset: number; avgJoshua: number; sampleSize: number }> = {};
  for (const [cat, data] of Object.entries(driftByCategory)) {
    if (data.count < 3) continue; // need at least 3 examples to trust the offset
    calibrationOffsets[cat] = {
      offset: Math.round(data.totalDrift / data.count), // positive = AI undervalues, negative = AI overvalues
      avgJoshua: Math.round(data.totalJoshua / data.count),
      sampleSize: data.count,
    };
  }

  // Save drift offsets to scoring_config
  await setScoringConfig("drift_calibration_offsets", JSON.stringify(calibrationOffsets));
  console.log(`[DeepLearn] Drift offsets computed for ${Object.keys(calibrationOffsets).length} categories from ${allOverrides.length} overrides`);

  // ── LAYER 2: Build structured pattern library (LLM) ──────────────────────
  // Smart selection: representative sample across all overrides
  // - Most recent 30 (current taste)
  // - Highest drift 15 (most instructive — where AI was most wrong)
  // - Per-category representatives: up to 3 per category not already selected
  // - Oldest 5 (historical baseline)
  const byRecent = [...allOverrides].sort((a, b) =>
    (b.updatedAt ? new Date(b.updatedAt).getTime() : 0) - (a.updatedAt ? new Date(a.updatedAt).getTime() : 0)
  );
  const byDrift = [...allOverrides].sort((a, b) =>
    Math.abs((b.overrideScore ?? 0) - (b.viralScore ?? 0)) - Math.abs((a.overrideScore ?? 0) - (a.viralScore ?? 0))
  );
  const byOldest = [...allOverrides].sort((a, b) =>
    (a.updatedAt ? new Date(a.updatedAt).getTime() : 0) - (b.updatedAt ? new Date(b.updatedAt).getTime() : 0)
  );

  const selectedIds = new Set<number>();
  const filteredExamples: typeof allOverrides = [];
  const catCounts: Record<string, number> = {};

  // Add recent, high-drift, and oldest first
  for (const ex of [...byRecent.slice(0, 30), ...byDrift.slice(0, 15), ...byOldest.slice(0, 5)]) {
    if (ex.id && !selectedIds.has(ex.id)) {
      selectedIds.add(ex.id);
      filteredExamples.push(ex);
      const cat = ex.category ?? "unknown";
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }
  }

  // Fill remaining slots with per-category representatives (up to 3 per category not yet represented)
  for (const ex of allOverrides) {
    if (filteredExamples.length >= 60) break;
    if (!ex.id || selectedIds.has(ex.id)) continue;
    const cat = ex.category ?? "unknown";
    if ((catCounts[cat] ?? 0) < 3) {
      selectedIds.add(ex.id);
      filteredExamples.push(ex);
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }
  }

  const validExamples = filteredExamples
    .filter(e => e.overrideScore !== null && e.overrideLabel !== null);

  if (validExamples.length === 0) {
    return {
      success: true,
      summary: "No override examples available — pattern library unchanged.",
      examplesUsed: 0,
    };
  }

  const historicalPostsData = await getHistoricalPosts(30);
  const postsWithMetrics = historicalPostsData.filter(p => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0);
  const rankedPosts = postsWithMetrics
    .map(p => ({ ...p, _perf: calculatePerformanceScore(p) }))
    .filter(p => p._perf > 0)
    .sort((a, b) => b._perf - a._perf);

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  // Group examples by category for the prompt
  const byCategory: Record<string, typeof validExamples> = {};
  for (const ex of validExamples) {
    const cat = ex.category ?? "General Aviation";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(ex);
  }

  const examplesText = Object.entries(byCategory)
    .sort((a, b) => b[1].length - a[1].length) // most examples first
    .map(([cat, exs]) => {
      const lines = exs.map(e => {
        const drift = (e.overrideScore ?? 0) - (e.viralScore ?? 0);
        const driftStr = drift > 0 ? `+${drift}` : `${drift}`;
        const recency = e.updatedAt && (now - new Date(e.updatedAt).getTime()) < thirtyDaysMs ? " [recent]" : "";
        return `  - ${recency}"${e.title?.slice(0, 90)}" | AI:${e.viralScore}→Joshua:${e.overrideScore} (drift:${driftStr}) | ${e.overrideLabel}`;
      }).join("\n");
      const catOffset = calibrationOffsets[cat];
      const offsetNote = catOffset ? ` [avg drift: ${catOffset.offset > 0 ? "+" : ""}${catOffset.offset} pts across ${catOffset.sampleSize} overrides]` : "";
      return `### ${cat}${offsetNote}\n${lines}`;
    })
    .join("\n\n");

  const instagramText = rankedPosts.length > 0
    ? `\n\n## Real FlightDrama Instagram Performance (secondary context)\nTOP PERFORMERS:\n${rankedPosts.slice(0, 10).map((p, i) => {
        const stats = [p.views ? `${Math.round(p.views/1000)}k views` : null, p.likes ? `${p.likes} likes` : null].filter(Boolean).join(" | ");
        return `#${i+1} "${p.headline}" | ${p.category ?? "unknown"} | ${stats}`;
      }).join("\n")}`
    : "";

  const previousPatternLibrary = config["pattern_library"] ?? null;
  const previousBlock = previousPatternLibrary
    ? `\n\n## Previously Established Pattern Library (REFINE — do NOT discard categories that have no new examples)\n${previousPatternLibrary}\n\nRefine with the new examples. Keep rules that still hold. Update rules the new examples contradict. Add new categories if new patterns emerge.`
    : "";

  const systemPrompt = `You are an expert editorial analyst for FlightDrama, an aviation Instagram/TikTok/YouTube account.${previousBlock}

Your job is to build a STRUCTURED PATTERN LIBRARY from Joshua's score corrections.
This is NOT a prose summary — it is a structured set of rules per story category.
Each category must have: a score range, the key factors that push scores up or down, and what Joshua rejects.
Be specific and concrete. Use the actual examples to derive the rules.
The Instagram performance data is secondary context — Joshua's explicit corrections are the primary signal.

CRITICAL CALIBRATION FACTS (derived from statistical analysis of all 500+ overrides):
- "Celebrity Involvement" average Joshua score: 38. The AI over-scores this category by ~50 points. Cap at 75 unless actual aviation incident.
- "Passenger Outrage" average Joshua score: 45. Routine complaints score 30-50. Dramatic incidents (assault, removal) score 55-75.
- "Pilot & Crew Pay" average Joshua score: 38. Generic salary articles score 25-45. Major strikes/contracts score 50-70.
- Points/miles/credit card content: Joshua rejects these (score 5-25). Not aviation drama.
- Reddit/forum posts: Joshua scores these 20-45 maximum. Not publishable news.
- Overall drift: AI scores 25 pts HIGHER than Joshua on average. The pattern library MUST correct for this downward.`;

  const userMessage = `Analyse these ${validExamples.length} editor override examples (grouped by category) and build a structured pattern library:

${examplesText}${instagramText}

Return ONLY a JSON object with these fields:

1. "pattern_library" (string): A structured breakdown per category. For EACH category with enough data, write:
   CATEGORY NAME: [score range Joshua gives] | Key boosters: [what pushes score up] | Key killers: [what drops the score] | Reject if: [specific conditions]
   Write one line per category. Be specific — use actual patterns from the examples, not generic advice.
   Example format: "Passenger Outrage: 65-85 | Boosters: specific money figure, named airline, duration stated | Killers: vague complaint, no resolution | Reject if: no aviation element, just general travel complaint"

2. "editorial_philosophy" (string): A 2-3 paragraph plain-English summary of Joshua's overall taste that works ACROSS all categories. This is the fallback for story types not in the pattern library.

3. "summary" (string): One sentence describing the most important pattern found or reinforced.

4. "examples_used" (integer): Count of examples analysed.

IMPORTANT: All field values must be plain text. Do NOT use backticks, markdown headers, or code blocks inside string values. Use pipe characters (|) as separators in the pattern_library field.`;

  try {
    const response = await invokeLLM({
      model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      maxTokens: 3000,
      responseFormat: { type: "json_object" },
    });

    const raw = response?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== "string") {
      return { success: false, summary: "LLM returned empty response.", examplesUsed: validExamples.length };
    }

    let parsed: {
      pattern_library: string;
      editorial_philosophy: string;
      summary: string;
      examples_used?: number;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // Try extracting JSON block
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) {
        return { success: false, summary: "Could not parse LLM response — no JSON block found.", examplesUsed: validExamples.length };
      }
      try {
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as typeof parsed;
      } catch {
        return { success: false, summary: "Could not parse LLM response — JSON malformed.", examplesUsed: validExamples.length };
      }
    }

    if (!parsed.pattern_library && !parsed.editorial_philosophy) {
      return { success: false, summary: "LLM returned empty pattern library.", examplesUsed: validExamples.length };
    }

    await Promise.all([
      setScoringConfig("pattern_library", parsed.pattern_library ?? ""),
      setScoringConfig("editorial_philosophy", parsed.editorial_philosophy ?? ""),
      setScoringConfig("last_learned_at", new Date().toISOString()),
      setScoringConfig("last_learned_examples_count", String(validExamples.length)),
      setScoringConfig("total_override_count", String(allOverrides.length)),
    ]);

    console.log(`[DeepLearn] Pattern library + philosophy updated from ${validExamples.length} selected / ${allOverrides.length} total overrides. Summary: ${parsed.summary}`);

    return {
      success: true,
      summary: parsed.summary ?? `Pattern library updated from ${allOverrides.length} total overrides (${validExamples.length} analysed).`,
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
