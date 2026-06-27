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
  // Event-fingerprint deduplication — identifies the same real-world aviation event
  // regardless of headline wording or URL differences across sources.
  // Format: "<airline>|<flightno>|<aircraft>|<location>|<incidenttype>|<dateYYYYMMDD>"
  // Null when the story lacks enough structured data to fingerprint.
  eventFingerprint: varchar("eventFingerprint", { length: 512 }),
  // SHA-256 of normalised title+content — catches verbatim reposts with different URLs
  contentHash: varchar("contentHash", { length: 64 }),
  // Canonical URL after resolving redirects (Google News, AMP, etc.)
  canonicalUrl: varchar("canonicalUrl", { length: 768 }),
  approvalStatus: mysqlEnum("approvalStatus", [
    "pending",
    "approved",
    "rejected",
    "edited",
    "dismissed",
    "duplicate",
    "completed",
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
  /** All 10 headline objects with virality scores and types (JSON array) */
  headlineObjects: json("headlineObjects").$type<Array<{ headline: string; viralityScore: number | null; type: string | null; reason: string | null; rank: number }>>(),
  /** Virality score (1-10) for the selected headline */
  selectedViralityScore: int("selectedViralityScore"),
  /** Structural type of the selected headline (e.g. CONTRADICTION, MONEY, FACT) */
  selectedHeadlineType: varchar("selectedHeadlineType", { length: 64 }),
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
  // ── Research Package fields (new direction: extract everything, let ChatGPT write) ──
  /** 1-2 sentence summary of what happened */
  storySummary: text("storySummary"),
  /** Exhaustive extracted information (JSON array of strings) */
  researchExtracted: json("researchExtracted").$type<string[]>(),
  /** Chronological timeline of events */
  researchTimeline: text("researchTimeline"),
  /** Quotes grouped by source (JSON: { passengers, airline, officials, ... }) */
  researchQuotes: json("researchQuotes").$type<Record<string, string[]>>(),
  /** Sources used (JSON array: { name, url, type }) */
  researchSources: json("researchSources").$type<Array<{ name: string; url?: string; type: string }>>(),
  /** Contradictions between sources */
  researchContradictions: text("researchContradictions"),
  /** Information that remains unknown or unconfirmed */
  researchMissingInfo: text("researchMissingInfo"),
  /** Additional context separated from the main story */
  researchAdditionalContext: text("researchAdditionalContext"),
  /** Possible editorial hooks for the writer */
  researchEditorialHooks: json("researchEditorialHooks").$type<string[]>(),
  /** Quality assessment of the story */
  researchStoryQuality: json("researchStoryQuality").$type<string[]>(),
  // ── Structured aviation fields ──
  /** Flight number (e.g. AA123) */
  researchFlightNumber: varchar("researchFlightNumber", { length: 64 }),
  /** Route (e.g. London Heathrow to New York JFK) */
  researchRoute: text("researchRoute"),
  /** Aircraft type and registration */
  researchAircraftType: text("researchAircraftType"),
  /** Number of passengers on board */
  researchPassengerCount: varchar("researchPassengerCount", { length: 64 }),
  /** Number of crew on board */
  researchCrewCount: varchar("researchCrewCount", { length: 64 }),
  /** Date the event occurred */
  researchEventDate: varchar("researchEventDate", { length: 64 }),
  /** Publication date of the primary source */
  researchPublicationDate: varchar("researchPublicationDate", { length: 64 }),
  /** Key entities: airlines, airports, aircraft, people */
  researchKeyEntities: text("researchKeyEntities"),
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
  /** Structural type of the headline used (CONTRADICTION, MONEY, FACT, HUMAN, VIRAL) */
  headlineType: varchar("headlineType", { length: 64 }),
  /** Virality score assigned by the LLM at generation time (1-10) */
  headlineViralityScore: int("headlineViralityScore"),
  // ── New social performance fields ──
  /** Number of saves / bookmarks */
  saves: int("saves"),
  /** Net followers gained from this post */
  followersGained: int("followersGained"),
  /** Platform posted on (e.g. Instagram, TikTok, YouTube) */
  platform: varchar("platform", { length: 64 }),
  /** Airline featured in the story */
  airline: varchar("airline", { length: 128 }),
  /** Type of image used (e.g. aircraft, airport, cockpit, text-only) */
  imageType: varchar("imageType", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type HistoricalPost = typeof historicalPosts.$inferSelect;
export type InsertHistoricalPost = typeof historicalPosts.$inferInsert;

// Every URL seen during ingestion — including ones rejected by the score gate.
export const seenUrls = mysqlTable("seen_urls", {
  id: int("id").autoincrement().primaryKey(),
  url: varchar("url", { length: 768 }).notNull().unique(),
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
