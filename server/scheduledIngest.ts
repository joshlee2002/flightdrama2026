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
import { scoreStoryWithLLM } from "./llmScoring";
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

    for (const source of sources) {
      // Per-feed score threshold — AI keyword feeds have higher bars
      // Default to 40 for standard feeds (scoreThreshold=0 means use default)
      const feedThreshold = (source.scoreThreshold && source.scoreThreshold > 0)
        ? source.scoreThreshold
        : 40;

      // Double-check expiry (in case the batch disable above missed any)
      if (source.sourceType === "ai_keyword" && source.expiresAt && source.expiresAt < new Date()) {
        console.log(`[ScheduledIngest] Skipping expired AI feed: ${source.name}`);
        continue;
      }

      try {
        const items = await fetchRssFeed(source.url, source.name);

        for (const item of items) {
          if (!item.sourceUrl) continue;

          // Dedup check
          const alreadySeen = await hasSeenUrl(item.sourceUrl);
          if (alreadySeen) {
            skippedCount++;
            continue;
          }

          // Aviation relevance gate
          if (!isAviationRelevant(item.title || "", item.content || "", source.category)) {
            await markUrlAsSeen(item.sourceUrl, "not_aviation");
            skippedCount++;
            continue;
          }

          // Title dedup
          if (isSimilarTitle(item.title || "", recentTitles)) {
            await markUrlAsSeen(item.sourceUrl, "duplicate_title");
            skippedCount++;
            continue;
          }

          // Fetch full article content if too short
          let content = item.content || "";
          if (content.length < 200) {
            try {
              const fetched = await fetchArticleContent(item.sourceUrl);
              content = fetched.content || content;
            } catch {
              // Use RSS content as fallback
            }
          }

          // Score the story
          const ruleScore = scoreStory(item.title || "", content);

          // LLM scoring for borderline stories
          let finalScore = ruleScore.score;
          let finalLabel = ruleScore.statusLabel;
          let finalCategory = ruleScore.category;
          let finalReason = ruleScore.viralReason;
          let finalTriggers = ruleScore.triggers;
          let scoringMethod: "rule_based" | "llm_assisted" = "rule_based";

          if (ruleScore.score >= 40 && ruleScore.score < 70) {
            try {
              const llmResult = await scoreStoryWithLLM(item.title || "", content);
              if (llmResult.score !== undefined) {
                finalScore = llmResult.score;
                finalLabel = llmResult.statusLabel;
                finalCategory = llmResult.category;
                finalReason = llmResult.viralReason;
                finalTriggers = llmResult.triggers;
                scoringMethod = "llm_assisted";
              }
            } catch {
              // Fall back to rule-based score
            }
          }

          // Mark as seen BEFORE the score gate — so low-scoring stories are
          // never re-evaluated on the next fetch
          await markUrlAsSeen(item.sourceUrl, finalScore < feedThreshold ? "score_below_threshold" : undefined);

          if (finalScore < feedThreshold) {
            skippedCount++;
            continue;
          }

          // Create the story — use source.name (not item.sourceName) so AI keyword
          // feeds can be matched back to their rss_sources row for performance tracking
          const storyId = await createStory({
            title: item.title || "Untitled",
            sourceUrl: item.sourceUrl,
            sourceName: source.name,
            content,
            publishedAt: item.publishedAt,
            viralScore: finalScore,
            statusLabel: finalLabel,
            category: finalCategory,
            viralReason: finalReason,
            viralTriggers: finalTriggers,
            scoringMethod,
            processedAt: new Date(),
          });

          await createStoryPackage({
            storyId,
            processingStatus: "queued",
          });
          recentTitles.push(item.title || "");
          newCount++;
        }

        await updateRssSourceLastFetched(source.id);
      } catch (sourceErr) {
        console.error(`[ScheduledIngest] Error fetching source ${source.name}:`, sourceErr);
      }
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
