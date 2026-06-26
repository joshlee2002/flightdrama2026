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
 *
 * Pipeline phases:
 *   Phase 1a — Parallel RSS fetch (all feeds concurrently, cap 20)
 *   Phase 1b — Bulk URL dedup (2 DB queries for all URLs at once)
 *   Phase 1c — Parallel article content fetch for thin items (cap 8)
 *   Phase 1d — Rule-score every item; split into winners / borderline / rejects
 *   Phase 2  — Batch LLM score borderline stories (10 per call, 8B model + 70B safety net)
 *   Phase 3  — Persist all stories that meet their feed threshold
 */
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import {
  getActiveRssSources,
  getRecentStoryTitles,
  getSeenUrlSet,
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
import { batchScoreStoriesWithLLM, type BatchScoringInput } from "./llmScoring";
import { rssSources } from "../drizzle/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";

/** Max concurrent RSS feed fetches — avoids hammering the network */
const FEED_CONCURRENCY = 20;
/** Max concurrent article content fetches — avoids rate-limiting on article sites */
const ARTICLE_CONCURRENCY = 8;
/** Batch size for LLM scoring */
const LLM_BATCH_SIZE = 10;

/** Run up to `limit` promises concurrently from an array of async tasks */
async function pLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

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

    // ── Phase 1a: Fetch ALL feeds in parallel (capped at FEED_CONCURRENCY) ────
    // Previously sequential — each feed waited for the previous to finish.
    // Now all 95 feeds fire at once (up to 20 at a time), reducing wall-clock
    // time from ~75s to ~3-5s.
    const t0 = Date.now();
    const activeSources = sources.filter(source => {
      if (source.sourceType === "ai_keyword" && source.expiresAt && source.expiresAt < new Date()) {
        console.log(`[ScheduledIngest] Skipping expired AI feed: ${source.name}`);
        return false;
      }
      return true;
    });

    type FeedResult = {
      source: typeof activeSources[0];
      items: Awaited<ReturnType<typeof fetchRssFeed>>;
      feedThreshold: number;
    };

    const feedTasks = activeSources.map(source => async (): Promise<FeedResult> => {
      const feedThreshold = (source.scoreThreshold && source.scoreThreshold > 0)
        ? source.scoreThreshold
        : 40;
      try {
        const items = await fetchRssFeed(source.url, source.name);
        return { source, items, feedThreshold };
      } catch (err) {
        console.error(`[ScheduledIngest] Error fetching source ${source.name}:`, err);
        return { source, items: [], feedThreshold };
      }
    });

    const feedResults = await pLimit(feedTasks, FEED_CONCURRENCY);
    console.log(`[ScheduledIngest] Phase 1a: Fetched ${activeSources.length} feeds in ${Date.now() - t0}ms`);

    // Update lastFetchedAt for all sources in parallel (fire-and-forget)
    Promise.all(feedResults.map(r => updateRssSourceLastFetched(r.source.id))).catch(() => {});

    // ── Phase 1b: Bulk URL dedup — 2 DB queries for ALL URLs at once ──────────
    // Previously: 1 DB query per item (up to ~1,900 queries for 95 feeds × 20 items).
    // Now: collect all candidate URLs first, then check them all in 2 queries.
    const t1 = Date.now();
    const allCandidateUrls = feedResults.flatMap(r =>
      r.items.map(item => item.sourceUrl).filter(Boolean)
    );
    const seenUrlSet = await getSeenUrlSet(allCandidateUrls);
    console.log(`[ScheduledIngest] Phase 1b: Deduped ${allCandidateUrls.length} URLs in ${Date.now() - t1}ms`);

    // ── Phase 1c: Filter items — aviation relevance, title dedup, seen check ──
    type CandidateItem = {
      title: string;
      sourceUrl: string;
      sourceName: string;
      content: string;
      publishedAt: Date | null;
      feedThreshold: number;
      needsContentFetch: boolean;
    };

    const candidates: CandidateItem[] = [];
    const markSeenBatch: Array<{ url: string; reason?: string }> = [];

    for (const { source, items, feedThreshold } of feedResults) {
      for (const item of items) {
        if (!item.sourceUrl) continue;

        if (seenUrlSet.has(item.sourceUrl)) {
          skippedCount++;
          continue;
        }

        if (!isAviationRelevant(item.title || "", item.content || "", source.category)) {
          markSeenBatch.push({ url: item.sourceUrl, reason: "not_aviation" });
          skippedCount++;
          continue;
        }

        if (isSimilarTitle(item.title || "", recentTitles)) {
          markSeenBatch.push({ url: item.sourceUrl, reason: "duplicate_title" });
          skippedCount++;
          continue;
        }

        const content = item.content || "";
        candidates.push({
          title: item.title || "Untitled",
          sourceUrl: item.sourceUrl,
          sourceName: source.name,
          content,
          publishedAt: item.publishedAt ?? null,
          feedThreshold,
          needsContentFetch: content.length < 200,
        });
      }
    }

    // Fire-and-forget batch markUrlAsSeen for filtered items
    Promise.all(markSeenBatch.map(({ url, reason }) => markUrlAsSeen(url, reason))).catch(() => {});

    // ── Phase 1c: Parallel article content fetch for thin items ───────────────
    // Items with < 200 chars of RSS content need a full article fetch.
    // Previously sequential within each feed loop; now all fire in parallel
    // (capped at ARTICLE_CONCURRENCY to avoid rate-limiting article sites).
    const t2 = Date.now();
    const thinItems = candidates.filter(c => c.needsContentFetch);
    if (thinItems.length > 0) {
      const fetchTasks = thinItems.map(item => async () => {
        try {
          const fetched = await fetchArticleContent(item.sourceUrl);
          if (fetched.content && fetched.content.length > item.content.length) {
            item.content = fetched.content;
          }
        } catch { /* keep RSS content */ }
      });
      await pLimit(fetchTasks, ARTICLE_CONCURRENCY);
    }
    console.log(`[ScheduledIngest] Phase 1c: Fetched content for ${thinItems.length} thin items in ${Date.now() - t2}ms`);

    // ── Phase 1d: Rule-score every candidate; split into winners / borderline ──
    type PendingStory = CandidateItem & { ruleScore: ReturnType<typeof scoreStory> };

    const clearWinners: PendingStory[] = [];
    const borderlineStories: PendingStory[] = [];

    for (const item of candidates) {
      const ruleScore = scoreStory(item.title, item.content);
      const pending: PendingStory = { ...item, ruleScore };

      if (ruleScore.score >= 70) {
        clearWinners.push(pending);
      } else if (ruleScore.score >= 40) {
        borderlineStories.push(pending);
      } else {
        markUrlAsSeen(item.sourceUrl, "score_below_threshold").catch(() => {});
        skippedCount++;
      }
    }

    // ── Phase 2: Batch LLM score the borderline stories ───────────────────────
    // 10 stories per LLM call. 8B model with 70B safety net for high scorers.
    const llmScoredStories: Array<PendingStory & {
      finalScore: number;
      finalLabel: string;
      finalCategory: string;
      finalReason: string;
      finalTriggers: string[];
      scoringMethod: "rule_based" | "llm_assisted";
    }> = [];

    for (let i = 0; i < borderlineStories.length; i += LLM_BATCH_SIZE) {
      const batch = borderlineStories.slice(i, i + LLM_BATCH_SIZE);
      const batchInputs: BatchScoringInput[] = batch.map(s => ({
        title: s.title,
        content: s.content,
        ruleScore: s.ruleScore,
      }));

      let batchResults;
      try {
        batchResults = await batchScoreStoriesWithLLM(batchInputs);
      } catch {
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

    console.log(`[ScheduledIngest] Phase 2: Scored ${clearWinners.length} winners + ${borderlineStories.length} borderline (${Math.ceil(borderlineStories.length / LLM_BATCH_SIZE)} LLM batches)`);

    // ── Phase 3: Persist all stories that meet their feed threshold ───────────
    const allScored = [
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

    const totalMs = Date.now() - t0;
    console.log(`[ScheduledIngest] Complete — ${newCount} new stories, ${skippedCount} skipped, ${totalMs}ms total`);

    return res.json({
      ok: true,
      newCount,
      skippedCount,
      sourcesChecked: activeSources.length,
      durationMs: totalMs,
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
