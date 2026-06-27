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

  try {
    // Migration: add 'completed' to the approvalStatus enum on the stories table.
    // MySQL ALTER TABLE MODIFY is idempotent — re-running it with the same definition
    // is a no-op. We wrap in try/catch so a DB permission issue never blocks startup.
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "ALTER TABLE `stories` MODIFY COLUMN `approvalStatus` enum('pending','approved','rejected','edited','dismissed','duplicate','completed') NOT NULL DEFAULT 'pending'" as any
    );
    console.log("[Migration] approvalStatus enum updated (completed added)");
  } catch (err: unknown) {
    // Ignore "nothing to change" errors from MySQL (errno 1060 / 1061 etc.)
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Duplicate column") && !msg.includes("already exists")) {
      console.warn("[Migration] approvalStatus enum migration warning:", msg);
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
