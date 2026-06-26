import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { DEFAULT_RSS_SOURCES } from "./ingestion";
import { drizzle } from "drizzle-orm/mysql2";
import {
  exampleArticles,
  historicalPosts,
  InsertHistoricalPost,
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
  // Only update name and url on conflict — do NOT overwrite category so that
  // manual DB category corrections (aviation vs viral) are preserved across reseeds.
  await db
    .insert(rssSources)
    .values(source)
    .onDuplicateKeyUpdate({ set: { name: source.name, url: source.url } });
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
    // Default: exclude rejected and dismissed stories from the dashboard
    conditions.push(ne(stories.approvalStatus, "rejected" as any));
    conditions.push(ne(stories.approvalStatus, "dismissed" as any));
    conditions.push(ne(stories.approvalStatus, "duplicate" as any));
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
    .limit(filters?.limit || 500);

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
  status: "approved" | "rejected" | "edited" | "pending" | "dismissed" | "duplicate"
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
  scoringMethod: "rule_based" | "llm_assisted" = "rule_based"
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

export async function getHistoricalPosts(limit = 100) {
  const db = await getDb();
  if (!db) return [];
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
    return { llmScoringEnabled: false, autoPerfAnalysisEnabled: false, autoKeywordRegenEnabled: false, autoDeepLearnEnabled: false };
  }
  const rows = await db.select().from(scoringConfig).where(
    sql`configKey IN ('llm_scoring_enabled','auto_perf_analysis_enabled','auto_keyword_regen_enabled','auto_deep_learn_enabled')`
  );
  const map = Object.fromEntries(rows.map(r => [r.configKey, r.configValue]));
  return {
    llmScoringEnabled: map["llm_scoring_enabled"] === "true",
    autoPerfAnalysisEnabled: map["auto_perf_analysis_enabled"] === "true",
    autoKeywordRegenEnabled: map["auto_keyword_regen_enabled"] === "true",
    autoDeepLearnEnabled: map["auto_deep_learn_enabled"] === "true",
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
