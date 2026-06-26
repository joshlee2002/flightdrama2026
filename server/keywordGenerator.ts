/**
 * keywordGenerator.ts
 *
 * Analyses the user's rated story packages AND editor override history to generate
 * targeted Google News RSS search feed URLs. Feeds are organised into three tiers:
 *
 *   Core    — derived from "amazing"-rated articles + high override stories (score threshold: 80)
 *   Explore — derived from "good"-rated articles + medium-high overrides   (score threshold: 70)
 *   Test    — newly generated, unvalidated feeds                           (score threshold: 75, 7-day expiry)
 *
 * Override signals used:
 *   - overrideScore ≥ 70  → editor wants MORE stories like this (treated like "good" rating)
 *   - overrideScore ≥ 88  → editor wants MORE stories like this (treated like "amazing" rating)
 *   - overrideScore ≤ 30  → editor wants FEWER stories like this (avoid these topics/patterns)
 *
 * Generated feeds are upserted into rss_sources with sourceType = 'ai_keyword'.
 * Feeds that haven't produced a rated story in 30 days are automatically disabled.
 */

import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { rssSources, stories, storyPackages } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";

export interface GeneratedKeywordFeed {
  name: string;
  url: string;
  tier: "core" | "explore" | "test";
  scoreThreshold: number;
  expiresAt: Date | null;
}

/**
 * Build a Google News RSS search URL for a given query string.
 */
function buildGoogleNewsRssUrl(query: string): string {
  const encoded = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Fetch rated story packages from the DB, grouped by rating tier.
 */
async function fetchRatedPackages() {
  const db = await getDb();
  if (!db) return { amazing: [], good: [] };

  const rows = await db
    .select({
      title: storyPackages.selectedHeadline,
      article: storyPackages.soyunciArticle,
      viralAngle: storyPackages.viralAngle,
      userRating: storyPackages.soyunciRating,
    })
    .from(storyPackages)
    .where(
      and(
        isNotNull(storyPackages.soyunciRating),
        sql`${storyPackages.soyunciRating} IN ('amazing', 'good')`,
      ),
    )
    .limit(50);

  const amazing = rows.filter((r) => r.userRating === "amazing");
  const good = rows.filter((r) => r.userRating === "good");

  return { amazing, good };
}

/**
 * Fetch editor override examples from the stories table, split into:
 *   - wantMore: overrideScore ≥ 70 (editor boosted the story significantly)
 *   - wantLess: overrideScore ≤ 30 (editor knocked the story down significantly)
 *
 * Only includes overrides where the editor moved the score by ≥ 10 points
 * from the AI's original score, so we only learn from deliberate signals.
 */
async function fetchOverrideSignals(): Promise<{
  wantMore: Array<{ title: string; category: string | null; viralReason: string | null; overrideScore: number }>;
  wantLess: Array<{ title: string; category: string | null; viralReason: string | null; overrideScore: number }>;
}> {
  const db = await getDb();
  if (!db) return { wantMore: [], wantLess: [] };

  const rows = await db
    .select({
      title: stories.title,
      category: stories.category,
      viralReason: stories.viralReason,
      overrideScore: stories.overrideScore,
      viralScore: stories.viralScore,
    })
    .from(stories)
    .where(
      and(
        isNotNull(stories.overrideScore),
        isNotNull(stories.overrideLabel),
      ),
    )
    .orderBy(desc(stories.updatedAt))
    .limit(100);

  // Only learn from overrides where the editor moved the score by ≥ 10 pts
  const wantMore = rows
    .filter(
      (r) =>
        r.overrideScore !== null &&
        r.viralScore !== null &&
        r.overrideScore >= 70 &&
        r.overrideScore - r.viralScore >= 20,
    )
    .map((r) => ({
      title: r.title,
      category: r.category,
      viralReason: r.viralReason,
      overrideScore: r.overrideScore as number,
    }));

  const wantLess = rows
    .filter(
      (r) =>
        r.overrideScore !== null &&
        r.viralScore !== null &&
        r.overrideScore <= 30 &&
        r.viralScore - r.overrideScore >= 20,
    )
    .map((r) => ({
      title: r.title,
      category: r.category,
      viralReason: r.viralReason,
      overrideScore: r.overrideScore as number,
    }));

  return { wantMore, wantLess };
}

/**
 * Use the LLM to analyse rated articles AND override signals to generate targeted
 * Google News search queries.
 */
async function generateKeywordQueries(
  amazingArticles: Array<{ title: string | null; article: string | null; viralAngle: string | null }>,
  goodArticles: Array<{ title: string | null; article: string | null; viralAngle: string | null }>,
  wantMoreOverrides: Array<{ title: string; category: string | null; viralReason: string | null; overrideScore: number }>,
  wantLessOverrides: Array<{ title: string; category: string | null; viralReason: string | null; overrideScore: number }>,
): Promise<{ core: string[]; explore: string[]; test: string[] }> {
  const amazingSummary = amazingArticles
    .slice(0, 15)
    .map((a, i) => `${i + 1}. [AMAZING] Headline: "${a.title}" | Angle: ${a.viralAngle ?? "unknown"}`)
    .join("\n");

  const goodSummary = goodArticles
    .slice(0, 15)
    .map((a, i) => `${i + 1}. [GOOD] Headline: "${a.title}" | Angle: ${a.viralAngle ?? "unknown"}`)
    .join("\n");

  const wantMoreSummary = wantMoreOverrides
    .slice(0, 20)
    .map(
      (o, i) =>
        `${i + 1}. [EDITOR BOOSTED to ${o.overrideScore}] "${o.title}" | Category: ${o.category ?? "unknown"}`,
    )
    .join("\n");

  const wantLessSummary = wantLessOverrides
    .slice(0, 20)
    .map(
      (o, i) =>
        `${i + 1}. [EDITOR REJECTED/DOWNGRADED to ${o.overrideScore}] "${o.title}" | Category: ${o.category ?? "unknown"}`,
    )
    .join("\n");

  const hasRatings =
    amazingArticles.length > 0 ||
    goodArticles.length > 0 ||
    wantMoreOverrides.length > 0;

  const prompt = hasRatings
    ? `You are an aviation news editor for FlightDrama, an Instagram page covering viral aviation stories.

Below are two types of editorial signals. Use BOTH to understand what the editor wants more and less of.

## SIGNAL 1 — Explicitly rated articles (highest confidence)
${amazingSummary || "(none yet)"}
${goodSummary || "(none yet)"}

## SIGNAL 2 — Editor score overrides (strong signal)
These are stories where the editor manually changed the AI's score by 10+ points.
Stories the editor BOOSTED (wants more like these):
${wantMoreSummary || "(none yet)"}

Stories the editor REJECTED or DOWNGRADED (wants fewer like these):
${wantLessSummary || "(none yet)"}

## YOUR TASK
Analyse ALL the signals above — what types of incidents, aircraft, airlines, angles, and story structures does the editor consistently boost? What do they consistently reject?

Generate targeted Google News search query strings that will find MORE stories like the ones the editor boosts, and AVOID the patterns they reject.

Focus on:
- Specific incident types (emergency landings, diversions, near-misses, passenger incidents, crew drama)
- Aircraft types and airlines that appear in boosted/amazing stories
- Viral angles (shocking, record-breaking, human drama, safety controversy)
- Avoid query patterns that match the rejected/downgraded stories
- Avoid generic queries like "aviation news" — be specific and targeted

Return a JSON object with exactly this structure:
{
  "core": ["query1", "query2", "query3", "query4", "query5"],
  "explore": ["query6", "query7", "query8", "query9", "query10"],
  "test": ["query11", "query12", "query13", "query14", "query15"]
}

Rules:
- "core": 5 queries directly derived from AMAZING-rated or highest-boosted story patterns (most targeted)
- "explore": 5 queries derived from GOOD-rated or moderately-boosted story patterns (broader)
- "test": 5 experimental queries for story types not yet rated but likely viral based on the patterns (speculative)
- Each query should be 3-6 words, specific enough to return relevant aviation stories
- Use aviation terminology, airline names, aircraft types where appropriate
- Do NOT use quotes or boolean operators in queries`
    : `You are an aviation news editor for FlightDrama, an Instagram page covering viral aviation stories.

No articles have been rated yet. Generate a strong starting set of Google News search queries that will find viral aviation stories covering:
- Emergency landings and diversions
- Passenger and crew incidents  
- Near-misses and safety incidents
- Record-breaking flights
- Airline controversies and drama
- Aircraft accidents and investigations

Return a JSON object with exactly this structure:
{
  "core": ["query1", "query2", "query3", "query4", "query5"],
  "explore": ["query6", "query7", "query8", "query9", "query10"],
  "test": ["query11", "query12", "query13", "query14", "query15"]
}

Rules:
- Each query should be 3-6 words, specific and targeted
- Use aviation terminology where appropriate
- Do NOT use quotes or boolean operators`;

  const response = await invokeLLM({
    model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty response for keyword generation");

  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  return {
    core: (parsed.core ?? []).slice(0, 5),
    explore: (parsed.explore ?? []).slice(0, 5),
    test: (parsed.test ?? []).slice(0, 5),
  };
}

/**
 * Main export: generate keyword feeds and upsert them into rss_sources.
 * Returns the count of feeds created/updated.
 */
export async function regenerateKeywordFeeds(): Promise<{
  created: number;
  updated: number;
  expired: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log("[KeywordGen] Starting keyword feed regeneration...");

  // 1. Fetch rated packages
  const { amazing, good } = await fetchRatedPackages();
  console.log(`[KeywordGen] Found ${amazing.length} amazing, ${good.length} good rated articles`);

  // 2. Fetch override signals
  const { wantMore, wantLess } = await fetchOverrideSignals();
  console.log(`[KeywordGen] Found ${wantMore.length} boosted overrides, ${wantLess.length} downgraded overrides`);

  // 2. Generate keyword queries via LLM (now includes override signals)
  const queries = await generateKeywordQueries(amazing, good, wantMore, wantLess);
  console.log(`[KeywordGen] Generated ${queries.core.length + queries.explore.length + queries.test.length} keyword queries`);

  // 3. Build feed objects
  const now = new Date();
  const testExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const feeds: GeneratedKeywordFeed[] = [
    ...queries.core.map((q) => ({
      name: `[AI Core] ${q}`,
      url: buildGoogleNewsRssUrl(q),
      tier: "core" as const,
      scoreThreshold: 80,
      expiresAt: null, // Core feeds don't expire
    })),
    ...queries.explore.map((q) => ({
      name: `[AI Explore] ${q}`,
      url: buildGoogleNewsRssUrl(q),
      tier: "explore" as const,
      scoreThreshold: 70,
      expiresAt: null,
    })),
    ...queries.test.map((q) => ({
      name: `[AI Test] ${q}`,
      url: buildGoogleNewsRssUrl(q),
      tier: "test" as const,
      scoreThreshold: 75,
      expiresAt: testExpiry,
    })),
  ];

  // 4. Disable all existing AI keyword feeds first (we'll re-enable the ones we keep)
  await db
    .update(rssSources)
    .set({ isActive: false })
    .where(eq(rssSources.sourceType, "ai_keyword"));

  // 5. Upsert new feeds
  let created = 0;
  let updated = 0;

  for (const feed of feeds) {
    // Check if a feed with this URL already exists
    const existing = await db
      .select({ id: rssSources.id })
      .from(rssSources)
      .where(eq(rssSources.url, feed.url))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(rssSources)
        .set({
          name: feed.name,
          isActive: true,
          sourceType: "ai_keyword",
          tier: feed.tier,
          scoreThreshold: feed.scoreThreshold,
          expiresAt: feed.expiresAt,
        })
        .where(eq(rssSources.url, feed.url));
      updated++;
    } else {
      await db.insert(rssSources).values({
        name: feed.name,
        url: feed.url,
        category: "aviation",
        isActive: true,
        sourceType: "ai_keyword",
        tier: feed.tier,
        scoreThreshold: feed.scoreThreshold,
        ratedStoryCount: 0,
        expiresAt: feed.expiresAt,
      });
      created++;
    }
  }

  // 6. Auto-expire: disable AI feeds where no rated story in 30 days
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const expireResult = await db
    .update(rssSources)
    .set({ isActive: false })
    .where(
      and(
        eq(rssSources.sourceType, "ai_keyword"),
        isNotNull(rssSources.lastRatedAt),
        lt(rssSources.lastRatedAt, thirtyDaysAgo),
      ),
    );

  // Also expire test feeds past their expiry date
  await db
    .update(rssSources)
    .set({ isActive: false })
    .where(
      and(
        eq(rssSources.sourceType, "ai_keyword"),
        eq(rssSources.tier, "test"),
        isNotNull(rssSources.expiresAt),
        lt(rssSources.expiresAt, now),
      ),
    );

  const expired = (expireResult as any)?.rowsAffected ?? 0;

  console.log(`[KeywordGen] Done: ${created} created, ${updated} updated, ${expired} expired`);
  return { created, updated, expired };
}

/**
 * Called when a story package is rated — updates the ratedStoryCount and lastRatedAt
 * on any AI keyword feed that was the source of the story.
 */
export async function recordRatingForFeed(storySourceName: string | null): Promise<void> {
  if (!storySourceName) return;
  const db = await getDb();
  if (!db) return;

  // Find AI keyword feeds whose name contains the source name
  // (AI feeds are named "[AI Core] query" etc — match by source name substring)
  await db
    .update(rssSources)
    .set({
      ratedStoryCount: sql`${rssSources.ratedStoryCount} + 1`,
      lastRatedAt: new Date(),
    })
    .where(
      and(
        eq(rssSources.sourceType, "ai_keyword"),
        sql`${rssSources.name} LIKE CONCAT('%', ${storySourceName}, '%')`,
      ),
    );
}
