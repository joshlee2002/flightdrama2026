import { countRssSources, upsertRssSource, getDb } from "./db";
import { DEFAULT_RSS_SOURCES } from "./ingestion";

/**
 * Seeds the rss_sources table with all default FlightDrama sources.
 * Safe to call multiple times — uses upsert logic.
 */
export async function seedRssSources(): Promise<void> {
  try {
    for (const source of DEFAULT_RSS_SOURCES) {
      await upsertRssSource({
        name: source.name,
        url: source.url,
        category: source.category,
        isActive: true,
      });
    }
    console.log(`[Seed] Seeded ${DEFAULT_RSS_SOURCES.length} RSS sources`);
  } catch (err) {
    console.error("[Seed] Failed to seed RSS sources:", err);
  }
}

/**
 * Applies any pending schema migrations that are not tracked by drizzle-kit.
 * Each migration is idempotent — safe to run on every startup.
 */
export async function runSchemaMigrations(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // ── Migration 1: approvalStatus enum (completed) ────────────────────────
  try {
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "ALTER TABLE `stories` MODIFY COLUMN `approvalStatus` enum('pending','approved','rejected','edited','dismissed','duplicate','completed') NOT NULL DEFAULT 'pending'" as any
    );
    console.log("[Migration] approvalStatus enum updated (completed added)");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Duplicate column") && !msg.includes("already exists")) {
      console.warn("[Migration] approvalStatus enum migration warning:", msg);
    }
  }

  // ── Migration 2: event-fingerprint dedup columns ──────────────────────────
  // Adds eventFingerprint, contentHash, canonicalUrl to stories.
  // Uses IF NOT EXISTS pattern via INFORMATION_SCHEMA check — fully idempotent.
  const colMigrations: Array<{ col: string; ddl: string }> = [
    {
      col: "eventFingerprint",
      ddl: "ALTER TABLE `stories` ADD COLUMN `eventFingerprint` varchar(512) NULL",
    },
    {
      col: "contentHash",
      ddl: "ALTER TABLE `stories` ADD COLUMN `contentHash` varchar(64) NULL",
    },
    {
      col: "canonicalUrl",
      ddl: "ALTER TABLE `stories` ADD COLUMN `canonicalUrl` varchar(768) NULL",
    },
  ];
  for (const { col, ddl } of colMigrations) {
    try {
      await db.execute(ddl as any);
      console.log(`[Migration] stories.${col} column added`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // errno 1060 = Duplicate column name — column already exists, that's fine
      if (!msg.includes("Duplicate column") && !msg.includes("already exists")) {
        console.warn(`[Migration] stories.${col} migration warning:`, msg);
      }
    }
  }

  // ── Migration 3: indexes for fingerprint lookups ──────────────────────────
  const idxMigrations: Array<{ name: string; ddl: string }> = [
    {
      name: "stories_eventFingerprint_idx",
      ddl: "CREATE INDEX `stories_eventFingerprint_idx` ON `stories` (`eventFingerprint`)",
    },
    {
      name: "stories_contentHash_idx",
      ddl: "CREATE INDEX `stories_contentHash_idx` ON `stories` (`contentHash`)",
    },
  ];
  for (const { name, ddl } of idxMigrations) {
    try {
      await db.execute(ddl as any);
      console.log(`[Migration] Index ${name} created`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // errno 1061 = Duplicate key name — index already exists, that's fine
      if (!msg.includes("Duplicate key") && !msg.includes("already exists")) {
        console.warn(`[Migration] Index ${name} warning:`, msg);
      }
    }
  }

  // ── Migration 4a: scoringMethod enum — add stat_adjusted ────────────────
  try {
    await db.execute(
      "ALTER TABLE `stories` MODIFY COLUMN `scoringMethod` ENUM('rule_based','llm_assisted','stat_adjusted') NOT NULL DEFAULT 'rule_based'" as any
    );
    console.log("[Migration] scoringMethod enum updated (stat_adjusted added)");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Duplicate column") && !msg.includes("already exists")) {
      console.warn("[Migration] scoringMethod enum migration warning:", msg);
    }
  }

  // ── Migration 6: apprentice transparency columns ──────────────────────────
  // Adds ruleScore, apprenticeConfidence, apprenticeReasoning, similarExamplesUsed
  // to the stories table. All nullable — existing rows are unaffected.
  // CRITICAL: without these columns, createStory() throws on every ingest insert.
  const apprenticeColMigrations: Array<{ col: string; ddl: string }> = [
    {
      col: "ruleScore",
      ddl: "ALTER TABLE `stories` ADD COLUMN `ruleScore` int NULL",
    },
    {
      col: "apprenticeConfidence",
      ddl: "ALTER TABLE `stories` ADD COLUMN `apprenticeConfidence` varchar(16) NULL",
    },
    {
      col: "apprenticeReasoning",
      ddl: "ALTER TABLE `stories` ADD COLUMN `apprenticeReasoning` text NULL",
    },
    {
      col: "similarExamplesUsed",
      ddl: "ALTER TABLE `stories` ADD COLUMN `similarExamplesUsed` json NULL",
    },
  ];
  for (const { col, ddl } of apprenticeColMigrations) {
    try {
      await db.execute(ddl as any);
      console.log(`[Migration] stories.${col} column added`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Duplicate column") && !msg.includes("already exists")) {
        console.warn(`[Migration] stories.${col} migration warning:`, msg);
      }
    }
  }

  // ── Migration 5: seen_urls UNIQUE constraint on url ───────────────────────
  // Without this, ON DUPLICATE KEY UPDATE in markUrlAsSeen is a no-op and
  // the same URL can appear multiple times in seen_urls.
  try {
    // First deduplicate any existing rows (keep newest per url)
    await db.execute(
      "DELETE s1 FROM `seen_urls` s1 INNER JOIN `seen_urls` s2 ON s1.url = s2.url AND s1.id < s2.id" as any
    );
    await db.execute(
      "ALTER TABLE `seen_urls` ADD CONSTRAINT `seen_urls_url_unique` UNIQUE (`url`)" as any
    );
    console.log("[Migration] seen_urls.url UNIQUE constraint added");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Duplicate key") && !msg.includes("already exists")) {
      console.warn("[Migration] seen_urls UNIQUE constraint warning:", msg);
    }
  }

  // ── Migration 7: ingest_log diagnostic table ─────────────────────────────
  try {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS \`ingest_log\` (
        \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`ingestRunId\` varchar(36) NOT NULL,
        \`title\` varchar(500) NOT NULL,
        \`sourceUrl\` varchar(768) NOT NULL,
        \`sourceName\` varchar(255) NOT NULL,
        \`dropReason\` varchar(64) NOT NULL,
        \`dropDetail\` varchar(500) NULL,
        \`ruleScore\` int NULL,
        \`llmScore\` int NULL,
        \`feedThreshold\` int NULL,
        \`category\` varchar(64) NULL,
        \`publishedAt\` timestamp NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX \`ingest_log_runId_idx\` (\`ingestRunId\`),
        INDEX \`ingest_log_dropReason_idx\` (\`dropReason\`),
        INDEX \`ingest_log_createdAt_idx\` (\`createdAt\`)
      )` as any
    );
    console.log("[Migration] ingest_log table created");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      console.warn("[Migration] ingest_log table warning:", msg);
    }
  }

  // ── Migration 9: duplicate_learning table ──────────────────────────────────
  // Stores editor-confirmed duplicate pairs (story IDs + titles at time of dismissal).
  // Replaces the noisy guessed-title pairs stored in scoring_config.
  try {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS \`duplicate_learning\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`duplicateStoryId\` int NOT NULL,
        \`canonicalStoryId\` int NOT NULL,
        \`dismissedTitle\` text NOT NULL,
        \`canonicalTitle\` text NOT NULL,
        \`confidence\` float NOT NULL DEFAULT 1.0,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_dup_learning_canonical\` (\`canonicalStoryId\`),
        KEY \`idx_dup_learning_duplicate\` (\`duplicateStoryId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` as any
    );
    console.log("[Migration] duplicate_learning table ensured");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      console.warn("[Migration] duplicate_learning table warning:", msg);
    }
  }

  // ── Migration 8: clear stale seen_url blocks ─────────────────────────────────
  // Stories that were previously rejected by the keyword gate or scored below
  // threshold are permanently blocked from re-evaluation. This is wrong —
  // the gate has been improved and scores change as the LLM learns. Clear all
  // non-manual-rejection blocks so every story gets a fresh look on next ingest.
  // Manual rejections (approvalStatus=rejected on the stories table) are NOT touched.
  try {
    const result = await db.execute(
      `DELETE FROM \`seen_urls\` WHERE \`rejectedReason\` IN ('score_below_threshold', 'not_aviation', 'score_below_rule', 'score_below_feed')` as any
    ) as any;
    const affected = result?.[0]?.affectedRows ?? result?.affectedRows ?? '?';
    console.log(`[Migration] Cleared ${affected} stale seen_url blocks — stories will be re-evaluated on next ingest`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[Migration] seen_urls stale block clear warning:", msg);
  }
}

/**
 * Run seed on startup if the table is empty.
 */
export async function seedOnStartup(): Promise<void> {
  // Always run schema migrations first
  await runSchemaMigrations();

  try {
    const count = await countRssSources();
    if (count === 0) {
      console.log("[Seed] RSS sources table is empty, seeding defaults...");
      await seedRssSources();
    }
  } catch (err) {
    console.error("[Seed] Startup seed check failed:", err);
  }
}
