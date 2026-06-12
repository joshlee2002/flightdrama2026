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
import { getOverrideExamplesFromDb, getAllScoringConfig, setScoringConfig, getDb } from "./db";
import { scoreStory, applyStatAdjustments, type ScoringResult } from "./viralScoring";
import { stories } from "../drizzle/schema";
import { and, desc, isNotNull, sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LLMScoringResult = ScoringResult & {
  scoringMethod: "rule_based" | "llm_assisted";
};

// ── Build scoring prompt ──────────────────────────────────────────────────────

async function buildScoringContext(): Promise<{ systemPrompt: string; hasExamples: boolean }> {
  const [examples, config] = await Promise.all([
    getOverrideExamplesFromDb(20),
    getAllScoringConfig(),
  ]);

  const learnedRules = config["learned_scoring_rules"] ?? null;
  const learnedWeights = config["learned_category_weights"] ?? null;
  const learnedInsights = config["learned_editor_insights"] ?? null;
  // Statistical learner output
  const statWeights = config["stat_category_weights"] ?? null;
  const statKeywordBoosts = config["stat_keyword_boosts"] ?? null;
  const statKeywordPenalties = config["stat_keyword_penalties"] ?? null;

  const examplesBlock =
    examples.length > 0
      ? examples
          .filter(e => e.overrideScore !== null && e.overrideLabel !== null)
          .map(
            (e, i) =>
              `Example ${i + 1}:\n  Title: "${e.title}"\n  Rule-based score: ${e.viralScore}\n  Editor override: ${e.overrideScore} (${e.overrideLabel})\n  Category: ${e.category ?? "unknown"}`
          )
          .join("\n\n")
      : null;

  let systemPrompt = `You are a viral content scoring engine for FlightDrama, an aviation news social media account.

Your job is to score how likely a story is to go viral on social media (Instagram/TikTok/YouTube Shorts) among a general audience interested in aviation drama, safety failures, weird passenger behaviour, and surprising aviation facts.

Score from 0–100 where:
- 88–100 = must_post (extremely viral: shocking safety failure, celebrity, major outrage, death toll, record-breaking)
- 70–87 = strong_candidate (very shareable: Boeing drama, pilot pay, passenger outrage, weird incident)
- 55–69 = maybe (moderately interesting: route news with a hook, minor controversy)
- 0–54 = reject (routine: schedule changes, earnings reports, generic fleet updates)
- AUTOMATIC REJECT (score 0-15): listicles ("best hotels", "top 10", "X things you didn't know"), travel guides, product reviews, opinion columns with no concrete news event, sponsored content, award announcements with no newsworthy context, and any article whose headline starts with a number followed by a noun (e.g. "16 Hotels...", "5 Reasons...", "10 Best...").`;

  if (learnedRules) {
    systemPrompt += `\n\n## Learned Scoring Rules (from editor override analysis)\n${learnedRules}`;
  }

  if (learnedWeights) {
    systemPrompt += `\n\n## Learned Category Weights\n${learnedWeights}`;
  }

  if (learnedInsights) {
    systemPrompt += `\n\n## Editor Preferences\n${learnedInsights}`;
  }

  // Inject statistical learner output if available (free, always up-to-date)
  if (statWeights || statKeywordBoosts || statKeywordPenalties) {
    systemPrompt += `\n\n## Statistical Learning (auto-updated from override history, no LLM cost)`;
    if (statWeights) systemPrompt += `\nCategory score adjustments: ${statWeights}`;
    if (statKeywordBoosts) systemPrompt += `\nKeywords editor consistently scores HIGHER: ${statKeywordBoosts}`;
    if (statKeywordPenalties) systemPrompt += `\nKeywords editor consistently scores LOWER: ${statKeywordPenalties}`;
  }

  if (examplesBlock) {
    systemPrompt += `\n\n## Recent Editor Overrides (few-shot examples)\nThe editor has manually corrected these scores — learn from the pattern:\n\n${examplesBlock}`;
  }

  systemPrompt += `\n\nRespond ONLY with a valid JSON object in this exact format:
{
  "score": <integer 0-100>,
  "statusLabel": "<must_post|strong_candidate|maybe|reject>",
  "category": "<category string>",
  "viralReason": "<one sentence explanation>",
  "triggers": ["<trigger 1>", "<trigger 2>"]
}`;

  return { systemPrompt, hasExamples: examples.length > 0 || !!learnedRules || !!statWeights };
}

// ── Score a single story ──────────────────────────────────────────────────────

/**
 * Score a story using the LLM with learned rules + override examples as context.
 * Falls back to rule-based scoring if the LLM call fails.
 */
export async function scoreStoryWithLLM(
  title: string,
  content: string
): Promise<LLMScoringResult> {
  const ruleResult = scoreStory(title, content);

  try {
    const { systemPrompt } = await buildScoringContext();
    const truncatedContent = content?.slice(0, 1200) ?? "";
    const userMessage = `Score this aviation story:\n\nTitle: "${title}"\n\nContent excerpt: "${truncatedContent}"`;

    const response = await invokeLLM({
      model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw = response?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== "string") {
      console.warn("[LLMScoring] Empty response, falling back to rule-based");
      return { ...ruleResult, scoringMethod: "rule_based" };
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[LLMScoring] No JSON found in response, falling back");
      return { ...ruleResult, scoringMethod: "rule_based" };
    }

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
    ) {
      console.warn("[LLMScoring] Invalid response shape, falling back");
      return { ...ruleResult, scoringMethod: "rule_based" };
    }

    const llmCategory = parsed.category ?? ruleResult.category;
    const llmScore = Math.round(parsed.score);
    const statAdjustedScore = await applyStatAdjustments(llmScore, llmCategory, title);
    return {
      score: statAdjustedScore,
      statusLabel: parsed.statusLabel as ScoringResult["statusLabel"],
      category: llmCategory,
      viralReason: parsed.viralReason ?? ruleResult.viralReason,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers : ruleResult.triggers,
      viralExplanation: parsed.viralExplanation ?? ruleResult.viralExplanation,
      scoringMethod: "llm_assisted",
    };
  } catch (err) {
    console.error("[LLMScoring] Error calling LLM, falling back to rule-based:", err);
    // Apply stat adjustments to rule-based fallback too
    const statAdjustedScore = await applyStatAdjustments(ruleResult.score, ruleResult.category, title);
    return { ...ruleResult, score: statAdjustedScore, scoringMethod: "rule_based" };
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
  const SIGNIFICANT_DRIFT = 10; // only count overrides with ≥10 point drift

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

  const examples = await getOverrideExamplesFromDb(50);

  if (examples.length < 3) {
    return {
      success: false,
      summary: "Not enough override examples yet — override at least 3 stories before running this.",
      examplesUsed: 0,
    };
  }

  const validExamples = examples.filter(e => e.overrideScore !== null && e.overrideLabel !== null);

  const examplesText = validExamples
    .map(
      (e, i) =>
        `${i + 1}. Title: "${e.title}"\n   Rule-based score: ${e.viralScore} | Editor score: ${e.overrideScore} (${e.overrideLabel})\n   Category: ${e.category ?? "unknown"}\n   Rule reason: ${e.viralReason ?? "none"}`
    )
    .join("\n\n");

  const systemPrompt = `You are an expert editorial analyst for FlightDrama, an aviation social media account.

You will be given a list of aviation stories where the editor manually overrode the automated viral score. Your job is to analyse the patterns in these overrides and produce:

1. **Improved scoring rules** — specific, actionable rules that better match the editor's taste. These should be more nuanced than the original keyword-based system. Include what types of stories score higher or lower than the rule-based system expected.

2. **Category weights** — which story categories the editor consistently scores higher or lower than the automated system.

3. **Editor insights** — a short paragraph describing the editor's overall taste and what makes them override scores up vs down.

Be specific and concrete. Reference actual patterns from the examples. These rules will be used to score future stories.`;

  const userMessage = `Here are ${validExamples.length} stories where the editor overrode the automated score:\n\n${examplesText}\n\nAnalyse the patterns and produce improved scoring rules. Return ONLY a JSON object with these four string fields:\n- learned_scoring_rules: detailed rules (use plain text, no markdown formatting, no backticks)\n- learned_category_weights: category adjustments (plain text list)\n- learned_editor_insights: paragraph about editor taste (plain text)\n- summary: one sentence summary of what was learned\n\nIMPORTANT: All field values must be plain text strings. Do NOT use backticks, code blocks, or special characters inside the JSON values.`;

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

    let parsed: { learned_scoring_rules: string; learned_category_weights: string; learned_editor_insights: string; summary: string };
    try {
      parsed = JSON.parse(jsonStr) as {
        learned_scoring_rules: string;
        learned_category_weights: string;
        learned_editor_insights: string;
        summary: string;
      };
    } catch (parseErr) {
      // Last resort: try to extract each field with regex
      console.warn("[LLMScoring] JSON.parse failed, trying field extraction:", parseErr);
      const extract = (key: string) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'));
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

    // Persist each piece to scoring_config
    await Promise.all([
      setScoringConfig("learned_scoring_rules", parsed.learned_scoring_rules ?? ""),
      setScoringConfig("learned_category_weights", parsed.learned_category_weights ?? ""),
      setScoringConfig("learned_editor_insights", parsed.learned_editor_insights ?? ""),
      setScoringConfig("last_learned_at", new Date().toISOString()),
      setScoringConfig("last_learned_examples_count", String(validExamples.length)),
    ]);

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
