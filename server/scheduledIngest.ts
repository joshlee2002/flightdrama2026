/**
 * Heartbeat handler for the hourly RSS ingestion cron job.
 *
 * Registered at POST /api/scheduled/ingest-rss
 * Triggered every hour by the Manus platform heartbeat.
 *
 * Authenticates via sdk.authenticateRequest (user.isCron === true),
 * then fetches all active RSS sources, scores new stories, and
 * ingests them into the database.
 *
 * Per-feed score thresholds: AI keyword feeds use their own scoreThreshold
 * (Core=80, Explore=70, Test=75). Standard feeds default to 40.
 * Expired AI keyword feeds are skipped and auto-disabled.
 */
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import {
  getActiveRssSources,
  getRecentStoryTitles,
  hasSeenUrl,
  markUrlAsSeen,
  createStory,
  updateRssSourceLastFetched,
  createStoryPackage,
  getDb,
} from "./db";
import {
  fetchRssFeed,
  fetchArticleContent,
  isSimilarTitle,
  isAviationRelevant,
} from "./ingestion";
import { scoreStory } from "./viralScoring";
import { scoreStoryWithLLM, batchScoreStoriesWithLLM, type BatchScoringInput } from "./llmScoring";
import { rssSources } from "../drizzle/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";

export async function scheduledIngestHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[ScheduledIngest] Cron triggered (taskUid: ${user.taskUid}) — fetching RSS feeds...`);

    // Auto-disable AI keyword feeds that have passed their expiry date
    const db = await getDb();
    if (db) {
      const now = new Date();
      const expiredResult = await db
        .update(rssSources)
        .set({ isActive: false })
        .where(
          and(
            eq(rssSources.sourceType, "ai_keyword"),
            isNotNull(rssSources.expiresAt),
            lt(rssSources.expiresAt, now),
          ),
        );
      const expiredCount = (expiredResult as any)?.rowsAffected ?? 0;
      if (expiredCount > 0) {
        console.log(`[ScheduledIngest] Auto-disabled ${expiredCount} expired AI keyword feeds`);
      }
    }

    const sources = await getActiveRssSources();
    const recentTitles = await getRecentStoryTitles(5000);
    let newCount = 0;
    let skippedCount = 0;

    // ── Phase 1: Fetch all feeds and rule-score every item ────────────────────
    // Collect borderline stories (rule score 40–69) for batch LLM scoring.
    // Clear winners (≥70) and clear rejects (<40) skip the LLM entirely.
    type PendingStory = {
      title: string;
      sourceUrl: string;
      sourceName: string;
      content: string;
      publishedAt: Date | null;
      feedThreshold: number;
      ruleScore: ReturnType<typeof scoreStory>;
    };

    const clearWinners: PendingStory[] = [];   // rule score ≥ 70 — save immediately
    const borderlineStories: PendingStory[] = []; // rule score 40–69 — batch LLM score

    for (const source of sources) {
      const feedThreshold = (source.scoreThreshold && source.scoreThreshold > 0)
        ? source.scoreThreshold
        : 40;

      // Double-check expiry
      if (source.sourceType === "ai_keyword" && source.expiresAt && source.expiresAt < new Date()) {
        console.log(`[ScheduledIngest] Skipping expired AI feed: ${source.name}`);
        continue;
      }

      try {
        const items = await fetchRssFeed(source.url, source.name);

        for (const item of items) {
          if (!item.sourceUrl) continue;

          const alreadySeen = await hasSeenUrl(item.sourceUrl);
          if (alreadySeen) { skippedCount++; continue; }

          if (!isAviationRelevant(item.title || "", item.content || "", source.category)) {
            await markUrlAsSeen(item.sourceUrl, "not_aviation");
            skippedCount++;
            continue;
          }

          if (isSimilarTitle(item.title || "", recentTitles)) {
            await markUrlAsSeen(item.sourceUrl, "duplicate_title");
            skippedCount++;
            continue;
          }

          let content = item.content || "";
          if (content.length < 200) {
            try {
              const fetched = await fetchArticleContent(item.sourceUrl);
              content = fetched.content || content;
            } catch { /* use RSS content */ }
          }

          const ruleScore = scoreStory(item.title || "", content);
          const pending: PendingStory = {
            title: item.title || "Untitled",
            sourceUrl: item.sourceUrl,
            sourceName: source.name,
            content,
            publishedAt: item.publishedAt ?? null,
            feedThreshold,
            ruleScore,
          };

          if (ruleScore.score >= 70) {
            // Clear winner — no LLM needed
            clearWinners.push(pending);
          } else if (ruleScore.score >= 40) {
            // Borderline — queue for batch LLM scoring
            borderlineStories.push(pending);
          } else {
            // Clear reject — mark as seen and skip
            await markUrlAsSeen(item.sourceUrl, "score_below_threshold");
            skippedCount++;
          }
        }

        await updateRssSourceLastFetched(source.id);
      } catch (sourceErr) {
        console.error(`[ScheduledIngest] Error fetching source ${source.name}:`, sourceErr);
      }
    }

    // ── Phase 2: Batch LLM score the borderline stories ───────────────────────
    // Send up to 10 stories per LLM call instead of one-at-a-time.
    // This pays the system prompt overhead once per batch, not per story.
    const BATCH_SIZE = 10;
    const llmScoredStories: Array<PendingStory & { finalScore: number; finalLabel: string; finalCategory: string; finalReason: string; finalTriggers: string[]; scoringMethod: "rule_based" | "llm_assisted" }> = [];

    for (let i = 0; i < borderlineStories.length; i += BATCH_SIZE) {
      const batch = borderlineStories.slice(i, i + BATCH_SIZE);
      const batchInputs: BatchScoringInput[] = batch.map(s => ({
        title: s.title,
        content: s.content,
        ruleScore: s.ruleScore,
      }));

      let batchResults;
      try {
        batchResults = await batchScoreStoriesWithLLM(batchInputs);
      } catch {
        // Full batch failure — fall back to rule-based for all in this batch
        batchResults = batch.map(s => ({ ...s.ruleScore, scoringMethod: "rule_based" as const }));
      }

      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const r = batchResults[j] ?? { ...s.ruleScore, scoringMethod: "rule_based" as const };
        llmScoredStories.push({
          ...s,
          finalScore: r.score,
          finalLabel: r.statusLabel,
          finalCategory: r.category,
          finalReason: r.viralReason,
          finalTriggers: r.triggers ?? [],
          scoringMethod: r.scoringMethod,
        });
      }
    }

    console.log(`[ScheduledIngest] Scored: ${clearWinners.length} clear winners, ${borderlineStories.length} borderline (${Math.ceil(borderlineStories.length / BATCH_SIZE)} LLM batch calls)`);

    // ── Phase 3: Persist all stories that meet their feed threshold ───────────
    const allScored = [
      // Clear winners keep their rule-based score
      ...clearWinners.map(s => ({
        ...s,
        finalScore: s.ruleScore.score,
        finalLabel: s.ruleScore.statusLabel,
        finalCategory: s.ruleScore.category,
        finalReason: s.ruleScore.viralReason,
        finalTriggers: s.ruleScore.triggers ?? [],
        scoringMethod: "rule_based" as const,
      })),
      ...llmScoredStories,
    ];

    for (const s of allScored) {
      await markUrlAsSeen(s.sourceUrl, s.finalScore < s.feedThreshold ? "score_below_threshold" : undefined);

      if (s.finalScore < s.feedThreshold) {
        skippedCount++;
        continue;
      }

      const storyId = await createStory({
        title: s.title,
        sourceUrl: s.sourceUrl,
        sourceName: s.sourceName,
        content: s.content,
        publishedAt: s.publishedAt ?? undefined,
        viralScore: s.finalScore,
        statusLabel: s.finalLabel as "reject" | "must_post" | "strong_candidate" | "maybe",
        category: s.finalCategory,
        viralReason: s.finalReason,
        viralTriggers: s.finalTriggers,
        scoringMethod: s.scoringMethod,
        processedAt: new Date(),
      });

      await createStoryPackage({ storyId, processingStatus: "queued" });
      recentTitles.push(s.title);
      newCount++;
    }

    console.log(`[ScheduledIngest] Complete — ${newCount} new stories, ${skippedCount} skipped`);

    return res.json({
      ok: true,
      newCount,
      skippedCount,
      sourcesChecked: sources.length,
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
