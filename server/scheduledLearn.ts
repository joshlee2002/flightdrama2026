/**
 * Heartbeat handler for the daily auto-learn cron job.
 *
 * Registered at POST /api/scheduled/learn-from-overrides
 * Triggered daily at 03:00 UTC by the Manus platform heartbeat.
 *
 * Runs the full learning pipeline in order:
 *   1. Statistical learner (free) — recalculates keyword boosts/penalties and
 *      category weights from all override history.
 *   2. Statistical performance analysis (free) — recalculates engagement patterns
 *      from historical_posts (likes, views, saves) and updates scoring_config.
 *   3. LLM deep learner — analyses all overrides and rewrites scoring rules.
 *   4. Keyword feed regeneration — generates new AI RSS feeds from rated stories
 *      AND override signals.
 */

import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { learnFromOverrides, learnFromOverridesStatistical } from "./llmScoring";
import { regenerateKeywordFeeds } from "./keywordGenerator";
import { analysePerformanceStatistical } from "./performanceAnalysis";

export async function scheduledLearnHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[ScheduledLearn] Cron triggered (taskUid: ${user.taskUid}) — running full learning pipeline...`);

    // ── Step 1: Free statistical learner (override-based) ────────────────────
    // Recalculates keyword boosts/penalties and category weights from override history.
    // Always runs first so the LLM learner has fresh stat context.
    let statResult = { success: false, summary: "skipped", examplesUsed: 0 };
    try {
      console.log("[ScheduledLearn] Step 1 — statistical override learner...");
      statResult = await learnFromOverridesStatistical();
      console.log(`[ScheduledLearn] Step 1 complete — ${statResult.summary}`);
    } catch (statErr) {
      console.error("[ScheduledLearn] Step 1 failed (non-fatal):", statErr);
    }

    // ── Step 2: Free statistical performance analysis (historical_posts) ──────
    // Recalculates engagement patterns from real post data (likes, views, saves).
    // Updates stat_perf_* keys in scoring_config used by the scoring engine.
    let perfResult: { totalPosts?: number; avgEngagement?: number } | null = null;
    try {
      console.log("[ScheduledLearn] Step 2 — statistical performance analysis...");
      perfResult = await analysePerformanceStatistical();
      if (perfResult) {
        console.log(`[ScheduledLearn] Step 2 complete — ${perfResult.totalPosts ?? 0} posts analysed, avg engagement ${perfResult.avgEngagement ?? 0}`);
      } else {
        console.log("[ScheduledLearn] Step 2 — not enough historical posts yet (need ≥2 with metrics)");
      }
    } catch (perfErr) {
      console.error("[ScheduledLearn] Step 2 failed (non-fatal):", perfErr);
    }

    // ── Step 3: LLM deep learner ──────────────────────────────────────────────
    // Analyses all overrides and rewrites scoring rules using the LLM.
    // This is the most expensive step — runs once per day.
    const result = await learnFromOverrides();
    console.log(
      `[ScheduledLearn] Step 3 complete — success: ${result.success}, examples: ${result.examplesUsed}, summary: ${result.summary}`
    );

    // ── Step 4: Keyword feed regeneration ────────────────────────────────────
    // Generates new AI RSS feeds from rated stories AND override signals.
    let keywordResult = { created: 0, updated: 0, expired: 0 };
    try {
      console.log("[ScheduledLearn] Step 4 — regenerating AI keyword feeds...");
      keywordResult = await regenerateKeywordFeeds();
      console.log(
        `[ScheduledLearn] Step 4 complete — created: ${keywordResult.created}, updated: ${keywordResult.updated}, expired: ${keywordResult.expired}`
      );
    } catch (kwErr) {
      console.error("[ScheduledLearn] Step 4 failed (non-fatal):", kwErr);
    }

    return res.json({
      ok: true,
      success: result.success,
      examplesUsed: result.examplesUsed,
      summary: result.summary,
      statLearner: statResult,
      perfAnalysis: perfResult ? { totalPosts: perfResult.totalPosts, avgEngagement: perfResult.avgEngagement } : null,
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
