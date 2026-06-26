/**
 * Performance Analysis — analyses historical post metrics to identify
 * winning viral angles, headline patterns, and content styles, then
 * stores the insights in scoring_config for injection into Soyunci prompts.
 */

import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { getHistoricalPosts, getExampleArticles, setScoringConfig, getScoringConfig } from "./db";

export interface PerformanceInsights {
  topAngles: string[];
  headlinePatterns: string[];
  topCategories: string[];
  writingTips: string[];
  summary: string;
  analysedAt: string;
  postsAnalysed: number;
}

/** Minimum posts needed before analysis is meaningful */
const MIN_POSTS_FOR_ANALYSIS = 3;

// ── Statistical performance insights (free, no LLM) ─────────────────────────

export interface StatPerformanceInsights {
  /** Top categories ranked by avg engagement score */
  topCategories: Array<{ category: string; avgEngagement: number; count: number; avgLikes: number }>;
  /** Top viral angles ranked by avg engagement */
  topAngles: Array<{ angle: string; avgEngagement: number; count: number }>;
  /** Keywords that appear in high-engagement headlines */
  highEngagementKeywords: string[];
  /** Keywords that appear in low-engagement headlines */
  lowEngagementKeywords: string[];
  /** Best posting times by avg engagement */
  bestPostingTimes: Array<{ time: string; avgEngagement: number; count: number }>;
  /** Overall stats */
  totalPosts: number;
  avgEngagement: number;
  topEngagementScore: number;
  analysedAt: string;
}

/**
 * Free statistical performance analysis — no LLM, no cost.
 * Reads historical_posts and computes engagement patterns purely from data.
 * Results are stored in scoring_config and injected into:
 * - scoreStory() rule-based scoring (category/keyword boosts)
 * - Soyunci article writer (headline patterns, top angles)
 * - Keyword feed regeneration trigger
 *
 * Auto-runs on every historical post upload/update.
 */
export async function analysePerformanceStatistical(): Promise<StatPerformanceInsights | null> {
  const allPosts = await getHistoricalPosts(500);
  const postsWithMetrics = allPosts.filter(
    (p) => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0
  );

  if (postsWithMetrics.length < 2) {
    console.log(`[StatPerf] Not enough posts with metrics yet (${postsWithMetrics.length})`);
    return null;
  }

  const scored = postsWithMetrics.map(p => ({ ...p, _eng: engagementScore(p) }));
  const avgEngagement = scored.reduce((s, p) => s + p._eng, 0) / scored.length;
  const topEngagementScore = Math.max(...scored.map(p => p._eng));

  // ── 1. Category analysis ────────────────────────────────────────────────
  const catMap: Record<string, { total: number; count: number; totalLikes: number }> = {};
  for (const p of scored) {
    const cat = p.category ?? "General Aviation";
    if (!catMap[cat]) catMap[cat] = { total: 0, count: 0, totalLikes: 0 };
    catMap[cat].total += p._eng;
    catMap[cat].count++;
    catMap[cat].totalLikes += p.likes ?? 0;
  }
  const topCategories = Object.entries(catMap)
    .filter(([, v]) => v.count >= 1)
    .map(([category, v]) => ({
      category,
      avgEngagement: Math.round(v.total / v.count),
      count: v.count,
      avgLikes: Math.round(v.totalLikes / v.count),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 10);

  // ── 2. Viral angle analysis ──────────────────────────────────────────────
  const angleMap: Record<string, { total: number; count: number }> = {};
  for (const p of scored) {
    if (!p.viralAngle) continue;
    const angle = p.viralAngle.trim();
    if (!angleMap[angle]) angleMap[angle] = { total: 0, count: 0 };
    angleMap[angle].total += p._eng;
    angleMap[angle].count++;
  }
  const topAngles = Object.entries(angleMap)
    .filter(([, v]) => v.count >= 1)
    .map(([angle, v]) => ({
      angle,
      avgEngagement: Math.round(v.total / v.count),
      count: v.count,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 10);

  // ── 3. Headline keyword analysis ─────────────────────────────────────────
  // Split posts into top 30% and bottom 30% by engagement
  const sortedByEng = [...scored].sort((a, b) => b._eng - a._eng);
  const topThird = sortedByEng.slice(0, Math.max(1, Math.floor(sortedByEng.length * 0.3)));
  const bottomThird = sortedByEng.slice(Math.floor(sortedByEng.length * 0.7));

  const stopWords = new Set([
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "by","from","as","is","was","are","were","be","been","have","has","had",
    "do","does","did","will","would","could","should","this","that","it",
    "its","he","she","they","we","you","after","before","about","over",
    "not","no","so","if","then","than","when","all","new","first","last",
  ]);

  function countWords(posts: typeof topThird): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const p of posts) {
      const words = (p.headline ?? "").toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
      for (const w of words) {
        if (!stopWords.has(w) && w.length > 3) {
          counts[w] = (counts[w] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  const topWords = countWords(topThird);
  const bottomWords = countWords(bottomThird);

  const highEngagementKeywords = Object.entries(topWords)
    .filter(([kw, cnt]) => cnt >= 2 && (bottomWords[kw] ?? 0) < cnt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw]) => kw);

  const lowEngagementKeywords = Object.entries(bottomWords)
    .filter(([kw, cnt]) => cnt >= 2 && (topWords[kw] ?? 0) < cnt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw]) => kw);

  // ── 4. Posting time analysis ─────────────────────────────────────────────
  const timeMap: Record<string, { total: number; count: number }> = {};
  for (const p of scored) {
    if (!p.postingTime) continue;
    const time = p.postingTime.trim();
    if (!timeMap[time]) timeMap[time] = { total: 0, count: 0 };
    timeMap[time].total += p._eng;
    timeMap[time].count++;
  }
  const bestPostingTimes = Object.entries(timeMap)
    .filter(([, v]) => v.count >= 1)
    .map(([time, v]) => ({
      time,
      avgEngagement: Math.round(v.total / v.count),
      count: v.count,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 5);

  const insights: StatPerformanceInsights = {
    topCategories,
    topAngles,
    highEngagementKeywords,
    lowEngagementKeywords,
    bestPostingTimes,
    totalPosts: postsWithMetrics.length,
    avgEngagement: Math.round(avgEngagement),
    topEngagementScore,
    analysedAt: new Date().toISOString(),
  };

  // ── 5. Override Calibration Analysis ─────────────────────────────────────
  // Compare editor's override scores against the true performance score
  let totalOverrides = 0;
  let overrideDriftSum = 0;
  let ruleDriftSum = 0;
  
  const catDriftMap: Record<string, { total: number; count: number }> = {};
  
  // To do this properly, we need the original viralScore and overrideScore from the stories table
  // Since we only have historical_posts here, we'll approximate it by comparing 
  // the true performance score to the AI's rule-based score (which we can recalculate)
  // The actual calibration insight will be built in the router where we have both tables.

  // ── 6. Persist to scoring_config ─────────────────────────────────────────
  // Category boosts: for each top category, compute how much above average it is
  const catBoosts = topCategories
    .filter(c => c.avgEngagement > avgEngagement * 1.1) // only categories 10%+ above avg
    .map(c => `${c.category}: +${Math.round(((c.avgEngagement / avgEngagement) - 1) * 100)}% above avg (${c.count} posts, avg ${c.avgLikes} likes)`)
    .join("; ");

  const catPenalties = topCategories
    .filter(c => c.avgEngagement < avgEngagement * 0.7) // categories 30%+ below avg
    .map(c => `${c.category}: ${Math.round(((c.avgEngagement / avgEngagement) - 1) * 100)}% below avg`)
    .join("; ");

  await Promise.all([
    setScoringConfig("stat_perf_top_categories", JSON.stringify(topCategories.slice(0, 8))),
    setScoringConfig("stat_perf_top_angles", JSON.stringify(topAngles.slice(0, 8))),
    setScoringConfig("stat_perf_high_keywords", highEngagementKeywords.join(", ")),
    setScoringConfig("stat_perf_low_keywords", lowEngagementKeywords.join(", ")),
    setScoringConfig("stat_perf_best_times", JSON.stringify(bestPostingTimes)),
    setScoringConfig("stat_perf_cat_boosts", catBoosts || "none yet"),
    setScoringConfig("stat_perf_cat_penalties", catPenalties || "none yet"),
    setScoringConfig("stat_perf_avg_engagement", String(Math.round(avgEngagement))),
    setScoringConfig("stat_perf_analysed_at", insights.analysedAt),
    setScoringConfig("stat_perf_posts_count", String(postsWithMetrics.length)),
  ]);

  console.log(`[StatPerf] Analysis complete — ${postsWithMetrics.length} posts, avg engagement ${Math.round(avgEngagement)}, top category: ${topCategories[0]?.category ?? "none"}`);

  return insights;
}

/**
 * Load the latest statistical performance insights from scoring_config.
 */
export async function getStatPerformanceInsights(): Promise<StatPerformanceInsights | null> {
  const analysedAt = await getScoringConfig("stat_perf_analysed_at");
  if (!analysedAt) return null;
  const tryParse = <T>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  };
  return {
    topCategories: tryParse(await getScoringConfig("stat_perf_top_categories"), []),
    topAngles: tryParse(await getScoringConfig("stat_perf_top_angles"), []),
    highEngagementKeywords: (await getScoringConfig("stat_perf_high_keywords") ?? "").split(", ").filter(Boolean),
    lowEngagementKeywords: (await getScoringConfig("stat_perf_low_keywords") ?? "").split(", ").filter(Boolean),
    bestPostingTimes: tryParse(await getScoringConfig("stat_perf_best_times"), []),
    totalPosts: parseInt(await getScoringConfig("stat_perf_posts_count") ?? "0", 10),
    avgEngagement: parseInt(await getScoringConfig("stat_perf_avg_engagement") ?? "0", 10),
    topEngagementScore: 0,
    analysedAt,
  };
}

/** Debounce: don't re-analyse if last analysis was within this many ms */
const ANALYSIS_DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes

// ── Free article style analyser ──────────────────────────────────────────────

export interface ArticleStyleInsights {
  /** Most common sentence openers (first 2-3 words of each sentence) */
  topSentenceOpeners: string[];
  /** Power words that appear frequently in high-engagement articles */
  powerWords: string[];
  /** Words to avoid (appear in low-engagement articles only) */
  avoidWords: string[];
  /** Average sentence length in words */
  avgSentenceLength: number;
  /** Most common 2-3 word phrases across all articles */
  topPhrases: string[];
  /** Structural patterns detected (e.g. "starts with number", "ends with question") */
  structuralPatterns: string[];
  /** Total articles analysed */
  totalArticles: number;
  analysedAt: string;
}

/**
 * Analyses article text from historical_posts and example_articles to extract
 * writing style patterns — sentence openers, power words, phrase frequency,
 * sentence length, and structural patterns.
 *
 * Entirely free — no LLM, no cost. Runs on every article upload.
 * Results are stored in scoring_config and injected into the Soyunci writer.
 */
export async function analyseArticleStyle(): Promise<ArticleStyleInsights | null> {
  // Gather all article texts: historical posts + example articles
  const [historicalPosts, exampleArticles] = await Promise.all([
    getHistoricalPosts(500),
    getExampleArticles(),
  ]);

  // Collect texts, pairing with engagement score where available
  type TextWithScore = { text: string; score: number };
  const allTexts: TextWithScore[] = [];

  for (const p of historicalPosts) {
    const text = [p.article, p.articleSnippet].filter(Boolean).join(" ").trim();
    if (text.length < 50) continue;
    const score = engagementScore(p);
    allTexts.push({ text, score });
  }
  for (const ex of exampleArticles) {
    if ((ex.articleText?.length ?? 0) < 50) continue;
    // Example articles are editor-curated best examples — treat as high engagement
    allTexts.push({ text: ex.articleText, score: 9999 });
  }

  if (allTexts.length < 1) {
    console.log("[ArticleStyle] No article texts available yet — upload articles to enable style learning");
    return null;
  }

  // Sort by score; split into high/low engagement groups
  const sorted = [...allTexts].sort((a, b) => b.score - a.score);
  const highGroup = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.5)));
  const lowGroup = sorted.slice(Math.ceil(sorted.length * 0.5));

  const stopWords = new Set([
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "by","from","as","is","was","are","were","be","been","have","has","had",
    "do","does","did","will","would","could","should","this","that","it",
    "its","he","she","they","we","you","after","before","about","over",
    "not","no","so","if","then","than","when","all","new","first","last",
    "also","just","more","into","out","up","down","off","very","too",
  ]);

  // ── 1. Sentence splitting ─────────────────────────────────────────────────
  function splitSentences(text: string): string[] {
    return text
      .replace(/\n+/g, " ")
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.split(/\s+/).length >= 3);
  }

  // ── 2. Sentence openers (first 2 words of each sentence) ─────────────────
  const openerCounts: Record<string, number> = {};
  let totalSentences = 0;
  let totalWords = 0;

  for (const { text } of highGroup) {
    const sentences = splitSentences(text);
    for (const s of sentences) {
      totalSentences++;
      const words = s.split(/\s+/);
      totalWords += words.length;
      if (words.length >= 2) {
        const opener = words.slice(0, 2).join(" ").toLowerCase().replace(/[^a-z ]/g, "");
        if (opener.length > 3) openerCounts[opener] = (openerCounts[opener] ?? 0) + 1;
      }
    }
  }

  const topSentenceOpeners = Object.entries(openerCounts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([opener]) => opener);

  const avgSentenceLength = totalSentences > 0 ? Math.round(totalWords / totalSentences) : 0;

  // ── 3. Power words (appear in high group but not low group) ───────────────
  function countWordFreq(texts: TextWithScore[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { text } of texts) {
      const words = text.toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
      const seen = new Set<string>();
      for (const w of words) {
        if (!stopWords.has(w) && w.length > 3 && !seen.has(w)) {
          counts[w] = (counts[w] ?? 0) + 1;
          seen.add(w);
        }
      }
    }
    return counts;
  }

  const highFreq = countWordFreq(highGroup);
  const lowFreq = countWordFreq(lowGroup);

  const powerWords = Object.entries(highFreq)
    .filter(([w, c]) => c >= 2 && (lowFreq[w] ?? 0) < c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([w]) => w);

  const avoidWords = Object.entries(lowFreq)
    .filter(([w, c]) => c >= 2 && (highFreq[w] ?? 0) < c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w);

  // ── 4. Top 2-3 word phrases ───────────────────────────────────────────────
  const phraseCounts: Record<string, number> = {};
  for (const { text } of highGroup) {
    const words = text.toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
    for (let i = 0; i < words.length - 2; i++) {
      const w1 = words[i], w2 = words[i + 1], w3 = words[i + 2];
      if (!stopWords.has(w1) && !stopWords.has(w3)) {
        const bigram = `${w1} ${w2}`;
        const trigram = `${w1} ${w2} ${w3}`;
        if (w1.length > 3 && w2.length > 3) phraseCounts[bigram] = (phraseCounts[bigram] ?? 0) + 1;
        if (w1.length > 3 && w3.length > 3) phraseCounts[trigram] = (phraseCounts[trigram] ?? 0) + 1;
      }
    }
  }
  const topPhrases = Object.entries(phraseCounts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([phrase]) => phrase);

  // ── 5. Structural patterns ────────────────────────────────────────────────
  const structuralPatterns: string[] = [];
  const allHighSentences = highGroup.flatMap(({ text }) => splitSentences(text));
  const total = allHighSentences.length || 1;

  const startsWithNumber = allHighSentences.filter(s => /^\d/.test(s)).length;
  if (startsWithNumber / total > 0.1) structuralPatterns.push(`${Math.round(startsWithNumber / total * 100)}% of sentences start with a number`);

  const endsWithQuestion = allHighSentences.filter(s => s.endsWith("?")).length;
  if (endsWithQuestion / total > 0.05) structuralPatterns.push(`${Math.round(endsWithQuestion / total * 100)}% of sentences end with a question`);

  const hasQuotes = allHighSentences.filter(s => /["\u201c\u201d]/.test(s)).length;
  if (hasQuotes / total > 0.1) structuralPatterns.push(`${Math.round(hasQuotes / total * 100)}% of sentences contain direct quotes`);

  const shortSentences = allHighSentences.filter(s => s.split(/\s+/).length <= 8).length;
  if (shortSentences / total > 0.3) structuralPatterns.push(`${Math.round(shortSentences / total * 100)}% of sentences are short (≤8 words) — punchy style`);

  const longSentences = allHighSentences.filter(s => s.split(/\s+/).length >= 20).length;
  if (longSentences / total > 0.2) structuralPatterns.push(`${Math.round(longSentences / total * 100)}% of sentences are long (≥20 words) — detailed style`);

  const insights: ArticleStyleInsights = {
    topSentenceOpeners,
    powerWords,
    avoidWords,
    avgSentenceLength,
    topPhrases,
    structuralPatterns,
    totalArticles: allTexts.length,
    analysedAt: new Date().toISOString(),
  };

  // ── Persist to scoring_config ─────────────────────────────────────────────
  await Promise.all([
    setScoringConfig("style_sentence_openers", topSentenceOpeners.slice(0, 10).join(", ")),
    setScoringConfig("style_power_words", powerWords.slice(0, 20).join(", ")),
    setScoringConfig("style_avoid_words", avoidWords.slice(0, 10).join(", ")),
    setScoringConfig("style_avg_sentence_length", String(avgSentenceLength)),
    setScoringConfig("style_top_phrases", topPhrases.slice(0, 15).join(", ")),
    setScoringConfig("style_structural_patterns", structuralPatterns.join(" | ")),
    setScoringConfig("style_articles_count", String(allTexts.length)),
    setScoringConfig("style_analysed_at", insights.analysedAt),
  ]);

  console.log(`[ArticleStyle] Analysis complete — ${allTexts.length} articles, avg sentence length ${avgSentenceLength} words, ${powerWords.length} power words identified`);
  return insights;
}

/**
 * Load the latest article style insights from scoring_config.
 */
export async function getArticleStyleInsights(): Promise<ArticleStyleInsights | null> {
  const analysedAt = await getScoringConfig("style_analysed_at");
  if (!analysedAt) return null;
  return {
    topSentenceOpeners: (await getScoringConfig("style_sentence_openers") ?? "").split(", ").filter(Boolean),
    powerWords: (await getScoringConfig("style_power_words") ?? "").split(", ").filter(Boolean),
    avoidWords: (await getScoringConfig("style_avoid_words") ?? "").split(", ").filter(Boolean),
    avgSentenceLength: parseInt(await getScoringConfig("style_avg_sentence_length") ?? "0", 10),
    topPhrases: (await getScoringConfig("style_top_phrases") ?? "").split(", ").filter(Boolean),
    structuralPatterns: (await getScoringConfig("style_structural_patterns") ?? "").split(" | ").filter(Boolean),
    totalArticles: parseInt(await getScoringConfig("style_articles_count") ?? "0", 10),
    analysedAt,
  };
}

/**
 * Scores a post by engagement quality.
 * Weighted: likes (3×) + shares (5×) + comments (2×) + views (1×) + netFollows (4×)
 */
/**
 * Calculates a 0-100 true performance score based on Instagram stats.
 * Uses a weighted combination of reach, engagement, and follower gain.
 * 
 * Baselines (what equals a score of ~75):
 * - Views: 100k
 * - Likes: 5k
 * - Comments: 100
 * - Shares: 500
 * - Follows: 100
 */
export function calculatePerformanceScore(post: {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  netFollows?: number | null;
  followersGained?: number | null;
  saves?: number | null;
}): number {
  // Extract values
  const views = post.views ?? 0;
  const likes = post.likes ?? 0;
  const comments = post.comments ?? 0;
  const shares = post.shares ?? 0;
  const saves = post.saves ?? 0;
  const follows = (post.followersGained ?? post.netFollows) ?? 0;
  
  if (views === 0 && likes === 0 && shares === 0) return 0;

  // Calculate component scores (each capped at 100)
  // Reach: 100k views = 75, 200k = 100
  const reachScore = Math.min(100, (views / 200000) * 100);
  
  // Engagement volume: 5k likes + 500 shares + 100 comments = 75
  const engVolume = likes + (comments * 5) + (shares * 10) + (saves * 2);
  const engScore = Math.min(100, (engVolume / 15000) * 100);
  
  // Follower conversion: 100 follows = 75
  const followScore = Math.min(100, (follows / 150) * 100);
  
  // Engagement rate (quality): 5% ER = 75
  const er = views > 0 ? (likes + comments + shares + saves) / views : 0;
  const erScore = Math.min(100, (er / 0.08) * 100);

  // Blended true performance score
  const finalScore = (
    (reachScore * 0.35) + 
    (engScore * 0.35) + 
    (erScore * 0.20) + 
    (followScore * 0.10)
  );
  
  return Math.round(finalScore);
}

// Keep the old engagementScore for backwards compatibility with the rest of the file
function engagementScore(post: {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  netFollows?: number | null;
}): number {
  return (
    (post.views ?? 0) * 1 +
    (post.likes ?? 0) * 3 +
    (post.comments ?? 0) * 2 +
    (post.shares ?? 0) * 5 +
    (post.netFollows ?? 0) * 4
  );
}

/**
 * Runs the full performance analysis pipeline:
 * 1. Loads all historical posts with engagement data
 * 2. Ranks them by engagement score
 * 3. Sends top posts to LLM for pattern analysis
 * 4. Stores insights in scoring_config for Soyunci injection
 */
export async function analysePerformance(force = false): Promise<PerformanceInsights | null> {
  // Debounce guard
  if (!force) {
    const lastAnalysedAt = await getScoringConfig("perf_analysed_at");
    if (lastAnalysedAt) {
      const elapsed = Date.now() - new Date(lastAnalysedAt).getTime();
      if (elapsed < ANALYSIS_DEBOUNCE_MS) {
        console.log(`[Performance] Skipping analysis — last ran ${Math.round(elapsed / 60000)}m ago`);
        return null;
      }
    }
  }

  const allPosts = await getHistoricalPosts(500);
  const postsWithMetrics = allPosts.filter(
    (p) => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0 || (p.shares ?? 0) > 0
  );

  if (postsWithMetrics.length < MIN_POSTS_FOR_ANALYSIS) {
    console.log(`[Performance] Not enough data (${postsWithMetrics.length} posts with metrics, need ${MIN_POSTS_FOR_ANALYSIS})`);
    return null;
  }

  // Sort by engagement score descending, take top 30
  const ranked = postsWithMetrics
    .map((p) => ({ ...p, _score: engagementScore(p) }))
    .sort((a, b) => b._score - a._score);

  const top = ranked.slice(0, 30);
  const bottom = ranked.slice(-10); // worst performers for contrast

  const topFormatted = top.map((p, i) =>
    `#${i + 1} [score:${p._score}] Angle: "${p.viralAngle ?? "unknown"}" | Headline: "${p.headline}" | Category: ${p.category ?? "?"} | Views: ${p.views ?? 0} | Likes: ${p.likes ?? 0} | Shares: ${p.shares ?? 0} | Comments: ${p.comments ?? 0} | Net Follows: ${p.netFollows ?? 0}`
  ).join("\n");

  const bottomFormatted = bottom.map((p) =>
    `[score:${p._score}] Angle: "${p.viralAngle ?? "unknown"}" | Headline: "${p.headline}" | Category: ${p.category ?? "?"}`
  ).join("\n");

  const prompt = `You are analysing performance data for FlightDrama, an aviation social media publisher.

TOP PERFORMING POSTS (by engagement):
${topFormatted}

WORST PERFORMING POSTS (for contrast):
${bottomFormatted}

Analyse these results and identify:
1. Which viral angles consistently drive the most engagement (e.g. "Safety Crisis", "Accountability", "Historic First")
2. What headline patterns work best (e.g. sentence structure, use of numbers, urgency words, airline/aircraft names)
3. Which categories perform best (e.g. Boeing, Crash, Passenger Rights)
4. Specific writing tips for the Soyunci AI writer to improve future articles based on what performed well

Be specific and actionable. Base everything on the actual data above.`;

  let response;
  try {
    response = await invokeLLM({
      model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
      messages: [{ role: "user" as const, content: prompt }],
      response_format: { type: "json_object" }
    });
  } catch (err) {
    console.error("[Performance] LLM call failed:", err);
    return null;
  }

  let parsed: Omit<PerformanceInsights, "analysedAt" | "postsAnalysed">;
  try {
    const rawContent = response?.choices?.[0]?.message?.content ?? "";
    const raw = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
    const jsonStr = raw.includes("{") ? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) : raw;
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    console.error("[Performance] Failed to parse LLM response:", err);
    return null;
  }

  const insights: PerformanceInsights = {
    ...parsed,
    analysedAt: new Date().toISOString(),
    postsAnalysed: postsWithMetrics.length,
  };

  // Persist to scoring_config for Soyunci injection
  await setScoringConfig("perf_top_angles", JSON.stringify(insights.topAngles));
  await setScoringConfig("perf_headline_patterns", JSON.stringify(insights.headlinePatterns));
  await setScoringConfig("perf_top_categories", JSON.stringify(insights.topCategories));
  await setScoringConfig("perf_writing_tips", JSON.stringify(insights.writingTips));
  await setScoringConfig("perf_summary", insights.summary);
  await setScoringConfig("perf_analysed_at", insights.analysedAt);
  await setScoringConfig("perf_posts_analysed", String(insights.postsAnalysed));

  // Also regenerate the headline_style_guide from live data so future Soyunci runs
  // benefit from newly uploaded headlines automatically.
  try {
    await regenerateHeadlineStyleGuide(ranked, postsWithMetrics.length);
  } catch (err) {
    console.error("[Performance] Failed to regenerate headline_style_guide:", err);
  }

  console.log(`[Performance] Analysis complete — ${postsWithMetrics.length} posts analysed`);
  return insights;
}

/**
 * Regenerates the headline_style_guide in scoring_config from live ranked post data.
 * Called automatically after every analysePerformance run.
 */
async function regenerateHeadlineStyleGuide(
  ranked: Array<{ headline: string; views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; viralAngle?: string | null; category?: string | null; _score: number }>,
  totalPosts: number
): Promise<void> {
  const top = ranked.slice(0, 40);
  const bottom = ranked.slice(-10);

  const topBlock = top.map((p, i) =>
    `#${i + 1} [score:${p._score}] "${p.headline}" | Views: ${p.views ?? 0} | Likes: ${p.likes ?? 0} | Shares: ${p.shares ?? 0}`
  ).join("\n");

  const bottomBlock = bottom.map(p =>
    `[score:${p._score}] "${p.headline}"`
  ).join("\n");

  const response = await invokeLLM({
    model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
    messages: [{
      role: "user" as const,
      content: `You are analysing ${totalPosts} real FlightDrama headlines to build a headline writing guide.

TOP PERFORMERS:
${topBlock}

WORST PERFORMERS (avoid these patterns):
${bottomBlock}

Extract concrete, specific headline writing rules. Focus on:
- Structural patterns that appear repeatedly in top performers (e.g. "X - Then Y", "Built in [year]...", "After N years...")
- Word count patterns (count the words in the top headlines)
- What kills performance (patterns from the worst performers)
- Specific formatting rules (numbers, case, dashes)

Return JSON only.`
    }],
    response_format: { type: "json_object" },
  });

  const rawContent = response?.choices?.[0]?.message?.content ?? "";
  const raw = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
  const jsonStr = raw.includes("{") ? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) : raw;
  const update = JSON.parse(jsonStr);

  // Merge with the existing static guide (preserve examples, update rules)
  const existingRaw = await getScoringConfig("headline_style_guide");
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const updated = {
    ...existing,
    version: (existing.version ?? 1) + 1,
    source: `${totalPosts} real FlightDrama headlines analysed`,
    last_updated: new Date().toISOString().split("T")[0],
    rules: {
      ...(existing.rules ?? {}),
      word_count: {
        ...(existing.rules?.word_count ?? {}),
        target: update.word_count_target,
      },
      live_patterns: update.top_patterns,
      live_avoid: update.avoid_patterns,
      live_formatting: update.formatting_rules,
    },
  };

  await setScoringConfig("headline_style_guide", JSON.stringify(updated));
  console.log(`[Performance] headline_style_guide updated (v${updated.version}, ${totalPosts} posts)`);
}

/**
 * Loads the latest performance insights from scoring_config.
 * Returns null if no analysis has been run yet.
 */
export async function getPerformanceInsights(): Promise<PerformanceInsights | null> {
  const analysedAt = await getScoringConfig("perf_analysed_at");
  if (!analysedAt) return null;

  const topAnglesRaw = await getScoringConfig("perf_top_angles");
  const headlinePatternsRaw = await getScoringConfig("perf_headline_patterns");
  const topCategoriesRaw = await getScoringConfig("perf_top_categories");
  const writingTipsRaw = await getScoringConfig("perf_writing_tips");
  const summary = await getScoringConfig("perf_summary");
  const postsAnalysedRaw = await getScoringConfig("perf_posts_analysed");

  const tryParse = (raw: string | null): string[] => {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  };

  return {
    topAngles: tryParse(topAnglesRaw),
    headlinePatterns: tryParse(headlinePatternsRaw),
    topCategories: tryParse(topCategoriesRaw),
    writingTips: tryParse(writingTipsRaw),
    summary: summary ?? "",
    analysedAt,
    postsAnalysed: parseInt(postsAnalysedRaw ?? "0", 10),
  };
}
