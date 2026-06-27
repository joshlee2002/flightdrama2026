/**
 * Heartbeat handler for the hourly RSS ingestion cron job.
 *
 * Registered at POST /api/scheduled/ingest
 * Triggered every hour by the Manus platform heartbeat.
 *
 * This is now a thin wrapper around runIngestPipeline() in ingestPipeline.ts,
 * which contains the full dedup + scoring logic. Both the cron job and the
 * manual "Refresh Feeds" UI button call the same function so dedup is never
 * bypassed regardless of which path triggers an ingest.
 */
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { runIngestPipeline } from "./ingestPipeline";

export async function scheduledIngestHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[ScheduledIngest] Cron triggered (taskUid: ${user.taskUid})`);

    const result = await runIngestPipeline("ScheduledIngest");

    return res.json({
      ok: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[ScheduledIngest] Handler error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
      stack: err instanceof Error ? err.stack : undefined,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
