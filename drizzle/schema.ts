import {
  boolean,
  float,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// RSS feed sources for aviation news ingestion
export const rssSources = mysqlTable("rss_sources", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  url: varchar("url", { length: 768 }).notNull().unique(),
  category: varchar("category", { length: 64 }).default("aviation").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  lastFetchedAt: timestamp("lastFetchedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  // AI keyword feed fields
  sourceType: mysqlEnum("sourceType", ["manual", "ai_keyword"]).default("manual").notNull(),
  tier: mysqlEnum("tier", ["core", "explore", "test"]),
  scoreThreshold: int("scoreThreshold").default(0).notNull(),
  ratedStoryCount: int("ratedStoryCount").default(0).notNull(),
  lastRatedAt: timestamp("lastRatedAt"),
  expiresAt: timestamp("expiresAt"),
});

export type RssSource = typeof rssSources.$inferSelect;
export type InsertRssSource = typeof rssSources.$inferInsert;

// Scored and ranked aviation stories
export const stories = mysqlTable("stories", {
  id: int("id").autoincrement().primaryKey(),
  title: text("title").notNull(),
  sourceUrl: varchar("sourceUrl", { length: 768 }).notNull().unique(),
  sourceName: varchar("sourceName", { length: 256 }),
  content: text("content"),
  publishedAt: timestamp("publishedAt"),
  viralScore: int("viralScore").default(0).notNull(),
  statusLabel: mysqlEnum("statusLabel", [
    "must_post",
    "strong_candidate",
    "maybe",
    "reject",
  ])
    .default("reject")
    .notNull(),
  category: varchar("category", { length: 128 }),
  viralReason: text("viralReason"),
  viralTriggers: json("viralTriggers").$type<string[]>(),
  overrideScore: int("overrideScore"),
  overrideLabel: mysqlEnum("overrideLabel", [
    "must_post",
    "strong_candidate",
    "maybe",
    "reject",
  ]),
  isDuplicate: boolean("isDuplicate").default(false).notNull(),
  duplicateOf: int("duplicateOf"),
  approvalStatus: mysqlEnum("approvalStatus", [
    "pending",
    "approved",
    "rejected",
    "edited",
    "dismissed",
  ])
    .default("pending")
    .notNull(),
  scoringMethod: mysqlEnum("scoringMethod", ["rule_based", "llm_assisted"])
    .default("rule_based")
    .notNull(),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Story = typeof stories.$inferSelect;
export type InsertStory = typeof stories.$inferInsert;

// Full content packages produced by the Soyunci pipeline
export const storyPackages = mysqlTable("story_packages", {
  id: int("id").autoincrement().primaryKey(),
  storyId: int("storyId").notNull().unique(),
  soyunciArticle: text("soyunciArticle"),
  hashtags: json("hashtags").$type<string[]>(),
  imageRecommendations: json("imageRecommendations").$type<any[]>(),
  imageCandidates: json("imageCandidates").$type<Record<string, any[]>>(),
  allHeadlines: json("allHeadlines").$type<string[]>(),
  topThreeHeadlines: json("topThreeHeadlines").$type<string[]>(),
  selectedHeadline: text("selectedHeadline"),
  canvaHeadline: text("canvaHeadline"),
  canvaAspectRatio: varchar("canvaAspectRatio", { length: 32 }),
  canvaVisualIdea: text("canvaVisualIdea"),
  canvaAircraftToShow: text("canvaAircraftToShow"),
  canvaMood: varchar("canvaMood", { length: 128 }),
  canvaBackground: text("canvaBackground"),
  canvaHierarchy: text("canvaHierarchy"),
  canvaCircleInsert: text("canvaCircleInsert"),
  processingStatus: mysqlEnum("processingStatus", [
    "queued",
    "processing",
    "complete",
    "failed",
  ])
    .default("queued")
    .notNull(),
  processingError: text("processingError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  soyunciRating: varchar("soyunci_rating", { length: 20 }),
  soyunciFeedbackNote: text("soyunci_feedback_note"),
  researchContext: text("researchContext"),
  viralAngle: text("viralAngle"),
  extractedFacts: text("extractedFacts"),
  alternativeHeadlines: text("alternativeHeadlines"),
  /** Number of sources successfully fetched and used during the Soyunci research step. */
  sourcesResearched: int("sourcesResearched").default(0),
  /** Human-readable confirmation of what source material was read (e.g. "✅ Read 1,247 words from primary source + 3 secondary sources") */
  sourceConfirmation: text("sourceConfirmation"),
  /** FlightDrama Editor quality review (JSON) */
  editorReview: json("editorReview").$type<{
    storyAngle: string;
    biggestWeakness: string;
    missingContext: string;
    fillerSentences: string[];
    soyunciScore: number;
    verdict: "Approve" | "Needs Revision";
  }>(),
  /** Editor score (1-10) for quick filtering */
  editorScore: int("editorScore"),
});

export type StoryPackage = typeof storyPackages.$inferSelect;
export type InsertStoryPackage = typeof storyPackages.$inferInsert;

// Historical performance data for improving the scoring model
export const historicalPosts = mysqlTable("historical_posts", {
  id: int("id").autoincrement().primaryKey(),
  headline: text("headline").notNull(),
  article: text("article"),
  category: varchar("category", { length: 128 }),
  postingTime: varchar("postingTime", { length: 32 }),
  views: int("views"),
  likes: int("likes"),
  comments: int("comments"),
  shares: int("shares"),
  revenue: float("revenue"),
  netFollows: int("netFollows"),
  sourceType: varchar("sourceType", { length: 128 }),
  aircraftType: varchar("aircraftType", { length: 128 }),
  storyType: varchar("storyType", { length: 128 }),
  storyId: int("storyId"),
  viralAngle: varchar("viralAngle", { length: 128 }),
  selectedHeadline: text("selectedHeadline"),
  articleSnippet: text("articleSnippet"),
  usedHeadlineVariant: varchar("usedHeadlineVariant", { length: 32 }),
  instagramPostId: varchar("instagramPostId", { length: 64 }),
  reach: int("reach"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type HistoricalPost = typeof historicalPosts.$inferSelect;
export type InsertHistoricalPost = typeof historicalPosts.$inferInsert;

// Every URL seen during ingestion — including ones rejected by the score gate.
export const seenUrls = mysqlTable("seen_urls", {
  id: int("id").autoincrement().primaryKey(),
  url: varchar("url", { length: 768 }).notNull(),
  rejectedReason: varchar("rejectedReason", { length: 128 }),
  seenAt: timestamp("seenAt").defaultNow().notNull(),
});

export type SeenUrl = typeof seenUrls.$inferSelect;
export type InsertSeenUrl = typeof seenUrls.$inferInsert;

// Key/value store for LLM-generated scoring rules and weights.
export const scoringConfig = mysqlTable("scoring_config", {
  id: int("id").autoincrement().primaryKey(),
  configKey: varchar("configKey", { length: 128 }).notNull().unique(),
  configValue: text("configValue").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ScoringConfig = typeof scoringConfig.$inferSelect;
export type InsertScoringConfig = typeof scoringConfig.$inferInsert;

// Example articles used as one-shot voice references for the article writing LLM
export const exampleArticles = mysqlTable("example_articles", {
  id: int("id").autoincrement().primaryKey(),
  label: varchar("label", { length: 256 }).notNull(),
  articleText: text("articleText").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ExampleArticle = typeof exampleArticles.$inferSelect;
export type InsertExampleArticle = typeof exampleArticles.$inferInsert;

// Weekly digest summaries generated by the LLM
export const weeklyDigests = mysqlTable("weekly_digests", {
  id: int("id").autoincrement().primaryKey(),
  weekStart: timestamp("weekStart").notNull(),
  weekEnd: timestamp("weekEnd").notNull(),
  storiesApproved: int("storiesApproved").default(0).notNull(),
  topCategory: varchar("topCategory", { length: 128 }),
  topStoryTitle: text("topStoryTitle"),
  topStoryScore: int("topStoryScore"),
  summary: text("summary").notNull(),
  recommendations: text("recommendations").notNull(),
  rawData: json("rawData").$type<Record<string, any>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type WeeklyDigest = typeof weeklyDigests.$inferSelect;
export type InsertWeeklyDigest = typeof weeklyDigests.$inferInsert;
