/**
 * Scheduled pipeline processor.
 *
 * Registered at POST /api/scheduled/pipeline
 *
 * DISABLED: Pre-processing is no longer automatic.
 * Research (extractResearchPackage) now runs only when a story is approved,
 * eliminating wasted LLM calls on stories that never get approved.
 * The approve flow already checks for an existing complete package and reuses
 * it if present, so pre-warming provides no benefit at 80+ approvals/day.
 *
 * This handler is kept as a no-op so the cron endpoint continues to respond
 * 200 OK without errors. Re-enable by restoring the processing block below.
 */
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
// Imports kept for easy re-enable:
// import { getDb, getStoryById, updateStoryPackage, createStoryPackage } from "./db";
// import { extractResearchPackage, researchImages } from "./soyunci";
// import { storyPackages, stories } from "../drizzle/schema";
// import { eq, and, sql, desc } from "drizzle-orm";

// const BATCH_SIZE = 5;
// const PIPELINE_SCORE_GATE = 75;

export async function scheduledPipelineHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    // DISABLED: pre-processing pipeline is a no-op.
    // Research runs on-demand when a story is approved (see routers.ts approve mutation).
    console.log(`[Pipeline] Cron triggered (taskUid: ${user.taskUid}) — pre-processing disabled, skipping.`);
    return res.json({ ok: true, processed: 0, message: "Pre-processing pipeline disabled — research runs on approve" });
  } catch (err) {
    console.error("[Pipeline] Handler error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
}
