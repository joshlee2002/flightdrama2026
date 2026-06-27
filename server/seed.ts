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

  // ── Migration 4: seen_urls UNIQUE constraint on url ───────────────────────
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
