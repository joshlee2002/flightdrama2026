/**
 * Canonical RSS ingest pipeline — shared by both the cron handler and the
 * manual "Refresh Feeds" UI button.
 *
 * Previously the UI button had its own inline ingest loop in routers.ts that
 * was missing the event-fingerprint and content-hash dedup layers. This module
 * extracts the core pipeline logic so both paths use identical dedup.
 *
 * Called by:
 *   - scheduledIngest.ts  (POST /api/scheduled/ingest — cron job)
 *   - routers.ts          (stories.refreshFeeds tRPC mutation — UI button)
 */

import {
  getActiveRssSources,
  getRecentStoryTitles,
  getSeenUrlSet,
  markUrlAsSeen,
  createStory,
  updateRssSourceLastFetched,
  createStoryPackage,
  getDb,
  getRecentDuplicatePairs,
  getStoryByEventFingerprint,
  getStoryByContentHash,
  batchInsertIngestLog,
  pruneIngestLog,
} from "./db";
import {
  fetchRssFeed,
  fetchArticleContent,
  isSimilarTitle,
  getLocationIncidentMatches,
  llmDedupCheck,
  isAviationRelevant,
} from "./ingestion";
import { buildEventFingerprint, buildContentHash } from "./eventFingerprint";
import { invokeLLM as _invokeLLM } from "./_core/llm";
// Cast to the narrower signature expected by llmDedupCheck
const invokeLLM = _invokeLLM as unknown as (params: {
  model?: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens?: number;
}) => Promise<{ choices: Array<{ message: { content: string } }> }>;
import { scoreStory } from "./viralScoring";
import { batchScoreStoriesWithLLM, type BatchScoringInput } from "./llmScoring";
import { rssSources } from "../drizzle/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { randomUUID } from "crypto";

const FEED_CONCURRENCY = 20;
const ARTICLE_CONCURRENCY = 8;
const LLM_BATCH_SIZE = 10;

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

export interface IngestResult {
  newCount: number;
  skippedCount: number;
  sourcesChecked: number;
  durationMs: number;
  runId: string;
}

/**
 * Run the full RSS ingest pipeline with all dedup layers.
 * Returns a summary of what was ingested.
 */
export async function runIngestPipeline(label = "Ingest"): Promise<IngestResult> {
  const t0 = Date.now();
  const runId = randomUUID();

  // Prune old log entries (keep 7 days) — fire-and-forget
  pruneIngestLog(7).catch(() => {});

  // Auto-disable expired AI keyword feeds
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
      console.log(`[${label}] Auto-disabled ${expiredCount} expired AI keyword feeds`);
    }
  }

  const sources = await getActiveRssSources();
  const [recentTitles, learnedDuplicatePairs] = await Promise.all([
    getRecentStoryTitles(5000),
    getRecentDuplicatePairs(10),
  ]);
  let newCount = 0;
  let skippedCount = 0;

  // Accumulate all log entries and flush at the end of the run
  type LogEntry = Parameters<typeof batchInsertIngestLog>[0][number];
  const logEntries: LogEntry[] = [];

  function logDrop(opts: {
    title: string;
    sourceUrl: string;
    sourceName: string;
    dropReason: LogEntry["dropReason"];
    dropDetail?: string;
    ruleScore?: number;
    llmScore?: number;
    feedThreshold?: number;
    category?: string;
    publishedAt?: Date | null;
  }) {
    logEntries.push({
      ingestRunId: runId,
      title: opts.title.slice(0, 500),
      sourceUrl: opts.sourceUrl.slice(0, 768),
      sourceName: opts.sourceName.slice(0, 255),
      dropReason: opts.dropReason,
      dropDetail: opts.dropDetail?.slice(0, 500) ?? null,
      ruleScore: opts.ruleScore ?? null,
      llmScore: opts.llmScore ?? null,
      feedThreshold: opts.feedThreshold ?? null,
      category: opts.category?.slice(0, 64) ?? null,
      publishedAt: opts.publishedAt ?? null,
    });
  }

  // ── Phase 1a: Fetch ALL feeds in parallel ────────────────────────────────
  const activeSources = sources.filter(source => {
    if (source.sourceType === "ai_keyword" && source.expiresAt && source.expiresAt < new Date()) {
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
      console.error(`[${label}] Error fetching source ${source.name}:`, err);
      return { source, items: [], feedThreshold };
    }
  });

  const feedResults = await pLimit(feedTasks, FEED_CONCURRENCY);
  console.log(`[${label}] Phase 1a: Fetched ${activeSources.length} feeds in ${Date.now() - t0}ms`);

  Promise.all(feedResults.map(r => updateRssSourceLastFetched(r.source.id))).catch(() => {});

  // ── Phase 1b: Bulk URL dedup ─────────────────────────────────────────────
  const allCandidateUrls = feedResults.flatMap(r =>
    r.items.map(item => item.sourceUrl).filter(Boolean)
  );
  const seenUrlSet = await getSeenUrlSet(allCandidateUrls);

  // ── Phase 1c: Build candidate list (URL + aviation gate) ─────────────────
  type CandidateItem = {
    title: string;
    sourceUrl: string;
    sourceName: string;
    sourceCategory: string;
    content: string;
    publishedAt: Date | null;
    feedThreshold: number;
    needsContentFetch: boolean;
    eventFingerprint: string | null;
    contentHash: string;
  };

  const candidates: CandidateItem[] = [];
  const markSeenBatch: Array<{ url: string; reason: string }> = [];

  for (const { source, items, feedThreshold } of feedResults) {
    for (const item of items) {
      if (!item.sourceUrl) continue;

      if (seenUrlSet.has(item.sourceUrl)) {
        // already_seen: URL was processed in a previous ingest run — skip silently (no log entry,
        // this would generate thousands of rows for normal dedup)
        skippedCount++;
        continue;
      }

      if (!isAviationRelevant(item.title || "", item.content || "", source.category)) {
        logDrop({
          title: item.title || "Untitled",
          sourceUrl: item.sourceUrl,
          sourceName: source.name,
          dropReason: "not_aviation",
          dropDetail: `Category: ${source.category}. Title: "${(item.title || "").slice(0, 120)}"`,
          publishedAt: item.publishedAt ?? null,
        });
        markSeenBatch.push({ url: item.sourceUrl, reason: "not_aviation" });
        skippedCount++;
        continue;
      }

      const title = item.title || "Untitled";
      const content = item.content || "";
      candidates.push({
        title,
        sourceUrl: item.sourceUrl,
        sourceName: source.name,
        sourceCategory: source.category,
        content,
        publishedAt: item.publishedAt ?? null,
        feedThreshold,
        needsContentFetch: content.length < 200,
        eventFingerprint: buildEventFingerprint(title, content, item.publishedAt ?? null),
        contentHash: buildContentHash(title, content),
      });
    }
  }

  Promise.all(markSeenBatch.map(({ url, reason }) => markUrlAsSeen(url, reason))).catch(() => {});

  // ── Phase 1d: Content-hash + event-fingerprint dedup (DB lookups) ─────────
  const structuralDupUrls: string[] = [];
  const afterStructural: CandidateItem[] = [];

  for (const item of candidates) {
    const hashMatch = await getStoryByContentHash(item.contentHash);
    if (hashMatch) {
      console.log(`[${label}] Content-hash dup: "${item.title.slice(0, 70)}" → "${hashMatch.title.slice(0, 70)}"`);
      logDrop({
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        dropReason: "duplicate_content",
        dropDetail: `Content hash matched: "${hashMatch.title.slice(0, 120)}"`,
        publishedAt: item.publishedAt,
      });
      structuralDupUrls.push(item.sourceUrl);
      skippedCount++;
      continue;
    }

    if (item.eventFingerprint) {
      const fpMatch = await getStoryByEventFingerprint(item.eventFingerprint);
      if (fpMatch) {
        console.log(`[${label}] Event-fingerprint dup [${item.eventFingerprint}]: "${item.title.slice(0, 70)}" → "${fpMatch.title.slice(0, 70)}"`);
        logDrop({
          title: item.title,
          sourceUrl: item.sourceUrl,
          sourceName: item.sourceName,
          dropReason: "duplicate_content",
          dropDetail: `Event fingerprint [${item.eventFingerprint}] matched: "${fpMatch.title.slice(0, 120)}"`,
          publishedAt: item.publishedAt,
        });
        structuralDupUrls.push(item.sourceUrl);
        skippedCount++;
        continue;
      }
    }

    afterStructural.push(item);
  }

  if (structuralDupUrls.length > 0) {
    console.log(`[${label}] Phase 1d: Structural dedup removed ${structuralDupUrls.length} duplicate(s)`);
    Promise.all(structuralDupUrls.map(url => markUrlAsSeen(url, "duplicate_event"))).catch(() => {});
  }

  // ── Phase 1e: Title-similarity + LLM dedup ────────────────────────────────
  const titleDupUrls: string[] = [];
  const afterTitle: CandidateItem[] = [];

  for (const item of afterStructural) {
    if (isSimilarTitle(item.title, recentTitles, learnedDuplicatePairs)) {
      logDrop({
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        dropReason: "duplicate_title",
        dropDetail: "Title-similarity fuzzy match against recent stories",
        publishedAt: item.publishedAt,
      });
      titleDupUrls.push(item.sourceUrl);
      skippedCount++;
      continue;
    }

    const locationMatches = getLocationIncidentMatches(item.title, recentTitles);
    if (locationMatches.length > 0) {
      const isDup = await llmDedupCheck(item.title, locationMatches, invokeLLM, learnedDuplicatePairs);
      if (isDup) {
        logDrop({
          title: item.title,
          sourceUrl: item.sourceUrl,
          sourceName: item.sourceName,
          dropReason: "duplicate_title",
          dropDetail: `LLM dedup: matched location/incident pattern. Similar to: "${locationMatches[0]?.slice(0, 120)}"`,
          publishedAt: item.publishedAt,
        });
        titleDupUrls.push(item.sourceUrl);
        skippedCount++;
        continue;
      }
    }

    afterTitle.push(item);
  }

  if (titleDupUrls.length > 0) {
    Promise.all(titleDupUrls.map(url => markUrlAsSeen(url, "duplicate_title"))).catch(() => {});
  }

  // ── Phase 1f: Within-batch dedup ─────────────────────────────────────────
  const batchSeenTitles: string[] = [];
  const batchSeenFingerprints = new Set<string>();
  const batchSeenHashes = new Set<string>();
  const dedupedCandidates: CandidateItem[] = [];
  const batchDupUrls: string[] = [];

  for (const item of afterTitle) {
    if (batchSeenHashes.has(item.contentHash)) {
      logDrop({
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        dropReason: "duplicate_batch",
        dropDetail: "Content hash duplicate within this ingest batch",
        publishedAt: item.publishedAt,
      });
      batchDupUrls.push(item.sourceUrl); skippedCount++; continue;
    }
    if (item.eventFingerprint && batchSeenFingerprints.has(item.eventFingerprint)) {
      logDrop({
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        dropReason: "duplicate_batch",
        dropDetail: `Event fingerprint duplicate within this ingest batch: [${item.eventFingerprint}]`,
        publishedAt: item.publishedAt,
      });
      batchDupUrls.push(item.sourceUrl); skippedCount++; continue;
    }
    if (batchSeenTitles.length > 0 && isSimilarTitle(item.title, batchSeenTitles, learnedDuplicatePairs)) {
      logDrop({
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        dropReason: "duplicate_batch",
        dropDetail: "Title-similarity duplicate within this ingest batch",
        publishedAt: item.publishedAt,
      });
      batchDupUrls.push(item.sourceUrl); skippedCount++; continue;
    }
    if (batchSeenTitles.length > 0) {
      const batchLocMatches = getLocationIncidentMatches(item.title, batchSeenTitles);
      if (batchLocMatches.length > 0) {
        const isDup = await llmDedupCheck(item.title, batchLocMatches, invokeLLM, learnedDuplicatePairs);
        if (isDup) {
          logDrop({
            title: item.title,
            sourceUrl: item.sourceUrl,
            sourceName: item.sourceName,
            dropReason: "duplicate_batch",
            dropDetail: `LLM dedup: batch location/incident match. Similar to: "${batchLocMatches[0]?.slice(0, 120)}"`,
            publishedAt: item.publishedAt,
          });
          batchDupUrls.push(item.sourceUrl); skippedCount++; continue;
        }
      }
    }
    batchSeenTitles.push(item.title);
    batchSeenHashes.add(item.contentHash);
    if (item.eventFingerprint) batchSeenFingerprints.add(item.eventFingerprint);
    dedupedCandidates.push(item);
  }

  if (batchDupUrls.length > 0) {
    console.log(`[${label}] Phase 1f: Within-batch dedup removed ${batchDupUrls.length} duplicate(s)`);
    Promise.all(batchDupUrls.map(url => markUrlAsSeen(url, "duplicate_event"))).catch(() => {});
  }

  // ── Phase 1g: Fetch thin article content ─────────────────────────────────
  const thinItems = dedupedCandidates.filter(c => c.needsContentFetch);
  if (thinItems.length > 0) {
    const fetchTasks = thinItems.map(item => async () => {
      try {
        const fetched = await fetchArticleContent(item.sourceUrl);
        if (fetched.content && fetched.content.length > item.content.length) {
          item.content = fetched.content;
          item.eventFingerprint = buildEventFingerprint(item.title, item.content, item.publishedAt);
          item.contentHash = buildContentHash(item.title, item.content);
        }
      } catch { /* keep RSS content */ }
    });
    await pLimit(fetchTasks, ARTICLE_CONCURRENCY);
  }

  // ── Phase 1h: Rule-score (pre-filter only — no stat adjustment applied) ────
  // The rule score is used only as a cheap pre-filter to drop obvious rejects
  // (score < 30) before spending LLM credits. Threshold is intentionally LOW —
  // the rule engine starts at a baseline of 20 and many legitimate stories only
  // pick up 10-20 points on rules but score 70+ after the LLM sees full context.
  // The final feedThreshold gate (default 40) handles what actually appears on
  // the dashboard. The LLM apprentice scoring in Phase 2 is the authoritative score.
  type PendingStory = CandidateItem & { ruleScore: ReturnType<typeof scoreStory> };
  const llmCandidates: PendingStory[] = [];

  for (const item of dedupedCandidates) {
    const ruleScore = scoreStory(item.title, item.content);
    // Aviation-native and regulator sources bypass the rule pre-filter entirely.
    // These are dedicated aviation publications — every story from them is worth
    // showing to the editor, even if it has no viral triggers (e.g. opinion
    // pieces, analysis, editorial takes). The LLM apprentice is the judge.
    const bypassRuleGate = item.sourceCategory === "aviation" || item.sourceCategory === "regulator";
    if (bypassRuleGate || ruleScore.score >= 30) {
      llmCandidates.push({ ...item, ruleScore });
    } else {
      logDrop({
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        dropReason: "score_below_rule",
        dropDetail: `Rule score ${ruleScore.score} < 30 threshold. Category: ${ruleScore.category}. (source category: ${item.sourceCategory})`,
        ruleScore: ruleScore.score,
        feedThreshold: item.feedThreshold,
        category: ruleScore.category,
        publishedAt: item.publishedAt,
      });
      markUrlAsSeen(item.sourceUrl, "score_below_threshold").catch(() => {});
      skippedCount++;
    }
  }

  // Sort by category so each batch of 10 is as category-homogeneous as possible.
  llmCandidates.sort((a, b) => (a.ruleScore.category ?? "").localeCompare(b.ruleScore.category ?? ""));

  // ── Phase 2: Batch LLM scoring ────────────────────────────────────────────
  const llmScoredStories: Array<PendingStory & {
    finalScore: number;
    finalLabel: string;
    finalCategory: string;
    finalReason: string;
    finalTriggers: string[];
    scoringMethod: "rule_based" | "llm_assisted";
    finalRuleScore?: number;
    apprenticeConfidence?: string;
    apprenticeReasoning?: string;
    similarExamplesUsed?: string[];
  }> = [];

  for (let i = 0; i < llmCandidates.length; i += LLM_BATCH_SIZE) {
    const batch = llmCandidates.slice(i, i + LLM_BATCH_SIZE);
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
        finalRuleScore: (r as any).ruleScore,
        apprenticeConfidence: (r as any).apprenticeConfidence,
        apprenticeReasoning: (r as any).apprenticeReasoning,
        similarExamplesUsed: (r as any).similarExamplesUsed,
      });
    }
  }

  console.log(`[${label}] Phase 2: LLM-scored ${llmCandidates.length} candidates`);

  // ── Phase 3: Persist stories ──────────────────────────────────────────────
  for (const s of llmScoredStories) {
    await markUrlAsSeen(s.sourceUrl, s.finalScore < s.feedThreshold ? "score_below_threshold" : undefined);

    if (s.finalScore < s.feedThreshold) {
      logDrop({
        title: s.title,
        sourceUrl: s.sourceUrl,
        sourceName: s.sourceName,
        dropReason: "score_below_feed",
        dropDetail: `LLM score ${s.finalScore} < feed threshold ${s.feedThreshold}. Category: ${s.finalCategory}. Reason: ${s.finalReason?.slice(0, 200)}`,
        ruleScore: s.finalRuleScore,
        llmScore: s.finalScore,
        feedThreshold: s.feedThreshold,
        category: s.finalCategory,
        publishedAt: s.publishedAt,
      });
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
      eventFingerprint: s.eventFingerprint ?? undefined,
      contentHash: s.contentHash,
      ruleScore: s.finalRuleScore,
      apprenticeConfidence: s.apprenticeConfidence,
      apprenticeReasoning: s.apprenticeReasoning,
      similarExamplesUsed: s.similarExamplesUsed ?? undefined,
    });

    // Log successful ingestion
    logDrop({
      title: s.title,
      sourceUrl: s.sourceUrl,
      sourceName: s.sourceName,
      dropReason: "ingested",
      dropDetail: `Score: ${s.finalScore}. Label: ${s.finalLabel}. Category: ${s.finalCategory}`,
      ruleScore: s.finalRuleScore,
      llmScore: s.finalScore,
      feedThreshold: s.feedThreshold,
      category: s.finalCategory,
      publishedAt: s.publishedAt,
    });

    await createStoryPackage({ storyId, processingStatus: "queued" });
    recentTitles.push(s.title);
    newCount++;
  }

  const durationMs = Date.now() - t0;
  console.log(`[${label}] Complete — ${newCount} new stories, ${skippedCount} skipped, ${durationMs}ms (runId: ${runId})`);

  // Flush all log entries to DB — fire-and-forget so it doesn't block the response
  batchInsertIngestLog(logEntries).catch(err =>
    console.warn(`[${label}] IngestLog flush failed:`, err instanceof Error ? err.message : err)
  );

  return { newCount, skippedCount, sourcesChecked: activeSources.length, durationMs, runId };
}
