import { Request, Response } from "express";
import { getDb } from "./db";
import { stories, storyPackages } from "../drizzle/schema";
import { inArray, lt, and } from "drizzle-orm";
import sdk from "@manus-app/express";

/**
 * Scheduled DB Cleanup Job
 * Runs daily to delete rejected and dismissed stories older than 30 days.
 * This keeps the stories and story_packages tables lean.
 *
 * NOTE: It does NOT delete from seenUrls, so the dedup system still knows
 * we've seen those URLs and won't re-ingest them.
 */
export async function scheduledDbCleanupHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[DBCleanup] Cron triggered (taskUid: ${user.taskUid}) — checking for old rejected stories...`);

    const db = await getDb();
    if (!db) {
      return res.json({ ok: true, deleted: 0, message: "No database connection" });
    }

    // Find stories that are rejected/dismissed and older than 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldStories = await db
      .select({ id: stories.id })
      .from(stories)
      .where(
        and(
          inArray(stories.approvalStatus, ["rejected", "dismissed"]),
          lt(stories.createdAt, thirtyDaysAgo)
        )
      );

    if (oldStories.length === 0) {
      console.log(`[DBCleanup] No old rejected stories to delete.`);
      return res.json({ ok: true, deleted: 0, message: "No old stories to delete" });
    }

    const idsToDelete = oldStories.map(s => s.id);

    // Delete packages first (foreign key constraint)
    await db.delete(storyPackages).where(inArray(storyPackages.storyId, idsToDelete));
    
    // Delete stories
    await db.delete(stories).where(inArray(stories.id, idsToDelete));

    console.log(`[DBCleanup] Successfully deleted ${idsToDelete.length} old rejected/dismissed stories.`);

    return res.json({ ok: true, deleted: idsToDelete.length });
  } catch (err) {
    console.error("[DBCleanup] Handler error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
}
