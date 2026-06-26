import { Request, Response } from "express";
import { getDb } from "./db";
import { stories, storyPackages, seenUrls } from "../drizzle/schema";
import { inArray, lt, and } from "drizzle-orm";
import { sdk } from "./_core/sdk";

/**
 * Scheduled DB Cleanup Job
 * Runs daily to:
 *   1. Delete rejected/dismissed stories older than 30 days
 *   2. Delete seen_urls entries older than 90 days where reason is
 *      'not_aviation' or 'score_below_threshold' — these are safe to
 *      expire since the URL will simply be re-evaluated if it reappears.
 *      'manually_rejected' and 'similar_title' entries are kept forever.
 */
export async function scheduledDbCleanupHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[DBCleanup] Cron triggered (taskUid: ${user.taskUid}) — running cleanup...`);

    const db = await getDb();
    if (!db) {
      return res.json({ ok: true, deleted: 0, seenUrlsDeleted: 0, message: "No database connection" });
    }

    // ── 1. Delete old rejected/dismissed stories ──────────────────────────
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

    let deletedStories = 0;
    if (oldStories.length > 0) {
      const idsToDelete = oldStories.map(s => s.id);
      // Delete packages first (foreign key constraint)
      await db.delete(storyPackages).where(inArray(storyPackages.storyId, idsToDelete));
      await db.delete(stories).where(inArray(stories.id, idsToDelete));
      deletedStories = idsToDelete.length;
      console.log(`[DBCleanup] Deleted ${deletedStories} old rejected/dismissed stories.`);
    } else {
      console.log(`[DBCleanup] No old rejected stories to delete.`);
    }

    // ── 2. Clean up old seen_urls entries ─────────────────────────────────
    // 'not_aviation' and 'score_below_threshold' entries older than 90 days
    // are safe to expire — if the URL reappears it will just be re-evaluated.
    // 'manually_rejected' and 'similar_title' are kept permanently.
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const { sql } = await import("drizzle-orm");
    const deleteResult = await db.delete(seenUrls).where(
      and(
        sql`${seenUrls.rejectedReason} IN ('not_aviation', 'score_below_threshold')`,
        lt(seenUrls.seenAt, ninetyDaysAgo)
      )
    );
    const seenUrlsDeleted = (deleteResult as any)?.rowsAffected ?? 0;
    if (seenUrlsDeleted > 0) {
      console.log(`[DBCleanup] Deleted ${seenUrlsDeleted} old seen_urls entries (not_aviation/score_below_threshold >90 days).`);
    }

    return res.json({
      ok: true,
      deleted: deletedStories,
      seenUrlsDeleted,
      message: `Deleted ${deletedStories} stories and ${seenUrlsDeleted} old seen_urls entries.`,
    });
  } catch (err) {
    console.error("[DBCleanup] Handler error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
}
