import { countRssSources, upsertRssSource } from "./db";
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
 * Run seed on startup if the table is empty.
 */
export async function seedOnStartup(): Promise<void> {
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
