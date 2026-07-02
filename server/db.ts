import { and, desc, eq, gte, inArray, isNull, lte, ne, not, or, sql } from "drizzle-orm";
import { DEFAULT_RSS_SOURCES } from "./ingestion";
import { drizzle } from "drizzle-orm/mysql2";
import {
  duplicateLearning,
  exampleArticles,
  historicalPosts,
  ingestLog,
  InsertHistoricalPost,
  InsertIngestLogEntry,
  InsertRssSource,
  InsertStory,
  InsertStoryPackage,
  InsertUser,
  rssSources,
  scoringConfig,
  seenUrls,
  stories,
  storyPackages,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ── Users ──────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};

  const textFields = ["name", "email", "loginMethod"] as const;
  for (const field of textFields) {
    const value = user[field];
    if (value !== undefined) {
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    }
  }

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }

  if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

// ── In-memory fallback RSS sources (used when no DATABASE_URL is set) ────────
function getInMemoryRssSources() {
  return DEFAULT_RSS_SOURCES.map((s, i) => ({
    id: i + 1,
    name: s.name,
    url: s.url,
    category: s.category,
    isActive: true as boolean,
    lastFetchedAt: null as Date | null,
    createdAt: new Date(),
    sourceType: "manual" as "manual" | "ai_keyword",
    tier: null as "core" | "explore" | "test" | null,
    scoreThreshold: 0,
    ratedStoryCount: 0,
    lastRatedAt: null as Date | null,
    expiresAt: null as Date | null,
  }));
}

// ── RSS Sources ────────────────────────────────────────────────────────────

export async function getRssSources() {
  const db = await getDb();
  if (!db) return getInMemoryRssSources();
  return db.select().from(rssSources).orderBy(rssSources.category, rssSources.name);
}

export async function getActiveRssSources() {
  const db = await getDb();
  if (!db) return getInMemoryRssSources().filter(s => s.isActive);
  return db.select().from(rssSources).where(eq(rssSources.isActive, true));
}

export async function upsertRssSource(source: InsertRssSource) {
  const db = await getDb();
  if (!db) return;
  // Update name, url, AND category on conflict so that category changes in
  // DEFAULT_RSS_SOURCES (e.g. moving lifestyle feeds from 'aviation' to 'viral')
  // are applied to existing DB rows when reseed is triggered.
  await db
    .insert(rssSources)
    .values(source)
    .onDuplicateKeyUpdate({ set: { name: source.name, url: source.url, category: source.category } });
}

export async function toggleRssSource(id: number, isActive: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(rssSources).set({ isActive }).where(eq(rssSources.id, id));
}

export async function updateRssSourceLastFetched(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(rssSources).set({ lastFetchedAt: new Date() }).where(eq(rssSources.id, id));
}

export async function countRssSources(): Promise<number> {
  const db = await getDb();
  if (!db) return DEFAULT_RSS_SOURCES.length;
  const result = await db.select({ count: sql<number>`count(*)` }).from(rssSources);
  return result[0]?.count || 0;
}

// ── Stories ────────────────────────────────────────────────────────────────

export async function createStory(story: InsertStory): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(stories).values(story);
  // MySQL2 returns ResultSetHeader as result[0] with insertId
  const header = result[0] as any;
  return header.insertId as number;
}

export async function getStories(filters?: {
  statusLabel?: string;
  approvalStatus?: string;
  minScore?: number;
  maxScore?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [];
  if (filters?.statusLabel) {
    conditions.push(eq(stories.statusLabel, filters.statusLabel as any));
  }
  if (filters?.approvalStatus) {
    conditions.push(eq(stories.approvalStatus, filters.approvalStatus as any));
  }
  if (filters?.minScore !== undefined) {
    conditions.push(gte(stories.viralScore, filters.minScore));
  }
  if (filters?.maxScore !== undefined) {
    conditions.push(lte(stories.viralScore, filters.maxScore));
  }

  const query = db
    .select()
    .from(stories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(stories.viralScore), desc(stories.createdAt))
    .limit(filters?.limit || 50)
    .offset(filters?.offset || 0);

  return query;
}

export async function getStoriesWithPackages(filters?: {
  statusLabel?: string;
  approvalStatus?: string;
  minScore?: number;
  limit?: number;
  completedOnly?: boolean;
  sortBy?: "newest" | "top_scored";
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [];
  if (filters?.statusLabel) {
    conditions.push(eq(stories.statusLabel, filters.statusLabel as any));
  }
  if (filters?.approvalStatus) {
    conditions.push(eq(stories.approvalStatus, filters.approvalStatus as any));
  } else {
    // Default: exclude rejected, dismissed, duplicate, and completed stories from the dashboard
    conditions.push(ne(stories.approvalStatus, "rejected" as any));
    conditions.push(ne(stories.approvalStatus, "dismissed" as any));
    conditions.push(ne(stories.approvalStatus, "duplicate" as any));
    conditions.push(ne(stories.approvalStatus, "completed" as any));
  }
  if (filters?.minScore !== undefined) {
    conditions.push(gte(stories.viralScore, filters.minScore));
  }

  // Sort order: newest = publishedAt desc (fallback to createdAt), top_scored = score desc then date
  const sortBy = filters?.sortBy ?? "top_scored";
  const orderClauses =
    sortBy === "newest"
      ? [
          desc(sql`COALESCE(${stories.publishedAt}, ${stories.createdAt})`),
          desc(sql`COALESCE(${stories.overrideScore}, ${stories.viralScore})`),
        ]
      : [
          desc(sql`COALESCE(${stories.overrideScore}, ${stories.viralScore})`),
          desc(sql`COALESCE(${stories.publishedAt}, ${stories.createdAt})`),
        ];

  const storyRows = await db
    .select()
    .from(stories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderClauses)
    .limit(filters?.limit || 1000);

  if (storyRows.length === 0) return [];

  const storyIds = storyRows.map((s) => s.id);
  const packages = await db
    .select()
    .from(storyPackages)
    .where(
      storyIds.length === 1
        ? eq(storyPackages.storyId, storyIds[0])
        : sql`${storyPackages.storyId} IN (${sql.join(storyIds.map((id) => sql`${id}`), sql`, `)})`
    );

  const packageMap = new Map(packages.map((p) => [p.storyId, p]));

  const results = storyRows.map((story) => ({
    story,
    package: packageMap.get(story.id) || null,
  }));

  // If completedOnly, only return stories whose package is complete
  if (filters?.completedOnly) {
    return results.filter((r) => r.package?.processingStatus === "complete");
  }

  return results;
}

export async function getStoryById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(stories).where(eq(stories.id, id)).limit(1);
  return result[0];
}

export async function updateStoryApproval(
  id: number,
  status: "approved" | "rejected" | "edited" | "pending" | "dismissed" | "duplicate" | "completed"
) {
  const db = await getDb();
  if (!db) return;
  await db.update(stories).set({ approvalStatus: status, updatedAt: new Date() }).where(eq(stories.id, id));
}

export async function updateStoryScores(
  id: number,
  viralScore: number,
  statusLabel: string,
  viralReason: string,
  category: string,
  scoringMethod: "rule_based" | "llm_assisted" | "stat_adjusted" = "rule_based",
  extras?: {
    ruleScore?: number;
    apprenticeConfidence?: string;
    apprenticeReasoning?: string;
    similarExamplesUsed?: string[];
  }
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(stories)
    .set({
      viralScore,
      statusLabel: statusLabel as any,
      viralReason,
      category,
      scoringMethod,
      ...(extras?.ruleScore !== undefined ? { ruleScore: extras.ruleScore } : {}),
      ...(extras?.apprenticeConfidence !== undefined ? { apprenticeConfidence: extras.apprenticeConfidence } : {}),
      ...(extras?.apprenticeReasoning !== undefined ? { apprenticeReasoning: extras.apprenticeReasoning } : {}),
      ...(extras?.similarExamplesUsed !== undefined ? { similarExamplesUsed: extras.similarExamplesUsed } : {}),
      updatedAt: new Date(),
    })
    .where(eq(stories.id, id));
}

export async function updateStoryOverride(
  id: number,
  overrideScore: number | null,
  overrideLabel: string | null
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(stories)
    .set({
      overrideScore: overrideScore ?? null,
      overrideLabel: overrideLabel as any ?? null,
      updatedAt: new Date(),
    })
    .where(eq(stories.id, id));
}

export async function updateStoryTriggers(id: number, triggers: string[]) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(stories)
    .set({ viralTriggers: triggers, updatedAt: new Date() })
    .where(eq(stories.id, id));
}

export async function getRecentStoryTitles(limit = 5000): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  // Pull all-time titles (up to 5000) so similarity dedup covers the full history,
  // not just recent stories. This ensures a story never resurfaces after being seen.
  const result = await db
    .select({ title: stories.title })
    .from(stories)
    .orderBy(desc(stories.createdAt))
    .limit(limit);
  return result.map((r) => r.title);
}

export async function storyUrlExists(url: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db
    .select({ id: stories.id })
    .from(stories)
    .where(eq(stories.sourceUrl, url))
    .limit(1);
  return result.length > 0;
}

// ── Story Packages ─────────────────────────────────────────────────────────

export async function createStoryPackage(pkg: InsertStoryPackage) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(storyPackages).values(pkg).onDuplicateKeyUpdate({
    set: {
      processingStatus: pkg.processingStatus,
      processingError: pkg.processingError,
      updatedAt: new Date(),
    },
  });
}

export async function updateStoryPackage(
  storyId: number,
  data: Partial<InsertStoryPackage>
) {
  const db = await getDb();
  if (!db) return;
  // Step 1: ensure the row exists (minimal insert, safe for any schema)
  await db
    .insert(storyPackages)
    .values({ storyId, processingStatus: "queued" })
    .onDuplicateKeyUpdate({ set: { storyId } }) // no-op on conflict, just ensures row exists
    .catch(() => {}); // ignore if row already exists with different constraint
  // Step 2: update the row with the actual data using raw SQL to avoid Drizzle
  // JSON serialization issues with json-typed columns (quotes, sources, etc.)
  const { id: _id, storyId: _sid, createdAt: _ca, ...safeData } = data as any;
  // JSON-typed fields that need explicit serialization
  const JSON_FIELDS = new Set([
    "researchExtracted", "researchQuotes", "researchSources",
    "researchEditorialHooks", "researchStoryQuality",
    "imageRecommendations", "imageCandidates", "hashtags",
    "allHeadlines", "topThreeHeadlines", "headlineObjects", "editorReview",
  ]);
  const setClauses: string[] = ["updatedAt = NOW()"];
  const params: any[] = [];
  for (const [key, value] of Object.entries(safeData)) {
    if (value === undefined) continue;
    setClauses.push(`\`${key}\` = ?`);
    if (JSON_FIELDS.has(key) && value !== null && typeof value !== "string") {
      params.push(JSON.stringify(value));
    } else {
      params.push(value);
    }
  }
  if (setClauses.length <= 1) return; // nothing to update
  params.push(storyId);
  // Use the underlying mysql2 client for raw parameterized SQL to avoid
  // Drizzle ORM JSON serialization issues with json-typed columns
  const rawClient = (db as any).$client;
  const rawQuery = `UPDATE \`story_packages\` SET ${setClauses.join(", ")} WHERE \`storyId\` = ?`;
  // mysql2 $client may be promise-based or callback-based
  if (typeof rawClient.execute === "function") {
    await rawClient.execute(rawQuery, params);
  } else if (typeof rawClient.query === "function") {
    await rawClient.query(rawQuery, params);
  } else {
    // Fallback: use Drizzle's sql template with explicit JSON stringification
    await db.execute(sql`${sql.raw(rawQuery)}`);
  }
}

export async function getPackageByStoryId(storyId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(storyPackages)
    .where(eq(storyPackages.storyId, storyId))
    .limit(1);
  return result[0];
}

export async function updatePackageArticle(storyId: number, article: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(storyPackages)
    .set({ soyunciArticle: article, updatedAt: new Date() })
    .where(eq(storyPackages.storyId, storyId));
}

// ── Historical Posts ───────────────────────────────────────────────────────

export async function createHistoricalPost(post: InsertHistoricalPost) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(historicalPosts).values(post);
}

export async function getHistoricalPosts(limit = 100, excludeSourceTypes?: string[]) {
  const db = await getDb();
  if (!db) return [];
  if (excludeSourceTypes && excludeSourceTypes.length > 0) {
    return db
      .select()
      .from(historicalPosts)
      .where(
        or(
          isNull(historicalPosts.sourceType),
          not(inArray(historicalPosts.sourceType, excludeSourceTypes))
        )
      )
      .orderBy(desc(historicalPosts.createdAt))
      .limit(limit);
  }
  return db
    .select()
    .from(historicalPosts)
    .orderBy(desc(historicalPosts.createdAt))
    .limit(limit);
}

// ── Seen URLs ──────────────────────────────────────────────────────────────
// Every URL encountered during ingestion is recorded here BEFORE the score gate.
// This ensures low-scoring or non-aviation stories are never re-evaluated on
// subsequent fetches, even though they are not stored in the stories table.

export async function markUrlAsSeen(url: string, rejectedReason?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(seenUrls).values({ url, rejectedReason: rejectedReason ?? null }).onDuplicateKeyUpdate({ set: { seenAt: new Date() } });
  } catch {
    // Silently ignore duplicate key errors — URL already seen
  }
}

/**
 * Bulk check: returns a Set of URLs that have already been seen.
 * Replaces N individual hasSeenUrl() calls with 2 DB queries total.
 * Chunks into groups of 500 to stay within MySQL IN() limits.
 */
export async function getSeenUrlSet(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const db = await getDb();
  if (!db) return new Set();
  const CHUNK = 500;
  const seen = new Set<string>();
  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK);
    const [seenRows, storyRows] = await Promise.all([
      db.select({ url: seenUrls.url }).from(seenUrls).where(inArray(seenUrls.url, chunk)),
      db.select({ url: stories.sourceUrl }).from(stories).where(inArray(stories.sourceUrl, chunk)),
    ]);
    seenRows.forEach(r => seen.add(r.url));
    storyRows.forEach(r => { if (r.url) seen.add(r.url); });
  }
  return seen;
}

export async function hasSeenUrl(url: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  // Check both seen_urls (fast path) and stories (legacy dedup)
  const [seenRow, storyRow] = await Promise.all([
    db.select({ id: seenUrls.id }).from(seenUrls).where(eq(seenUrls.url, url)).limit(1),
    db.select({ id: stories.id }).from(stories).where(eq(stories.sourceUrl, url)).limit(1),
  ]);
  return seenRow.length > 0 || storyRow.length > 0;
}

// ── Scoring Config ─────────────────────────────────────────────────────────
// Key/value store for LLM-generated scoring rules. The self-improving scorer
// reads these as additional context and rewrites them after analysing overrides.

export async function getScoringConfig(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(scoringConfig).where(eq(scoringConfig.configKey, key)).limit(1);
  return result.length > 0 ? result[0].configValue : null;
}

export async function setScoringConfig(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // Sanitise: collapse newlines/tabs to spaces so the value is always a single
  // line. This prevents Drizzle from misinterpreting multi-line LLM output as
  // multiple SQL parameters in the ON DUPLICATE KEY UPDATE clause.
  // Coerce to string in case the LLM returns a number/object for a field
  const safeValue = String(value ?? '')
    .replace(/\r?\n/g, ' | ')
    .replace(/\t/g, ' ')
    .replace(/  +/g, ' ')
    .trim();
  await db.execute(
    sql`INSERT INTO scoring_config (configKey, configValue)
        VALUES (${key}, ${safeValue})
        ON DUPLICATE KEY UPDATE configValue = ${safeValue}`
  );
}

export async function getAllScoringConfig(): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) return {};
  const rows = await db.select().from(scoringConfig);
  return Object.fromEntries(rows.map(r => [r.configKey, r.configValue]));
}

// Fetch stories where the editor applied a manual override — used as few-shot examples
export async function getOverrideExamplesFromDb(limit?: number, since?: Date) {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [
    sql`${stories.overrideScore} IS NOT NULL`,
    sql`${stories.overrideLabel} IS NOT NULL`,
  ];
  if (since) {
    conditions.push(gte(stories.updatedAt, since));
  }

  let query = db
    .select({
      id: stories.id,
      title: stories.title,
      content: stories.content,
      overrideScore: stories.overrideScore,
      overrideLabel: stories.overrideLabel,
      viralScore: stories.viralScore,
      category: stories.category,
      viralReason: stories.viralReason,
      viralTriggers: stories.viralTriggers,
      updatedAt: stories.updatedAt,
    })
    .from(stories)
    .where(and(...conditions))
    .orderBy(desc(stories.updatedAt));

  if (limit) {
    return query.limit(limit);
  }
  return query;
}

// Returns the most recent lastFetchedAt across all RSS sources — used as the "last ingested" timestamp in the sidebar
export async function getLastIngestTime(): Promise<Date | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select({ latest: sql<string | null>`MAX(${rssSources.lastFetchedAt})` })
    .from(rssSources);
  const raw = result[0]?.latest;
  return raw ? new Date(raw) : null;
}

// Example articles — used as one-shot voice references for the article writing LLM
export async function getExampleArticles() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(exampleArticles).orderBy(exampleArticles.createdAt);
}

export async function addExampleArticle(label: string, articleText: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(exampleArticles).values({ label, articleText });
}

export async function deleteExampleArticle(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(exampleArticles).where(eq(exampleArticles.id, id));
}

// ── Cost Control Config ───────────────────────────────────────────────────────
// Flags stored in scoring_config table. All default to "false" (free/off).
// Keys: llm_scoring_enabled, auto_perf_analysis_enabled,
//       auto_keyword_regen_enabled, auto_deep_learn_enabled

export interface CostControlConfig {
  llmScoringEnabled: boolean;       // Use LLM to score stories on ingest (default: off → rule-based)
  autoPerfAnalysisEnabled: boolean; // Auto-run LLM deep performance analysis on post upload (default: off)
  autoKeywordRegenEnabled: boolean; // Auto-regenerate keyword feeds after 5 ratings (default: off)
  autoDeepLearnEnabled: boolean;    // Auto-run LLM learn-from-overrides in background (default: off)
}

export async function getCostControlConfig(): Promise<CostControlConfig> {
  const db = await getDb();
  if (!db) {
    return { llmScoringEnabled: false, autoPerfAnalysisEnabled: false, autoKeywordRegenEnabled: false, autoDeepLearnEnabled: true };
  }
  const rows = await db.select().from(scoringConfig).where(
    sql`configKey IN ('llm_scoring_enabled','auto_perf_analysis_enabled','auto_keyword_regen_enabled','auto_deep_learn_enabled')`
  );
  const map = Object.fromEntries(rows.map(r => [r.configKey, r.configValue]));
  return {
    llmScoringEnabled: map["llm_scoring_enabled"] === "true",
    autoPerfAnalysisEnabled: map["auto_perf_analysis_enabled"] === "true",
    autoKeywordRegenEnabled: map["auto_keyword_regen_enabled"] === "true",
    // Default TRUE — auto deep learn should be on unless the user explicitly turns it off.
    // The key is absent from the DB on first run, so we must not default to false here.
    autoDeepLearnEnabled: map["auto_deep_learn_enabled"] !== "false",
  };
}

export async function setCostControlConfig(config: Partial<CostControlConfig>): Promise<void> {
  const keyMap: Record<keyof CostControlConfig, string> = {
    llmScoringEnabled: "llm_scoring_enabled",
    autoPerfAnalysisEnabled: "auto_perf_analysis_enabled",
    autoKeywordRegenEnabled: "auto_keyword_regen_enabled",
    autoDeepLearnEnabled: "auto_deep_learn_enabled",
  };
  for (const [field, key] of Object.entries(keyMap) as [keyof CostControlConfig, string][]) {
    if (config[field] !== undefined) {
      await setScoringConfig(key, config[field] ? "true" : "false");
    }
  }
}

// ── Targeted rerank helpers ───────────────────────────────────────────────────

/**
 * Fetch pending stories in a given category (or all pending stories if no
 * category is provided) that have NOT been manually overridden.
 * Used by the targeted rerank trigger to re-score only the stories most likely
 * to benefit from the editor's latest override signal.
 *
 * @param category  - Category string to filter by (e.g. "Boeing Safety"). If null,
 *                    returns all pending non-overridden stories up to the limit.
 * @param limit     - Max stories to return (default 50)
 */
export async function getPendingStoriesByCategory(
  category: string | null,
  limit = 50
): Promise<Array<{ id: number; title: string; content: string | null; viralScore: number; statusLabel: string; category: string | null; viralReason: string | null; overrideScore: number | null }>> {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [
    eq(stories.approvalStatus, "pending" as any),
    sql`${stories.overrideScore} IS NULL`,
  ];

  if (category) {
    // Fuzzy match: same category string (case-insensitive LIKE)
    conditions.push(sql`LOWER(${stories.category}) LIKE LOWER(${`%${category}%`})`);
  }

  return db
    .select({
      id: stories.id,
      title: stories.title,
      content: stories.content,
      viralScore: stories.viralScore,
      statusLabel: stories.statusLabel,
      category: stories.category,
      viralReason: stories.viralReason,
      overrideScore: stories.overrideScore,
    })
    .from(stories)
    .where(and(...conditions))
    .orderBy(desc(stories.createdAt))
    .limit(limit);
}

// ── Duplicate learning helpers ────────────────────────────────────────────────
// Stores editor-confirmed duplicate title pairs in scoring_config.
// The JSON payload is Base64-encoded before storage so that:
//   1. The setScoringConfig sanitiser (which collapses newlines and double spaces)
//      never corrupts the payload — Base64 is pure ASCII with no whitespace.
//   2. Titles with embedded quotes, commas, or special characters are safe.
// Storage key: "duplicate_pairs_b64"
// Format (before encoding): [{ dismissed: "title A", canonical: "title B", at: "ISO" }, ...]

export interface DuplicatePair {
  dismissed: string;
  canonical: string;
  at: string;
}

const DUPLICATE_PAIRS_KEY = "duplicate_pairs_b64";
const MAX_DUPLICATE_PAIRS = 30;

/** Safely read and Base64-decode the stored pairs array. Returns [] on any error. */
async function readStoredDuplicatePairs(): Promise<DuplicatePair[]> {
  try {
    const raw = await getScoringConfig(DUPLICATE_PAIRS_KEY);
    if (!raw) return [];
    const json = Buffer.from(raw.trim(), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Safely Base64-encode and write the pairs array. */
async function writeStoredDuplicatePairs(pairs: DuplicatePair[]): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(pairs), "utf8").toString("base64");
  await setScoringConfig(DUPLICATE_PAIRS_KEY, encoded);
}

/**
 * Record a duplicate pair when the editor clicks "Duplicate" on a story.
 *
 * Deduplication: if a pair with the same dismissed title already exists it is
 * removed first, then the fresh pair is prepended (effectively "refreshed").
 * This prevents the store from filling with near-identical entries when the
 * editor dismisses the same story pattern multiple times.
 *
 * @param dismissedTitle  - Title of the story the editor marked as duplicate
 * @param canonicalTitle  - Title of the existing story it duplicates
 */
export async function recordDuplicatePair(
  dismissedTitle: string,
  canonicalTitle: string | null
): Promise<void> {
  if (!canonicalTitle) return;
  try {
    const pairs = await readStoredDuplicatePairs();
    // Remove any existing entry with the same dismissed title (dedup)
    const filtered = pairs.filter(p => p.dismissed !== dismissedTitle);
    // Prepend the fresh pair and cap at MAX_DUPLICATE_PAIRS
    filtered.unshift({ dismissed: dismissedTitle, canonical: canonicalTitle, at: new Date().toISOString() });
    await writeStoredDuplicatePairs(filtered.slice(0, MAX_DUPLICATE_PAIRS));
  } catch (err) {
    console.warn("[DuplicateLearning] Failed to record pair:", err);
  }
}

/**
 * Retrieve the most recent N duplicate pairs for injection into dedup prompts.
 */
export async function getRecentDuplicatePairs(limit = 10): Promise<DuplicatePair[]> {
  const pairs = await readStoredDuplicatePairs();
  return pairs.slice(0, limit);
}

// ── Atomic counter helper ─────────────────────────────────────────────────────

/**
 * Atomically increment a numeric counter stored in scoring_config.
 * Uses a single SQL statement (INSERT … ON DUPLICATE KEY UPDATE col = col + 1)
 * so concurrent calls never race — the DB serialises the increment itself.
 *
 * Returns the NEW value after the increment.
 * If the key doesn't exist yet it is created with an initial value of 1.
 */
export async function atomicIncrementScoringCounter(key: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // MySQL: INSERT … ON DUPLICATE KEY UPDATE performs an atomic read-modify-write
  await db.execute(
    sql`INSERT INTO scoring_config (configKey, configValue)
        VALUES (${key}, '1')
        ON DUPLICATE KEY UPDATE configValue = CAST(CAST(configValue AS UNSIGNED) + 1 AS CHAR)`
  );
  const result = await db
    .select({ v: scoringConfig.configValue })
    .from(scoringConfig)
    .where(eq(scoringConfig.configKey, key))
    .limit(1);
  return parseInt(result[0]?.v ?? "0", 10);
}

// ── Event-fingerprint deduplication helpers ───────────────────────────────────

/**
 * Look up an existing story by its event fingerprint.
 * Returns the first matching story (id + title) or null if none found.
 * Excludes stories that were themselves marked as duplicates — we want the
 * canonical story, not a chain of duplicates pointing at each other.
 */
export async function getStoryByEventFingerprint(
  fingerprint: string
): Promise<{ id: number; title: string } | null> {
  if (!fingerprint) return null;
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select({ id: stories.id, title: stories.title })
    .from(stories)
    .where(
      and(
        eq(stories.eventFingerprint, fingerprint),
        ne(stories.approvalStatus, "duplicate" as any),
        ne(stories.approvalStatus, "dismissed" as any),
        ne(stories.approvalStatus, "rejected" as any),
      )
    )
    .orderBy(desc(stories.createdAt))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Look up an existing story by its content hash.
 * Returns the first matching story (id + title) or null if none found.
 * Used to catch verbatim reposts (wire service syndication) with different URLs.
 */
export async function getStoryByContentHash(
  hash: string
): Promise<{ id: number; title: string } | null> {
  if (!hash) return null;
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select({ id: stories.id, title: stories.title })
    .from(stories)
    .where(
      and(
        eq(stories.contentHash, hash),
        ne(stories.approvalStatus, "duplicate" as any),
        ne(stories.approvalStatus, "dismissed" as any),
        ne(stories.approvalStatus, "rejected" as any),
      )
    )
    .orderBy(desc(stories.createdAt))
    .limit(1);
  return result[0] ?? null;
}

// ── Ingest Log ─────────────────────────────────────────────────────────────────────────────────

export async function batchInsertIngestLog(
  entries: InsertIngestLogEntry[]
): Promise<void> {
  if (!entries.length) return;
  const db = await getDb();
  if (!db) return;
  const CHUNK = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    await db.insert(ingestLog).values(entries.slice(i, i + CHUNK)).catch((err: unknown) => {
      console.warn("[IngestLog] batch insert warning:", err instanceof Error ? err.message : err);
    });
  }
}

export async function getIngestLog(opts?: {
  limit?: number;
  runId?: string;
  dropReason?: string;
  since?: Date;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (opts?.runId) conditions.push(eq(ingestLog.ingestRunId, opts.runId));
  if (opts?.dropReason) conditions.push(eq(ingestLog.dropReason, opts.dropReason));
  if (opts?.since) conditions.push(gte(ingestLog.createdAt, opts.since));
  return db
    .select()
    .from(ingestLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(ingestLog.createdAt))
    .limit(opts?.limit ?? 500);
}

export async function getIngestLogSummary(since?: Date) {
  const db = await getDb();
  if (!db) return [];
  const conditions = since ? [gte(ingestLog.createdAt, since)] : [];
  return db
    .select({
      dropReason: ingestLog.dropReason,
      count: sql<number>`count(*)`,
    })
    .from(ingestLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(ingestLog.dropReason)
    .orderBy(desc(sql<number>`count(*)`));
}

export async function pruneIngestLog(olderThanDays = 7): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  await db.delete(ingestLog).where(sql`${ingestLog.createdAt} < ${cutoff}`);
}

// ── Duplicate learning (confirmed pairs) ─────────────────────────────────────
// Editor-confirmed duplicate pairs stored in the duplicate_learning table.
// These are higher quality than the guessed title pairs in scoring_config.

export interface DuplicateCandidate {
  id: number;
  title: string;
  sourceName: string | null;
  publishedAt: Date | null;
  viralScore: number;
  confidence: number; // 0–1 ranking score used to sort candidates
}

/**
 * Find the top N candidate canonical stories for a given story.
 * Ranked by: event fingerprint match (1.0) > title similarity (0–0.8) > recency.
 * Returns up to `limit` candidates, excluding the story itself and any already
 * marked as duplicate/dismissed/rejected.
 */
export async function getDuplicateCandidates(
  storyId: number,
  limit = 5
): Promise<DuplicateCandidate[]> {
  const db = await getDb();
  if (!db) return [];

  // Fetch the story we're looking for a canonical for
  const storyRow = await db
    .select({ title: stories.title, eventFingerprint: stories.eventFingerprint })
    .from(stories)
    .where(eq(stories.id, storyId))
    .limit(1);
  if (!storyRow[0]) return [];
  const { title: dismissedTitle, eventFingerprint } = storyRow[0];

  // Fetch recent non-dismissed stories (last 500) to rank against
  const candidates = await db
    .select({
      id: stories.id,
      title: stories.title,
      sourceName: stories.sourceName,
      publishedAt: stories.publishedAt,
      viralScore: stories.viralScore,
      eventFingerprint: stories.eventFingerprint,
      createdAt: stories.createdAt,
    })
    .from(stories)
    .where(
      and(
        ne(stories.id, storyId),
        ne(stories.approvalStatus, "duplicate" as any),
        ne(stories.approvalStatus, "dismissed" as any),
        ne(stories.approvalStatus, "rejected" as any),
      )
    )
    .orderBy(desc(stories.createdAt))
    .limit(500);

  // Score each candidate
  const STOP_WORDS = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","is","was","are","were","has","have","had","be","been","by","as","it","its","this","that","from","after","over","into","up","out","about","than","more","not","no","new"]);
  const tokenise = (t: string): string[] =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
  const dismissedTokens = tokenise(dismissedTitle);
  const dismissedSet = new Set(dismissedTokens);

  const scored = candidates.map(c => {
    let confidence = 0;

    // Highest signal: matching event fingerprint
    if (eventFingerprint && c.eventFingerprint && eventFingerprint === c.eventFingerprint) {
      confidence = 1.0;
    } else {
      // Title similarity (Jaccard on tokens)
      const candTokens = tokenise(c.title);
      const candSet = new Set(candTokens);
      let intersectionSize = 0;
      Array.from(candSet).forEach(w => { if (dismissedSet.has(w)) intersectionSize++; });
      const unionSize = new Set([...Array.from(dismissedSet), ...Array.from(candSet)]).size;
      const sim = unionSize > 0 ? intersectionSize / unionSize : 0;
      confidence = sim * 0.8; // cap title similarity at 0.8 so fingerprint always wins
    }

    // Recency boost: stories from the last 7 days get a small bump
    const ageMs = Date.now() - (c.createdAt?.getTime() ?? 0);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 7) confidence += 0.05;

    return { ...c, confidence };
  });

  // Sort by confidence desc, then by createdAt desc as tiebreaker
  scored.sort((a, b) => b.confidence - a.confidence || (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

  return scored.slice(0, limit).map(c => ({
    id: c.id,
    title: c.title,
    sourceName: c.sourceName,
    publishedAt: c.publishedAt,
    viralScore: c.viralScore,
    confidence: Math.round(c.confidence * 100) / 100,
  }));
}

/**
 * Record an editor-confirmed duplicate pair in the duplicate_learning table.
 * Also writes the legacy Base64 pair for backwards compatibility with the
 * existing isSimilarTitle and llmDedupCheck functions.
 */
export async function recordConfirmedDuplicatePair(
  duplicateStoryId: number,
  canonicalStoryId: number,
  dismissedTitle: string,
  canonicalTitle: string,
  confidence: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    // Write to the new proper table (ID-based, source of truth)
    await db.insert(duplicateLearning).values({
      duplicateStoryId,
      canonicalStoryId,
      dismissedTitle,
      canonicalTitle,
      confidence,
    });
    // Also write to the legacy Base64 store for backwards compatibility
    // so isSimilarTitle and llmDedupCheck continue to benefit immediately
    await recordDuplicatePair(dismissedTitle, canonicalTitle);
    console.log(`[DuplicateLearning] Confirmed pair stored: "${dismissedTitle.slice(0, 60)}" → "${canonicalTitle.slice(0, 60)}" (conf: ${confidence})`);
  } catch (err) {
    console.warn("[DuplicateLearning] Failed to record confirmed pair:", err);
  }
}

/**
 * Retrieve the most recent N confirmed duplicate pairs from the proper table.
 * Falls back to the legacy Base64 store if the new table has fewer than `limit` rows.
 */
export async function getConfirmedDuplicatePairs(
  limit = 10
): Promise<Array<{ dismissed: string; canonical: string; at: string }>> {
  const db = await getDb();
  if (!db) return getRecentDuplicatePairs(limit);
  try {
    const rows = await db
      .select({
        dismissedTitle: duplicateLearning.dismissedTitle,
        canonicalTitle: duplicateLearning.canonicalTitle,
        createdAt: duplicateLearning.createdAt,
      })
      .from(duplicateLearning)
      .orderBy(desc(duplicateLearning.createdAt))
      .limit(limit);
    if (rows.length >= limit) {
      return rows.map(r => ({ dismissed: r.dismissedTitle, canonical: r.canonicalTitle, at: r.createdAt.toISOString() }));
    }
    // Supplement with legacy pairs if not enough confirmed ones yet
    const legacy = await getRecentDuplicatePairs(limit);
    const confirmed = rows.map(r => ({ dismissed: r.dismissedTitle, canonical: r.canonicalTitle, at: r.createdAt.toISOString() }));
    const confirmedDismissed = new Set(confirmed.map(p => p.dismissed));
    const supplementary = legacy.filter(p => !confirmedDismissed.has(p.dismissed));
    return [...confirmed, ...supplementary].slice(0, limit);
  } catch {
    // Table may not exist yet on first deploy — fall back to legacy
    return getRecentDuplicatePairs(limit);
  }
}

/** On server startup, find any packages stuck in 'processing' for more than 10 minutes
 * and mark them as 'failed'. This handles the case where a Railway restart killed the
 * pipeline mid-run — without this, the story would spin forever in the approved queue.
 */
export async function recoverStaleProcessingPackages(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await db
      .select({ storyId: storyPackages.storyId })
      .from(storyPackages)
      .where(
        and(
          eq(storyPackages.processingStatus, "processing"),
          lte(storyPackages.updatedAt, tenMinutesAgo)
        )
      );
    if (stale.length === 0) {
      console.log("[Recovery] No stale processing packages found.");
      return;
    }
    const staleIds = stale.map(r => r.storyId);
    const rawClient = (db as any).$client;
    const placeholders = staleIds.map(() => "?").join(",");
    const rawQuery = `UPDATE \`story_packages\` SET \`processingStatus\` = 'failed', \`processingError\` = ?, \`updatedAt\` = NOW() WHERE \`storyId\` IN (${placeholders})`;
    const params = ["Pipeline interrupted — server was restarted while processing. Click Re-Research to retry.", ...staleIds];
    if (typeof rawClient.execute === "function") {
      await rawClient.execute(rawQuery, params);
    } else {
      await rawClient.query(rawQuery, params);
    }
    console.log(`[Recovery] Marked ${stale.length} stale processing package(s) as failed: storyIds=${staleIds.join(",")}`);
  } catch (err) {
    console.warn("[Recovery] recoverStaleProcessingPackages error:", err);
  }
}
