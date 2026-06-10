/**
 * Heartbeat handler for the daily auto-learn cron job.
 *
 * Registered at POST /api/scheduled/learn-from-overrides
 * Triggered daily at 03:00 UTC by the Manus platform heartbeat.
 *
 * Authenticates via sdk.authenticateRequest (user.isCron === true),
 * then runs learnFromOverrides() to analyse all editor overrides and
 * rewrite the scoring rules in scoring_config.
 *
 * After the learn cycle, regenerates AI keyword feeds based on the latest
 * rated story patterns (amazing/good ratings → Core/Explore/Test tier feeds).
 */

import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { learnFromOverrides } from "./llmScoring";
import { regenerateKeywordFeeds } from "./keywordGenerator";

export async function scheduledLearnHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[ScheduledLearn] Cron triggered (taskUid: ${user.taskUid}) — running learnFromOverrides...`);

    const result = await learnFromOverrides();

    console.log(
      `[ScheduledLearn] Learn complete — success: ${result.success}, examples: ${result.examplesUsed}, summary: ${result.summary}`
    );

    // After learning from overrides, regenerate AI keyword feeds based on
    // the latest amazing/good-rated story patterns
    let keywordResult = { created: 0, updated: 0, expired: 0 };
    try {
      console.log("[ScheduledLearn] Regenerating AI keyword feeds...");
      keywordResult = await regenerateKeywordFeeds();
      console.log(
        `[ScheduledLearn] Keyword feeds updated — created: ${keywordResult.created}, updated: ${keywordResult.updated}, expired: ${keywordResult.expired}`
      );
    } catch (kwErr) {
      console.error("[ScheduledLearn] Keyword feed regeneration failed (non-fatal):", kwErr);
    }

    return res.json({
      ok: true,
      success: result.success,
      examplesUsed: result.examplesUsed,
      summary: result.summary,
      keywordFeeds: keywordResult,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[ScheduledLearn] Handler error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
      stack: err instanceof Error ? err.stack : undefined,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
