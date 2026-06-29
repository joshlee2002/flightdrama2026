import { COOKIE_NAME, labelFromScore } from "@shared/const";
import { createPasswordSessionToken } from "./_core/passwordAuth";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  createHistoricalPost,
  createStory,
  createStoryPackage,
  getActiveRssSources,
  getAllScoringConfig,
  getHistoricalPosts,
  getOverrideExamplesFromDb,
  getRssSources,
  getRecentStoryTitles,
  getStoriesWithPackages,
  getStoryById,
  hasSeenUrl,
  markUrlAsSeen,
  storyUrlExists,
  toggleRssSource,
  updatePackageArticle,
  updateRssSourceLastFetched,
  updateStoryApproval,
  updateStoryPackage,
  getPackageByStoryId,
  updateStoryScores,
  updateStoryOverride,
  updateStoryTriggers,
  countRssSources,
  upsertRssSource,
  setScoringConfig,
  getScoringConfig,
  getDb,
  getLastIngestTime,
  getExampleArticles,
  addExampleArticle,
  deleteExampleArticle,
  getCostControlConfig,
  setCostControlConfig,
  getPendingStoriesByCategory,
  recordDuplicatePair,
  getRecentDuplicatePairs,
  getConfirmedDuplicatePairs,
  getDuplicateCandidates,
  recordConfirmedDuplicatePair,
  atomicIncrementScoringCounter,
  getIngestLog,
  getIngestLogSummary,
} from "./db";
import { eq, sql } from "drizzle-orm";
import { stories } from "../drizzle/schema";
import { fetchArticleContent, fetchRssFeed, isSimilarTitle, getLocationIncidentMatches, llmDedupCheck, isAviationRelevant, DEFAULT_RSS_SOURCES } from "./ingestion";
import { invokeLLM } from "./_core/llm";
import { scoreStory, clearStatAdjustCache } from "./viralScoring";
import { scoreStoryWithLLM, batchScoreStoriesWithLLM, learnFromOverrides, learnFromOverridesStatistical, type BatchScoringInput } from "./llmScoring";
import { runFullSoyunciPipeline, rewriteArticleOnly, runResearchAndWrite, extractResearchPackage, clearDeepResearchCache } from "./soyunci";
import { analysePerformance, getPerformanceInsights, analysePerformanceStatistical, getStatPerformanceInsights, analyseArticleStyle, getArticleStyleInsights, calculatePerformanceScore } from "./performanceAnalysis";
import { syncInstagramPosts, verifyInstagramToken } from "./instagramSync";
import { generateWeeklyDigest, getRecentDigests } from "./weeklyDigest";
import { searchImages, buildImageQueries, generateTextImageRec, searchWikimedia, searchPexels, smartImageSearch } from "./imageSearch";
import { storagePut } from "./storage";
import { regenerateKeywordFeeds, recordRatingForFeed } from "./keywordGenerator";
import { chatWithAssistant, type AssistantMessage } from "./assistant";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
    login: publicProcedure
      .input(z.object({ password: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const appPassword = process.env.APP_PASSWORD || "Eviegrace3!";
        if (input.password !== appPassword) {
          const { TRPCError } = await import("@trpc/server");
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid password" });
        }
        const { ONE_YEAR_MS } = await import("@shared/const");
        const token = await createPasswordSessionToken();
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        // Also return token so client can store in localStorage as fallback
        // when cookies are blocked by browser (SameSite=None restrictions)
        return { success: true, token } as const;
      }),
  }),

  // ── RSS Sources ────────────────────────────────────────────────────────
  rssSources: router({
    list: publicProcedure.query(async () => {
      return getRssSources();
    }),

    toggle: protectedProcedure
      .input(z.object({ id: z.number(), isActive: z.boolean() }))
      .mutation(async ({ input }) => {
        await toggleRssSource(input.id, input.isActive);
        return { success: true };
      }),

    // Force re-seed all sources with correct URLs
    reseed: protectedProcedure.mutation(async () => {
      for (const source of DEFAULT_RSS_SOURCES) {
        await upsertRssSource({
          name: source.name,
          url: source.url,
          category: source.category,
          isActive: true,
        });
      }
      return { seeded: DEFAULT_RSS_SOURCES.length };
    }),

    /**
     * Update the score gate threshold for a single RSS source.
     * Stories scoring below this threshold are silently dropped at ingestion.
     * Default is 40. Set to 0 to let all stories through.
     */
    updateThreshold: protectedProcedure
      .input(z.object({ id: z.number(), scoreThreshold: z.number().min(0).max(100) }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const { rssSources: rssSourcesTable } = await import("../drizzle/schema");
        await db.update(rssSourcesTable).set({ scoreThreshold: input.scoreThreshold }).where(eq(rssSourcesTable.id, input.id));
        return { success: true };
      }),

    /**
     * Regenerate AI keyword feeds based on rated story patterns.
     * Analyses amazing/good-rated articles and generates targeted Google News
     * RSS search URLs, organised into Core/Explore/Test tiers.
     */
    regenerateKeywordFeeds: protectedProcedure.mutation(async () => {
      return regenerateKeywordFeeds();
    }),
  }),

  // ── Stories ────────────────────────────────────────────────────────────
  stories: router({
    list: publicProcedure
      .input(
        z.object({
          statusLabel: z.string().optional(),
          approvalStatus: z.string().optional(),
          minScore: z.number().optional(),
          limit: z.number().optional(),
          completedOnly: z.boolean().optional(),
          sortBy: z.enum(["newest", "top_scored"]).optional(),
        }).optional()
      )
      .query(async ({ input }) => {
        return getStoriesWithPackages(input || {});
      }),

    lastIngestTime: publicProcedure.query(async () => {
      return getLastIngestTime();
    }),

    pendingCount: publicProcedure.query(async () => {
      const db = await getDb();
      if (!db) return 0;
      const result = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(stories)
        .where(eq(stories.approvalStatus, "pending"));
      return Number(result[0]?.count ?? 0);
    }),

    approve: protectedProcedure
      .input(z.object({
        id: z.number(),
        // Optional: which headline variant the editor chose to post
        usedHeadlineVariant: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await updateStoryApproval(input.id, "approved");
        // Snapshot the existing package headlines BEFORE re-running the pipeline,
        // so the chosen variant maps to the headline the editor actually saw.
        const existingPkg = await getPackageByStoryId(input.id);
        const snapshotHeadlines: string[] = Array.isArray(existingPkg?.allHeadlines)
          ? (existingPkg.allHeadlines as string[])
          : [];
        const snapshotSelected: string | null = existingPkg?.selectedHeadline ?? null;
        // ── Research package: skip if already complete (scheduled pipeline may have pre-processed it) ──
        // This prevents double-billing: if the story was pre-processed automatically,
        // we reuse that data instead of running extractResearchPackage again (1× 70B call saved).
        // A package is only truly complete if it has research data (storySummary).
        // Packages that were previously marked "complete" from the old pipeline (which only
        // wrote article/headlines but no research fields) must be re-processed so quotes,
        // facts, timeline, and other research content are actually populated.
        const alreadyComplete =
          existingPkg?.processingStatus === "complete" &&
          existingPkg?.viralAngle &&
          existingPkg?.storySummary;
        if (alreadyComplete) {
          // Research is already done — just record the historical post and return.
          // Mark as complete (no-op for status, but clears any stale error)
          await updateStoryPackage(input.id, { processingStatus: "complete", processingError: null });
          setImmediate(async () => {
            try {
              const story = await getStoryById(input.id);
              if (!story) return;
              await createHistoricalPost({
                headline: story.title,
                category: story.category ?? null,
                viralAngle: existingPkg.viralAngle ?? null,
                storyId: input.id,
                sourceType: "approved_story",
                usedHeadlineVariant: input.usedHeadlineVariant ?? "selected",
              });
            } catch { /* non-critical */ }
          });
          console.log(`[Research] Reusing existing complete package for story ${input.id} — skipping re-extraction`);
          return { success: true };
        }
        // Mark as processing immediately so the UI shows the spinner
        await updateStoryPackage(input.id, { processingStatus: "processing", processingError: null });
        // Fire-and-forget: run research package extraction in background after approval
        setImmediate(async () => {
          const storyId = input.id;
          // Hard 120-second timeout — pipeline must complete or we save partial data
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Research pipeline timeout after 120s")), 120000)
          );
          try {
            const story = await getStoryById(storyId);
            if (!story) return;
            // Start image research in parallel but don't let it block the research package
            const { researchImages } = await import("./soyunci");
            const imagesPromise = researchImages(story.title, "", story.viralReason ?? "").catch(() => ({ recs: [], candidates: {} }));
            // Race the research pipeline against the timeout
            const rp = await Promise.race([
              extractResearchPackage(
                story.title,
                story.content ?? "",
                story.sourceUrl ?? "",
                story.viralReason ?? "",
                story.category ?? "Aviation"
              ),
              timeoutPromise,
            ]);
            // Get images (may already be done, or wait a bit longer)
            const imagesResult = await Promise.race([
              imagesPromise,
              new Promise<{ recs: any[]; candidates: Record<string, any[]> }>((resolve) =>
                setTimeout(() => resolve({ recs: [], candidates: {} }), 15000)
              ),
            ]);
            const { recs: imageRecommendations, candidates: imageCandidates } = imagesResult;
            await updateStoryPackage(storyId, {
              processingStatus: "complete",
              viralAngle: rp.viralAngle,
              extractedFacts: JSON.stringify(rp.extractedInfo),
              sourcesResearched: rp.sourcesResearched,
              sourceConfirmation: rp.sourceConfirmation,
              storySummary: rp.storySummary,
              researchExtracted: rp.extractedInfo,
              researchTimeline: rp.timeline,
              researchQuotes: rp.quotes,
              researchSources: rp.sources,
              researchContradictions: rp.contradictions,
              researchMissingInfo: rp.missingInfo,
              researchAdditionalContext: rp.additionalContext,
              researchEditorialHooks: rp.editorialHooks,
              researchStoryQuality: rp.storyQuality,
              researchFlightNumber: rp.flightNumber || null,
              researchRoute: rp.route || null,
              researchAircraftType: rp.aircraftTypeDetail || null,
              researchPassengerCount: rp.passengerCount || null,
              researchCrewCount: rp.crewCount || null,
              researchEventDate: rp.eventDate || null,
              researchPublicationDate: rp.publicationDate || null,
              researchKeyEntities: rp.keyEntities || null,
              imageRecommendations,
              imageCandidates,
            });
            try {
              await createHistoricalPost({
                headline: story.title,
                category: story.category ?? null,
                viralAngle: rp.viralAngle ?? null,
                storyId,
                sourceType: "approved_story",
                usedHeadlineVariant: input.usedHeadlineVariant ?? "selected",
              });
            } catch { /* non-critical */ }
            console.log(`[Research] Package extraction complete for story ${storyId}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Research] Extraction failed/timed out for story ${storyId}:`, msg);
            // Mark as failed so the UI shows an error state and the Re-Research button
            // remains visible. Do NOT mark as "complete" — that would bypass re-processing
            // on the next approval and leave the card permanently empty.
            await updateStoryPackage(storyId, {
              processingStatus: "failed",
              processingError: msg.includes("timeout")
                ? "Research timed out (sources took too long to load). Click Re-Research to retry."
                : `Research failed: ${msg}. Click Re-Research to retry.`,
            }).catch(() => {});
          }
        });
        return { success: true };
      }),
    regenerateImages: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.id);
        if (!story) throw new Error("Story not found");

        // Read existing package for article + viral angle context
        const existingPkg = await getPackageByStoryId(input.id);

        const article = existingPkg?.soyunciArticle ?? story.content ?? "";
        const viralAngle = existingPkg?.viralAngle ?? story.viralReason ?? "";

        const { aircraftQuery, contextQuery } = await buildImageQueries(
          story.title, article, viralAngle
        );

        const [aircraftImages, contextImages] = await Promise.all([
          searchImages(aircraftQuery, 8, true),
          searchImages(contextQuery, 8, false),
        ]);

        type ImageRec = {
          description: string; source: string; licence: string;
          attributionRequired: string; copyrightRisk: string;
          whyItFits: string; canvaUse: string;
          imageUrl?: string; thumbUrl?: string; pageUrl?: string;
          attribution?: string; imageSource?: string;
          searchQuery?: string;
          role?: "aircraft" | "context";
        };

        const toRec = (img: any, role: "aircraft" | "context", why: string): ImageRec => ({
          description: img.title,
          source: img.source === "wikimedia" ? "Wikimedia Commons" : img.source === "pexels" ? "Pexels" : "Unsplash",
          licence: img.licence,
          attributionRequired: img.source === "wikimedia" ? "Yes" : "No",
          copyrightRisk: "Low",
          whyItFits: why,
          canvaUse: role === "aircraft" ? "Use as the main hero image — crop to 4:5 for Instagram" : "Use as background or secondary visual element",
          imageUrl: img.url,
          thumbUrl: img.thumbUrl,
          pageUrl: img.pageUrl,
          attribution: img.attribution,
          imageSource: img.source,
          searchQuery: role === "aircraft" ? aircraftQuery : contextQuery,
          role,
        });

        const results: ImageRec[] = [];

        // Slot 1: aircraft photo or text rec
        if (aircraftImages[0]) {
          results.push(toRec(aircraftImages[0], "aircraft", "Shows the exact aircraft type mentioned in the story"));
        } else {
          const textRec = await generateTextImageRec(story.title, viralAngle, aircraftQuery, "aircraft");
          results.push({ description: textRec, source: "Wikimedia Commons", licence: "CC BY-SA", attributionRequired: "Yes", copyrightRisk: "Low", whyItFits: "AI image recommendation — search manually using the description above", canvaUse: "Use as the main hero image — crop to 4:5 for Instagram", pageUrl: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(aircraftQuery)}&ns6=1`, role: "aircraft", imageSource: "text-rec" } as any);
        }

        // Slot 2: context photo or text rec
        if (contextImages[0]) {
          results.push(toRec(contextImages[0], "context", `Matches the "${viralAngle}" angle of the story`));
        } else {
          const textRec = await generateTextImageRec(story.title, viralAngle, contextQuery, "context");
          results.push({ description: textRec, source: "Wikimedia Commons", licence: "CC BY-SA", attributionRequired: "Yes", copyrightRisk: "Low", whyItFits: "AI image recommendation — search manually using the description above", canvaUse: "Use as background or secondary visual element", pageUrl: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(contextQuery)}&ns6=1`, role: "context", imageSource: "text-rec" } as any);
        }

        // Slot 3: second aircraft option
        const slot2Used = !!aircraftImages[1];
        if (slot2Used) results.push(toRec(aircraftImages[1], "aircraft", "Alternative aircraft shot — different livery or angle"));

        // Store all remaining candidates for swapping (per slot, no overlap)
        const imageCandidates: Record<string, any[]> = {
          "0": aircraftImages.slice(slot2Used ? 2 : 1).map(img => toRec(img, "aircraft", "Alternative aircraft photo")),
          "1": contextImages.slice(1).map(img => toRec(img, "context", "Alternative context photo")),
          "2": slot2Used
            ? aircraftImages.slice(2).map(img => toRec(img, "aircraft", "Alternative aircraft photo"))
            : aircraftImages.slice(1).map(img => toRec(img, "aircraft", "Alternative aircraft photo")),
        };

        await updateStoryPackage(input.id, { imageRecommendations: results, imageCandidates });
        return { success: true, count: results.length };
      }),

    regenerateSoyunci: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.id);
        if (!story) throw new Error("Story not found");
        const pkg = await runFullSoyunciPipeline(
          story.title,
          story.content ?? "",
          story.sourceUrl ?? "",
          story.viralReason ?? "",
          story.category ?? "Aviation"
        );
        await updateStoryPackage(input.id, {
          soyunciArticle: pkg.article,
          hashtags: pkg.hashtags,
          selectedHeadline: pkg.selectedHeadline,
          allHeadlines: pkg.alternativeHeadlines,
          topThreeHeadlines: pkg.alternativeHeadlines.slice(0, 3),
          imageRecommendations: pkg.imageRecommendations,
          imageCandidates: pkg.imageCandidates,
          canvaHeadline: pkg.canvaBrief.headline,
          canvaAspectRatio: pkg.canvaBrief.aspectRatio,
          canvaVisualIdea: pkg.canvaBrief.visualIdea,
          canvaAircraftToShow: pkg.canvaBrief.aircraftToShow,
          canvaMood: pkg.canvaBrief.mood,
          canvaBackground: pkg.canvaBrief.background,
          canvaHierarchy: pkg.canvaBrief.hierarchy,
          canvaCircleInsert: pkg.canvaBrief.circleInsert,
          processingStatus: "complete",
          viralAngle: pkg.viralAngle,
          extractedFacts: JSON.stringify(pkg.extractedFacts),
          alternativeHeadlines: JSON.stringify(pkg.alternativeHeadlines),
          researchContext: pkg.researchContext.slice(0, 12000),
          sourcesResearched: pkg.sourcesResearched ?? 0,
        });
        return { success: true };
      }),

    /**
     * Swap the selected image for a given slot by rotating through candidates.
     * The next candidate becomes the selected image; the old selected image
     * is appended to the end of the candidate list for that slot.
     */

    // Pick a specific Wikimedia image from the browse modal and put it in a slot
    pickWikimediaImage: protectedProcedure
      .input(z.object({
        storyId: z.number(),
        slotIndex: z.number(),
        image: z.object({
          thumbUrl: z.string(),
          url: z.string(),
          title: z.string(),
          attribution: z.string().optional(),
          licence: z.string().optional(),
          pageUrl: z.string().optional(),
          description: z.string().optional(),
        }),
      }))
      .mutation(async ({ input }) => {
        const pkg = await getPackageByStoryId(input.storyId);
        if (!pkg) throw new Error("Package not found");

        const recs: any[] = Array.isArray(pkg.imageRecommendations) ? [...pkg.imageRecommendations] : [];
        const candidates: Record<string, any[]> = (pkg.imageCandidates && typeof pkg.imageCandidates === "object" && !Array.isArray(pkg.imageCandidates))
          ? { ...(pkg.imageCandidates as Record<string, any[]>) }
          : {};

        // Build the new image rec in the same shape as the existing ones
        const newRec = {
          description: input.image.description ?? input.image.title,
          source: "Wikimedia Commons",
          licence: input.image.licence ?? "CC BY-SA",
          attributionRequired: "Yes",
          copyrightRisk: "Low",
          whyItFits: "Manually selected from Wikimedia Commons browser",
          canvaUse: recs[input.slotIndex]?.canvaUse ?? "Use as the main hero image — crop to 4:5 for Instagram",
          imageUrl: input.image.url,
          thumbUrl: input.image.thumbUrl,
          pageUrl: input.image.pageUrl ?? null,
          attribution: input.image.attribution ?? null,
          imageSource: "wikimedia",
          role: recs[input.slotIndex]?.role ?? "aircraft",
          title: input.image.title,
        };

        // Push the old image to the candidates pool so it can be recovered
        const slotKey = String(input.slotIndex);
        const oldImage = recs[input.slotIndex];
        if (oldImage && oldImage.imageUrl) {
          const existing: any[] = Array.isArray(candidates[slotKey]) ? [...candidates[slotKey]] : [];
          candidates[slotKey] = [oldImage, ...existing];
        }

        const newRecs = [...recs];
        newRecs[input.slotIndex] = newRec;

        await updateStoryPackage(input.storyId, {
          imageRecommendations: newRecs,
          imageCandidates: candidates,
        });

        return { success: true };
      }),

    swapImage: protectedProcedure
      .input(z.object({
        storyId: z.number(),
        slotIndex: z.number(),
      }))
      .mutation(async ({ input }) => {
        const pkg = await getPackageByStoryId(input.storyId);
        if (!pkg) throw new Error("Package not found");

        const recs: any[] = Array.isArray(pkg.imageRecommendations) ? pkg.imageRecommendations : [];
        const candidates: Record<string, any[]> = (pkg.imageCandidates && typeof pkg.imageCandidates === "object" && !Array.isArray(pkg.imageCandidates))
          ? (pkg.imageCandidates as Record<string, any[]>)
          : {};

        const slotKey = String(input.slotIndex);
        const slotCandidates: any[] = Array.isArray(candidates[slotKey]) ? [...candidates[slotKey]] : [];

        if (slotCandidates.length === 0) {
          throw new Error("No more candidates for this slot");
        }

        // Rotate: next candidate becomes selected, current selected goes to end of list
        const currentSelected = recs[input.slotIndex];
        const nextImage = slotCandidates.shift(); // take first candidate
        if (currentSelected) {
          slotCandidates.push(currentSelected); // push old selected to end
        }

        const newRecs = [...recs];
        newRecs[input.slotIndex] = nextImage;

        const newCandidates = { ...candidates, [slotKey]: slotCandidates };

        await updateStoryPackage(input.storyId, {
          imageRecommendations: newRecs,
          imageCandidates: newCandidates,
        });

        return { success: true, newImage: nextImage, remainingCandidates: slotCandidates.length };
      }),

    saveSoyunciFeedback: protectedProcedure
      .input(z.object({
        storyId: z.number(),
        rating: z.enum(["amazing", "good", "ok", "bad"]),
        note: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const db = await import("./db").then(m => m.getDb());
        if (!db) throw new Error("DB not available");
        const { storyPackages: pkgTable, stories: storiesTable } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(pkgTable)
          .set({ soyunciRating: input.rating, soyunciFeedbackNote: input.note ?? null })
          .where(eq(pkgTable.storyId, input.storyId));
        // Update AI keyword feed performance stats when editor rates a story
        if (input.rating === "amazing" || input.rating === "good") {
          const storyRows = await db.select({ sourceName: storiesTable.sourceName })
            .from(storiesTable)
            .where(eq(storiesTable.id, input.storyId))
            .limit(1);
          if (storyRows.length > 0) {
            recordRatingForFeed(storyRows[0].sourceName).catch(err =>
              console.warn("[Feeds] Failed to update feed rating stats:", err)
            );
          }

          // Auto-regenerate keyword feeds when ≥5 new good/amazing ratings have
          // accumulated since the last regeneration (free threshold check, LLM only when met)
          setImmediate(async () => {
            try {
              const lastRegenAt = await getScoringConfig("keyword_feeds_last_regen_at");
              const ratedSinceRaw = await getScoringConfig("keyword_feeds_rated_since_regen");
              const ratedSince = parseInt(ratedSinceRaw ?? "0", 10) + 1;
              await setScoringConfig("keyword_feeds_rated_since_regen", String(ratedSince));

              const AUTO_REGEN_THRESHOLD = 5;
              const { autoKeywordRegenEnabled } = await getCostControlConfig();
              if (ratedSince >= AUTO_REGEN_THRESHOLD && autoKeywordRegenEnabled) {
                console.log(`[Feeds] Auto-regenerating keyword feeds after ${ratedSince} new good/amazing ratings`);
                await setScoringConfig("keyword_feeds_rated_since_regen", "0");
                await setScoringConfig("keyword_feeds_last_regen_at", new Date().toISOString());
                regenerateKeywordFeeds().catch(err =>
                  console.warn("[Feeds] Auto-regeneration failed:", err)
                );
              }
            } catch (err) {
              console.warn("[Feeds] Auto-regen threshold check failed:", err);
            }
          });
        }
        return { success: true };
      }),

    unapprove: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        // Un-approving = permanently rejected. Story is done, never resurfaces.
        const story = await getStoryById(input.id);
        await updateStoryApproval(input.id, "rejected");
        // Block the URL from ever being re-ingested
        if (story?.sourceUrl) await markUrlAsSeen(story.sourceUrl, "manually_rejected");
        return { success: true };
      }),

    /**
     * Mark a story as completed — removes it from the approved queue without
     * affecting scoring, learning, or the seen-URL list.
     * Use this when you have finished working on a story and posted it.
     * The story is archived and never resurfaces in any active queue.
     */
    markComplete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await updateStoryApproval(input.id, "completed");
        return { success: true };
      }),

    reject: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.id);
        await updateStoryApproval(input.id, "rejected");
        // Block the URL from ever being re-ingested
        if (story?.sourceUrl) await markUrlAsSeen(story.sourceUrl, "manually_rejected");
        // ── Learning signal: every rejection = overrideScore 0, label "reject" ─────────────
        // Previously rejections were invisible to the stat learner because
        // overrideScore/overrideLabel were never written. Now every rejection
        // feeds into the keyword penalty and category weight calculations.
        await updateStoryOverride(input.id, 0, "reject");
        clearStatAdjustCache();
        setImmediate(() => {
          learnFromOverridesStatistical().catch(err =>
            console.warn("[StatLearn] Post-reject learn failed:", err)
          );
        });
        return { success: true };
      }),

    /**
     * Dismiss a story — hides it from all views forever.
     * Marks the URL as seen so it cannot be re-ingested.
     *
     * Intentionally does NOT write an override score or trigger the statistical
     * learner. Dismiss means "not today" or "not interested" — it carries no
     * signal about story quality and should not penalise that story type in
     * future scoring. Use Reject for stories that are genuinely bad.
     */
    dismiss: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.id);
        await updateStoryApproval(input.id, "dismissed");
        // Block this URL so it doesn't reappear in the feed
        if (story?.sourceUrl) await markUrlAsSeen(story.sourceUrl, "manually_dismissed");
        // ── No learning signal ──────────────────────────────────────────────────
        // Dismiss is a neutral action. It does not affect scorer weights,
        // keyword penalties, or category adjustments. Only Reject does that.
        return { success: true };
      }),

    /**
     * Dismiss a story as a duplicate — hides it permanently and blocks the URL
     * from ever being re-ingested. If you've called it a duplicate, you never
     * want to see it again from any source.
     */
    dismissAsDuplicate: protectedProcedure
      .input(z.object({
        id: z.number(),
        // Optional: editor-confirmed canonical story ID from the modal
        canonicalStoryId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.id);
        await updateStoryApproval(input.id, "duplicate");
        // Block the URL permanently — duplicate = never show this again
        if (story?.sourceUrl) await markUrlAsSeen(story.sourceUrl, "duplicate");

        if (story?.title) {
          setImmediate(async () => {
            try {
              if (input.canonicalStoryId) {
                // ── Editor-confirmed canonical: high-quality learning signal ──────────
                // The editor explicitly selected which story this is a duplicate of.
                // Store in the proper duplicate_learning table with confidence 1.0.
                const canonicalStory = await getStoryById(input.canonicalStoryId);
                if (canonicalStory) {
                  await recordConfirmedDuplicatePair(
                    input.id,
                    input.canonicalStoryId,
                    story.title,
                    canonicalStory.title,
                    1.0
                  );
                  console.log(`[DuplicateLearning] Editor-confirmed pair: "${story.title.slice(0, 60)}" → "${canonicalStory.title.slice(0, 60)}"`);
                }
              } else {
                // ── Fallback: best-guess canonical from title similarity ──────────────
                // No canonical selected — find the most similar recent story title.
                // Lower confidence than editor-confirmed pairs.
                const recentTitles = await getRecentStoryTitles(1000);
                const candidates = recentTitles.filter(t => t !== story.title);
                const STOP_WORDS = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","is","was","are","were","has","have","had","be","been","by","as","it","its","this","that","from","after","over","into","up","out","about","than","more","not","no","new"]);
                const tokenise = (t: string): string[] =>
                  t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
                const dismissedSet = new Set(tokenise(story.title));
                let bestMatch: string | null = null;
                let bestSim = 0;
                for (const candidate of candidates) {
                  const candSet = new Set(tokenise(candidate));
                  let intersectionSize = 0;
                  Array.from(candSet).forEach(w => { if (dismissedSet.has(w)) intersectionSize++; });
                  const unionSize = new Set([...Array.from(dismissedSet), ...Array.from(candSet)]).size;
                  const sim = unionSize > 0 ? intersectionSize / unionSize : 0;
                  if (sim > bestSim) { bestSim = sim; bestMatch = candidate; }
                }
                if (bestMatch && bestSim > 0.12) {
                  await recordDuplicatePair(story.title, bestMatch);
                  console.log(`[DuplicateLearning] Guessed pair (sim ${bestSim.toFixed(2)}): "${story.title.slice(0, 60)}" → "${bestMatch.slice(0, 60)}"`);
                } else {
                  console.log(`[DuplicateLearning] No similar canonical found for "${story.title.slice(0, 60)}" (best sim: ${bestSim.toFixed(2)})`);
                }
              }
            } catch (err) {
              console.warn("[DuplicateLearning] Failed to record pair:", err);
            }
          });
        }

        return { success: true };
      }),

    /**
     * Get top duplicate candidates for a story — used by the canonical selection modal.
     * Returns up to 5 stories ranked by event fingerprint match, title similarity, and recency.
     */
    getDuplicateCandidates: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return getDuplicateCandidates(input.id, 5);
      }),

    updateArticle: protectedProcedure
      .input(z.object({ storyId: z.number(), article: z.string() }))
      .mutation(async ({ input }) => {
        await updatePackageArticle(input.storyId, input.article);
        await updateStoryApproval(input.storyId, "edited");
        return { success: true };
      }),

    /**
     * Rewrite the article text only — re-runs the writing LLM step with the
     * current voice examples and editorial rules, but skips research, images,
     * and headlines. Much faster than a full Soyunci run.
     */
    rewriteArticle: protectedProcedure
      .input(z.object({ storyId: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.storyId);
        if (!story) throw new Error("Story not found");
        const pkg = await getPackageByStoryId(input.storyId);
        // Pull existing context from the package so we don't re-research
        const researchContext = (pkg as any)?.researchContext ?? "";
        const viralAngle = (pkg as any)?.viralAngle ?? story.viralReason ?? "Aviation incident";
        const extractedFacts: string[] = (() => {
          try { return JSON.parse((pkg as any)?.extractedFacts ?? "[]"); } catch { return []; }
        })();
        const { article, hashtags } = await rewriteArticleOnly(
          story.title,
          story.content ?? "",
          researchContext,
          viralAngle,
          extractedFacts
        );
        await updateStoryPackage(input.storyId, {
          soyunciArticle: article,
          hashtags,
        });
        return { success: true, article, hashtags };
      }),

    /**
     * ATOMIC PIPELINE: Process one or more URLs end-to-end.
     * For each URL: fetch → dedupe → score → Soyunci article → headlines → images → Canva brief
     * Returns per-URL results including the completed package.
     */
    processUrls: protectedProcedure
      .input(z.object({ urls: z.array(z.string()) }))
      .mutation(async ({ input }) => {
        const [recentTitles, learnedDuplicatePairs] = await Promise.all([
          getRecentStoryTitles(300),
          getConfirmedDuplicatePairs(20), // Use editor-confirmed pairs as high-quality training data
        ]);
        const results: {
          url: string;
          status: "complete" | "duplicate_url" | "duplicate_title" | "not_aviation" | "error";
          storyId?: number;
          title?: string;
          viralScore?: number;
          statusLabel?: string;
          error?: string;
        }[] = [];

        for (const rawUrl of input.urls) {
          const url = rawUrl.trim();
          if (!url) continue;

          try {
            // ── 1. Duplicate URL check ───────────────────────────────────
            if (await storyUrlExists(url)) {
              results.push({ url, status: "duplicate_url" });
              continue;
            }

            // ── 2. Fetch article content ─────────────────────────────────
            const { title, content, publishedAt } = await fetchArticleContent(url);

            // ── 3. Aviation relevance gate ───────────────────────────────
            // For URLs from mainstream sources, block non-aviation content
            if (!isAviationRelevant(title, content, "viral")) {
              results.push({ url, status: "not_aviation", title });
              continue;
            }

            // ── 4. Duplicate title check ─────────────────────────────────
            if (isSimilarTitle(title, recentTitles, learnedDuplicatePairs)) {
              results.push({ url, status: "duplicate_title", title });
              continue;
            }
            // LLM dedup for location+incident matches
            const locMatches = getLocationIncidentMatches(title, recentTitles);
            if (locMatches.length > 0 && await llmDedupCheck(title, locMatches, invokeLLM as any, learnedDuplicatePairs)) {
              results.push({ url, status: "duplicate_title", title });
              continue;
            }

            // ── 5. Viral scoring (apprentice LLM scoring — no post-LLM stat adjustment) ──
            // Uses similarity-matched override examples as few-shot context.
            // The LLM score is the final score; ruleScore is stored for debugging only.
            const scoring = await scoreStoryWithLLM(title, content);

            // ── 6. Save story to DB ──────────────────────────────────────
            const storyId = await createStory({
              sourceUrl: url,
              sourceName: "Manual Input",
              title,
              content: content,
              publishedAt,
              viralScore: scoring.score,
              statusLabel: scoring.statusLabel,
              category: scoring.category,
              viralReason: scoring.viralReason,
              viralTriggers: scoring.triggers,
              isDuplicate: false,
              approvalStatus: "pending",
              processedAt: new Date(),
              scoringMethod: scoring.scoringMethod,
              ruleScore: scoring.ruleScore,
              apprenticeConfidence: scoring.apprenticeConfidence,
              apprenticeReasoning: scoring.apprenticeReasoning,
              similarExamplesUsed: scoring.similarExamplesUsed ?? undefined,
            });

            if (!storyId) throw new Error("Failed to retrieve new story ID");

            // ── 7. Create package record (processing) ────────────────────
            await createStoryPackage({ storyId, processingStatus: "processing" });
            recentTitles.push(title);

            // ── 8. Run full Soyunci pipeline ─────────────────────────────
            try {
              const pkg = await runFullSoyunciPipeline(
                title,
                content,
                url,
                scoring.viralReason,
                scoring.category
              );

              await updateStoryPackage(storyId, {
                soyunciArticle: pkg.article,
                hashtags: pkg.hashtags,
                imageRecommendations: pkg.imageRecommendations,
                imageCandidates: pkg.imageCandidates,
                allHeadlines: pkg.alternativeHeadlines,
                topThreeHeadlines: pkg.alternativeHeadlines.slice(0, 3),
                selectedHeadline: pkg.selectedHeadline,
                canvaHeadline: pkg.canvaBrief.headline,
                canvaAspectRatio: pkg.canvaBrief.aspectRatio,
                canvaVisualIdea: pkg.canvaBrief.visualIdea,
                canvaAircraftToShow: pkg.canvaBrief.aircraftToShow,
                canvaMood: pkg.canvaBrief.mood,
                canvaBackground: pkg.canvaBrief.background,
                canvaHierarchy: pkg.canvaBrief.hierarchy,
                canvaCircleInsert: pkg.canvaBrief.circleInsert,
                processingStatus: "complete",
                viralAngle: pkg.viralAngle,
                extractedFacts: JSON.stringify(pkg.extractedFacts),
                alternativeHeadlines: JSON.stringify(pkg.alternativeHeadlines),
                researchContext: pkg.researchContext.slice(0, 12000),
                sourcesResearched: pkg.sourcesResearched ?? 0,
              });

              results.push({
                url,
                status: "complete",
                storyId,
                title,
                viralScore: scoring.score,
                statusLabel: scoring.statusLabel,
              });
            } catch (pipelineErr) {
              const errorMsg = pipelineErr instanceof Error ? pipelineErr.message : "Pipeline error";
              await updateStoryPackage(storyId, {
                processingStatus: "failed",
                processingError: errorMsg,
              });
              results.push({ url, status: "error", title, error: errorMsg });
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            console.error(`[ProcessUrls] Error processing ${url}:`, err);
            results.push({ url, status: "error", error: errorMsg });
          }
        }

        return { results };
      }),

    /**
     * Retry Soyunci pipeline on a failed package.
     */
    retryStory: protectedProcedure
      .input(z.object({ storyId: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.storyId);
        if (!story) throw new Error("Story not found");

        await updateStoryPackage(input.storyId, { processingStatus: "processing", processingError: null });

        try {
          // New direction: extract research package (no article writing)
          const rp = await extractResearchPackage(
            story.title,
            story.content || "",
            story.sourceUrl || "",
            story.viralReason || "",
            story.category || "General Aviation"
          );
          // Also run image search in parallel for the Approved Queue
          const { researchImages } = await import("./soyunci");
          const { recs: imageRecommendations, candidates: imageCandidates } = await researchImages(
            story.title, "", rp.viralAngle
          );
          await updateStoryPackage(input.storyId, {
            processingStatus: "complete",
            viralAngle: rp.viralAngle,
            extractedFacts: JSON.stringify(rp.extractedInfo),
            sourcesResearched: rp.sourcesResearched,
            sourceConfirmation: rp.sourceConfirmation,
            // Research package fields
            storySummary: rp.storySummary,
            researchExtracted: rp.extractedInfo,
            researchTimeline: rp.timeline,
            researchQuotes: rp.quotes,
            researchSources: rp.sources,
            researchContradictions: rp.contradictions,
            researchMissingInfo: rp.missingInfo,
            researchAdditionalContext: rp.additionalContext,
            researchEditorialHooks: rp.editorialHooks,
            researchStoryQuality: rp.storyQuality,
            researchFlightNumber: rp.flightNumber || null,
            researchRoute: rp.route || null,
            researchAircraftType: rp.aircraftTypeDetail || null,
            researchPassengerCount: rp.passengerCount || null,
            researchCrewCount: rp.crewCount || null,
            researchEventDate: rp.eventDate || null,
            researchPublicationDate: rp.publicationDate || null,
            researchKeyEntities: rp.keyEntities || null,
            // Images (still useful for Canva/posting)
            imageRecommendations,
            imageCandidates,
          });

          return { success: true };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          await updateStoryPackage(input.storyId, {
            processingStatus: "failed",
            processingError: errorMsg,
          });
          throw err;
        }
      }),

    /**
     * Re-research — re-runs the research package extraction for a story.
     * Preserves existing images (does not regenerate them).
     */
    reResearch: protectedProcedure
      .input(z.object({ storyId: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.storyId);
        if (!story) throw new Error("Story not found");

        // Mark as processing immediately
        await updateStoryPackage(input.storyId, { processingStatus: "processing", processingError: null });

        // Clear the deep-research cache for this URL so the retry always fetches
        // fresh source material instead of reusing a potentially empty cached result.
        if (story.sourceUrl) clearDeepResearchCache(story.sourceUrl);

        // Run the research pipeline in the background — return immediately
        // so the HTTP request never times out (research takes 30-90s)
        setImmediate(async () => {
          // Hard 120-second timeout — pipeline must complete or we save a clear error
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Re-research pipeline timeout after 120s")), 120000)
          );
          try {
            const rp = await Promise.race([
              extractResearchPackage(
                story.title,
                story.content ?? "",
                story.sourceUrl ?? "",
                story.viralReason ?? "",
                story.category ?? "General Aviation"
              ),
              timeoutPromise,
            ]);
            await updateStoryPackage(input.storyId, {
              processingStatus: "complete",
              processingError: null,
              viralAngle: rp.viralAngle,
              extractedFacts: JSON.stringify(rp.extractedInfo),
              sourcesResearched: rp.sourcesResearched,
              sourceConfirmation: rp.sourceConfirmation,
              storySummary: rp.storySummary,
              researchExtracted: rp.extractedInfo,
              researchTimeline: rp.timeline,
              researchQuotes: rp.quotes,
              researchSources: rp.sources,
              researchContradictions: rp.contradictions,
              researchMissingInfo: rp.missingInfo,
              researchAdditionalContext: rp.additionalContext,
              researchEditorialHooks: rp.editorialHooks,
              researchStoryQuality: rp.storyQuality,
              researchFlightNumber: rp.flightNumber || null,
              researchRoute: rp.route || null,
              researchAircraftType: rp.aircraftTypeDetail || null,
              researchPassengerCount: rp.passengerCount || null,
              researchCrewCount: rp.crewCount || null,
              researchEventDate: rp.eventDate || null,
              researchPublicationDate: rp.publicationDate || null,
              researchKeyEntities: rp.keyEntities || null,
            });
            console.log(`[ReResearch] Package extraction complete for story ${input.storyId}`);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            console.error(`[ReResearch] Extraction failed for story ${input.storyId}:`, errorMsg);
            await updateStoryPackage(input.storyId, {
              processingStatus: "failed",
              processingError: errorMsg.includes("timeout")
                ? "Re-research timed out (sources took too long to load). Click Re-Research to retry."
                : `Re-research failed: ${errorMsg}. Click Re-Research to retry.`,
            }).catch(() => {});
          }
        });

        return { success: true };
      }),

    /**
     * Refresh all active RSS feeds and ingest new stories.
     *
     * Previously this had its own inline ingest loop that bypassed the
     * event-fingerprint and content-hash dedup added to scheduledIngest.ts.
     * It is now a thin wrapper that calls the canonical ingest pipeline
     * directly so the UI button and the cron job use identical dedup logic.
     *
     * Returns immediately — the ingest runs in the background so the HTTP
     * request never times out regardless of how many feeds are configured.
     */
    refreshFeeds: protectedProcedure.mutation(async ({ ctx }) => {
      // Import the canonical ingest pipeline (avoids circular import at module level)
      const { runIngestPipeline } = await import("./ingestPipeline");
      // Fire-and-forget: kick off in background so the UI button returns instantly
      setImmediate(() => {
        runIngestPipeline().catch(err =>
          console.error("[Feeds] Background ingest error:", err)
        );
      });
      return { started: true, newCount: 0, skippedCount: 0 };
    }),

    /**
     * Re-score and re-rank all pending stories.
     * Uses batch scoring (10 stories per LLM call) for ~10x cost/speed efficiency.
     */
    rerank: protectedProcedure.mutation(async () => {
      const allStories = await getStoriesWithPackages({ approvalStatus: "pending", limit: 200 });
      const toRerank = allStories.filter(
        ({ story }) => story.overrideScore === null || story.overrideScore === undefined
      );
      // Run in the background so the HTTP request returns immediately (avoids timeout on large queues)
      setImmediate(async () => {
        const BATCH_SIZE = 10;
        let completed = 0;
        for (let i = 0; i < toRerank.length; i += BATCH_SIZE) {
          const batch = toRerank.slice(i, i + BATCH_SIZE);
          try {
            const batchInputs: BatchScoringInput[] = batch.map(({ story }) => ({
              title: story.title,
              content: story.content || "",
              ruleScore: { score: story.viralScore, statusLabel: story.statusLabel, category: story.category ?? "General Aviation", viralReason: story.viralReason ?? "", triggers: [], viralExplanation: "" },
            }));
            const results = await batchScoreStoriesWithLLM(batchInputs);
            for (let j = 0; j < batch.length; j++) {
              const { story } = batch[j];
              const scoring = results[j];
              if (!scoring) continue;
              try {
                await updateStoryScores(story.id, scoring.score, scoring.statusLabel, scoring.viralReason, scoring.category, scoring.scoringMethod, {
                  ruleScore: scoring.ruleScore,
                  apprenticeConfidence: scoring.apprenticeConfidence,
                  apprenticeReasoning: scoring.apprenticeReasoning,
                  similarExamplesUsed: scoring.similarExamplesUsed,
                });
                await updateStoryTriggers(story.id, scoring.triggers);
                completed++;
              } catch (err) {
                console.error(`[Rerank] Failed to update story ${story.id}:`, err);
              }
            }
          } catch (err) {
            console.error(`[Rerank] Batch ${i}-${i + BATCH_SIZE} failed, falling back to individual scoring:`, err);
            for (const { story } of batch) {
              try {
                const scoring = await scoreStoryWithLLM(story.title, story.content || "");
                await updateStoryScores(story.id, scoring.score, scoring.statusLabel, scoring.viralReason, scoring.category, scoring.scoringMethod, {
                  ruleScore: scoring.ruleScore,
                  apprenticeConfidence: scoring.apprenticeConfidence,
                  apprenticeReasoning: scoring.apprenticeReasoning,
                  similarExamplesUsed: scoring.similarExamplesUsed,
                });
                await updateStoryTriggers(story.id, scoring.triggers);
                completed++;
              } catch (err2) {
                console.error(`[Rerank] Failed to score story ${story.id}:`, err2);
              }
            }
          }
        }
        console.log(`[Rerank] Completed rescoring ${completed}/${toRerank.length} stories`);
      });
      return { reranked: toRerank.length, message: `Rescoring ${toRerank.length} stories in the background using batch scoring. Refresh in 1-2 minutes.` };
    }),

    /**
     * Set or clear a manual score override for a story.
     * When set, the story's displayed score and label use the override values.
     * Re-rank skips overridden stories so the editor's judgement is preserved.
     */
    overrideScore: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          overrideScore: z.number().min(0).max(100).nullable(),
          overrideLabel: z.enum(["must_post", "strong_candidate", "maybe", "reject"]).nullable(),
        })
      )
      .mutation(async ({ input }) => {
        await updateStoryOverride(input.id, input.overrideScore, input.overrideLabel);

        // ── Step 1: Immediately clear the stat-adjustment cache ──────────────────
        // Previously the cache had a 5-minute TTL, so overrides felt like they
        // weren't working. Now the next scoring call always picks up fresh weights.
        clearStatAdjustCache();

        // ── Step 2: Run statistical learner immediately (free, no LLM) ─────────
        // Updates category weights and keyword boost/penalty lists from override history.
        await learnFromOverridesStatistical().catch(err =>
          console.warn("[StatLearn] Background stat learn failed:", err)
        );
        // Cache is already cleared above; the await ensures fresh weights are in DB
        // before the rerank below reads them.

        // ── Step 3: Stat-adjustment rerank REMOVED ──────────────────────────────────
        // The old approach re-applied applyStatAdjustments() to pending stories after
        // every override, silently overwriting LLM scores with keyword math.
        // This is now removed. The next time a story is scored (via ingest or manual
        // rescore), it will use the updated override examples as few-shot context.
        // The statistical learner (Step 2 above) still runs to keep the light-guidance
        // signals fresh for the prompt, but it no longer forces score changes directly.

        // ── Override-driven feed regeneration ─────────────────────────────────
        // If the editor significantly boosts (≥70) or rejects (≤30) a story,
        // count it as a feed learning signal — same auto-regen threshold as ratings.
        const isStrongOverride =
          input.overrideScore !== null &&
          (input.overrideScore >= 70 || input.overrideScore <= 30);
        if (isStrongOverride) {
          setImmediate(async () => {
            try {
              const ratedSinceRaw = await getScoringConfig("keyword_feeds_rated_since_regen");
              const ratedSince = parseInt(ratedSinceRaw ?? "0", 10) + 1;
              await setScoringConfig("keyword_feeds_rated_since_regen", String(ratedSince));
              const AUTO_REGEN_THRESHOLD = 5;
              const { autoKeywordRegenEnabled } = await getCostControlConfig();
              if (ratedSince >= AUTO_REGEN_THRESHOLD && autoKeywordRegenEnabled) {
                console.log(`[Feeds] Auto-regenerating keyword feeds after ${ratedSince} override signals`);
                await setScoringConfig("keyword_feeds_rated_since_regen", "0");
                await setScoringConfig("keyword_feeds_last_regen_at", new Date().toISOString());
                regenerateKeywordFeeds().catch(err =>
                  console.warn("[Feeds] Auto-regeneration failed:", err)
                );
              }
            } catch (err) {
              console.warn("[Feeds] Override-driven regen check failed:", err);
            }
          });
        }

        // ── LLM deep learner: only runs if auto_deep_learn_enabled flag is on (default: off) ──
        (async () => {
          try {
            const { getScoringConfig, setScoringConfig, getCostControlConfig: getCCC } = await import("./db");
            // Auto deep learn is now ON by default — it uses the 70B model once per
            // 10 overrides (max), so cost is negligible (~1 LLM call per session).
            // It can still be disabled via the cost control panel.
            const { autoDeepLearnEnabled } = await getCCC();
            if (autoDeepLearnEnabled === false) {
              // Only skip if explicitly disabled (false), not if undefined/null (default = on)
              console.log("[AutoLearn] LLM learn skipped — auto_deep_learn_enabled is explicitly off");
              return;
            }

            // Throttle: only run if ≥5 new overrides since last run OR ≥4 hours have passed.
            // 5 overrides is enough signal to update the editorial philosophy meaningfully.
            // 4-hour gap prevents the philosophy from being regenerated multiple times in one
            // working session, which would waste credits without improving quality.
            const lastLearnedAt = await getScoringConfig("last_learned_at");
            const lastLearnedCount = parseInt(await getScoringConfig("last_learned_examples_count") ?? "0", 10);
            const pendingOverridesRaw = await getScoringConfig("pending_learn_overrides");
            const pendingCount = parseInt(pendingOverridesRaw ?? "0", 10) + 1;
            await setScoringConfig("pending_learn_overrides", String(pendingCount));

            const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
            const ranRecently = lastLearnedAt && new Date(lastLearnedAt).getTime() > fourHoursAgo;
            const hasEnoughNewOverrides = pendingCount >= 5;

            if (ranRecently && !hasEnoughNewOverrides) {
              console.log(`[AutoLearn] LLM learn deferred — only ${pendingCount} new overrides since last run (need 5 or 4h gap)`);
              return;
            }

            console.log(`[AutoLearn] Triggering LLM deep learn — ${pendingCount} new overrides since last run...`);
            await setScoringConfig("pending_learn_overrides", "0"); // reset counter
            const result = await learnFromOverrides();
            if (result.success) {
              console.log(`[AutoLearn] Done — learned from ${result.examplesUsed} overrides. ${result.summary}`);
            } else {
              console.log(`[AutoLearn] Skipped — ${result.summary}`);
            }
          } catch (err) {
            console.error("[AutoLearn] LLM learn failed:", err);
          }
        })();

        return { success: true };
      }),

    /**
     * Manually trigger a learn cycle (available from sidebar for immediate re-learn).
     * Normally runs automatically after every override save.
     */
    learnFromOverrides: protectedProcedure.mutation(async () => {
      return learnFromOverrides();
    }),

    /**
     * Returns all stories where the editor applied a manual override,
     * ordered by most recent first. Used on the Learning Insights page.
     */
    overrideHistory: protectedProcedure.query(async () => {
      return getOverrideExamplesFromDb(100);
    }),

    /**
     * Returns the current learned scoring config (rules, weights, insights)
     * plus metadata about when it was last updated and how many examples were used.
     */
    scoringInsights: protectedProcedure.query(async () => {
      const config = await getAllScoringConfig();
      return {
        // LLM deep learner output
        learnedRules: config["learned_scoring_rules"] ?? null,
        learnedWeights: config["learned_category_weights"] ?? null,
        learnedInsights: config["learned_editor_insights"] ?? null,
        lastLearnedAt: config["last_learned_at"] ?? null,
        lastLearnedExamplesCount: config["last_learned_examples_count"]
          ? parseInt(config["last_learned_examples_count"])
          : null,
        // Statistical learner output (free, runs on every override)
        statCategoryWeights: config["stat_category_weights"] ?? null,
        statKeywordBoosts: config["stat_keyword_boosts"] ?? null,
        statKeywordPenalties: config["stat_keyword_penalties"] ?? null,
        statOverallDrift: config["stat_overall_drift"] ?? null,
        statLastLearnedAt: config["stat_last_learned_at"] ?? null,
        statExamplesCount: config["stat_examples_count"]
          ? parseInt(config["stat_examples_count"])
          : null,
        // Performance learner output (from historical_posts)
        statPerfHighKeywords: config["stat_perf_high_keywords"] ?? null,
        statPerfLowKeywords: config["stat_perf_low_keywords"] ?? null,
        statPerfTopCategories: config["stat_perf_top_categories"] ?? null,
        statPerfAvgEngagement: config["stat_perf_avg_engagement"]
          ? parseInt(config["stat_perf_avg_engagement"])
          : null,
        statPerfPostsCount: config["stat_perf_posts_count"]
          ? parseInt(config["stat_perf_posts_count"])
          : null,
        statPerfAnalysedAt: config["stat_perf_analysed_at"] ?? null,
      };
    }),

    // Blocked stories — URLs that were filtered out at ingestion
    blockedStories: protectedProcedure
      .input(z.object({
        limit: z.number().int().min(1).max(200).default(100),
        reason: z.enum(["all", "score_below_threshold", "not_aviation", "similar_title", "manually_rejected"]).default("all"),
      }))
      .query(async () => {
        const db = await getDb();
        if (!db) return [];
        const { seenUrls } = await import("../drizzle/schema");
        const { desc: descOrder, isNotNull: isNotNullFn } = await import("drizzle-orm");
        return db.select({
          url: seenUrls.url,
          rejectedReason: seenUrls.rejectedReason,
          seenAt: seenUrls.seenAt,
        })
          .from(seenUrls)
          .where(isNotNullFn(seenUrls.rejectedReason))
          .orderBy(descOrder(seenUrls.seenAt))
          .limit(200);
      }),

    // Performance Calibration Insights — moved inside stories router
    calibrationInsights: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return null;

      const allPosts = await getHistoricalPosts(500);
      const posts = allPosts.filter(p => (p.views ?? 0) > 0 || (p.likes ?? 0) > 0);

      if (posts.length === 0) return {
        status: "no_data" as const,
        message: "No Instagram posts with stats logged yet."
      };

      const overriddenStories = await db.select({
        id: stories.id,
        title: stories.title,
        category: stories.category,
        viralScore: stories.viralScore,
        overrideScore: stories.overrideScore,
        statusLabel: stories.statusLabel,
        overrideLabel: stories.overrideLabel,
      }).from(stories)
        .where(sql`${stories.overrideScore} IS NOT NULL`);

      let matchedCount = 0;
      let totalOverrideDrift = 0;
      let totalAiDrift = 0;
      const categoryAccuracy: Record<string, { totalDrift: number; count: number }> = {};
      let editorWasRightCount = 0;
      let aiWasRightCount = 0;
      const matches: Array<{ title: string; category: string; aiScore: number; overrideScore: number; trueScore: number; editorWon: boolean }> = [];

      for (const post of posts) {
        const trueScore = calculatePerformanceScore(post);
        if (trueScore === 0) continue;

        let match = null;
        if (post.storyId) {
          match = overriddenStories.find(s => s.id === post.storyId);
        } else {
          const postWords = (post.headline ?? "").toLowerCase().split(/\s+/).slice(0, 5).join(" ");
          match = overriddenStories.find(s => s.title.toLowerCase().includes(postWords));
        }

        if (match && match.overrideScore !== null) {
          matchedCount++;
          const overrideDrift = Math.abs(match.overrideScore - trueScore);
          const aiDrift = Math.abs(match.viralScore - trueScore);
          totalOverrideDrift += overrideDrift;
          totalAiDrift += aiDrift;
          if (overrideDrift < aiDrift) editorWasRightCount++;
          else if (aiDrift < overrideDrift) aiWasRightCount++;
          const cat = match.category ?? "General";
          if (!categoryAccuracy[cat]) categoryAccuracy[cat] = { totalDrift: 0, count: 0 };
          categoryAccuracy[cat].totalDrift += overrideDrift;
          categoryAccuracy[cat].count++;
          matches.push({
            title: match.title,
            category: cat,
            aiScore: match.viralScore,
            overrideScore: match.overrideScore,
            trueScore,
            editorWon: overrideDrift < aiDrift
          });
        }
      }

      if (matchedCount < 3) {
        return {
          status: "insufficient_data" as const,
          message: `Only ${matchedCount} logged posts match your overridden stories. Need at least 3 to calculate calibration.`,
          totalLoggedPosts: posts.length
        };
      }

      const categoryInsights = Object.entries(categoryAccuracy)
        .filter(([, v]) => v.count >= 2)
        .map(([category, v]) => ({
          category,
          avgDrift: Math.round(v.totalDrift / v.count),
          count: v.count
        }))
        .sort((a, b) => a.avgDrift - b.avgDrift);

      const avgEditorDrift = Math.round(totalOverrideDrift / matchedCount);
      const avgAiDrift = Math.round(totalAiDrift / matchedCount);

      return {
        status: "ready" as const,
        matchedCount,
        avgEditorDrift,
        avgAiDrift,
        editorAccuracy: Math.max(0, 100 - avgEditorDrift),
        aiAccuracy: Math.max(0, 100 - avgAiDrift),
        editorWinRate: Math.round((editorWasRightCount / matchedCount) * 100),
        categoryInsights,
        recentMatches: matches.slice(0, 10)
      };
    }),

    /**
     * Score distribution diagnostic — shows the real distribution of AI scores
     * vs editor override scores so you can verify the learning is working.
     * Also shows what the stat learner has learned (category weights, keywords).
     */
    scoreDistribution: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return null;
      const allStories = await db.select({
        viralScore: stories.viralScore,
        overrideScore: stories.overrideScore,
        category: stories.category,
        statusLabel: stories.statusLabel,
        overrideLabel: stories.overrideLabel,
      }).from(stories)
        .where(sql`${stories.viralScore} IS NOT NULL`)
        .limit(500);

      const aiScores = allStories.map(s => s.viralScore).filter(s => s !== null) as number[];
      const overrideScores = allStories.filter(s => s.overrideScore !== null).map(s => s.overrideScore as number);

      const bucket = (scores: number[]) => ({
        "0-20":   scores.filter(s => s <= 20).length,
        "21-40":  scores.filter(s => s > 20 && s <= 40).length,
        "41-60":  scores.filter(s => s > 40 && s <= 60).length,
        "61-80":  scores.filter(s => s > 60 && s <= 80).length,
        "81-95":  scores.filter(s => s > 80 && s <= 95).length,
        "96-100": scores.filter(s => s > 95).length,
      });

      const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
      const max = (arr: number[]) => arr.length ? Math.max(...arr) : 0;

      // Load what the stat learner has actually learned
      const config = await getAllScoringConfig();

      return {
        aiScores: {
          count: aiScores.length,
          avg: avg(aiScores),
          max: max(aiScores),
          distribution: bucket(aiScores),
          hundredsCount: aiScores.filter(s => s >= 96).length,
        },
        overrideScores: {
          count: overrideScores.length,
          avg: avg(overrideScores),
          max: max(overrideScores),
          distribution: bucket(overrideScores),
        },
        learningStatus: {
          statExamplesCount: config["stat_examples_count"] ? parseInt(config["stat_examples_count"]) : 0,
          statLastLearnedAt: config["stat_last_learned_at"] ?? "never",
          statCategoryWeights: config["stat_category_weights"] ?? "none yet",
          statKeywordBoosts: config["stat_keyword_boosts"] ?? "none yet",
          statKeywordPenalties: config["stat_keyword_penalties"] ?? "none yet",
          deepLearnLastAt: config["last_learned_at"] ?? "never",
          deepLearnExamplesCount: config["last_learned_examples_count"] ? parseInt(config["last_learned_examples_count"]) : 0,
          autoDeepLearnEnabled: config["auto_deep_learn_enabled"] !== "false",
          overrideCountSinceLastDeepLearn: config["override_count_since_last_deep_learn"] ? parseInt(config["override_count_since_last_deep_learn"]) : 0,
        },
      };
    }),
  }),

  // ── Historical Posts ───────────────────────────────────────────────────
    historicalPosts: router({
    list: publicProcedure.query(async () => {
      // Exclude auto-created entries from the approve flow — only show posts the editor manually logged
      return getHistoricalPosts(200, ["approved_story"]);
    }),
    create: protectedProcedure
      .input(
        z.object({
          headline: z.string().min(1),
          article: z.string().optional(),
          category: z.string().optional(),
          postingTime: z.string().optional(),
          views: z.number().optional(),
          likes: z.number().optional(),
          comments: z.number().optional(),
          shares: z.number().optional(),
          revenue: z.number().optional(),
          netFollows: z.number().optional(),
          sourceType: z.string().optional(),
          aircraftType: z.string().optional(),
          storyType: z.string().optional(),
          viralAngle: z.string().optional(),
          selectedHeadline: z.string().optional(),
          storyId: z.number().optional(),
          articleSnippet: z.string().optional(),
          usedHeadlineVariant: z.string().max(32).optional(),
          // New social performance fields
          saves: z.number().optional(),
          followersGained: z.number().optional(),
          platform: z.string().max(64).optional(),
          airline: z.string().max(128).optional(),
          imageType: z.string().max(128).optional(),
        })
      )
      .mutation(async ({ input }) => {
        await createHistoricalPost(input);
        // Fire-and-forget: free statistical learner runs on every upload (zero LLM cost)
        analysePerformanceStatistical().catch(err => console.error("[StatPerf] Auto-analyse failed:", err));
        // Free article style analyser: re-runs on every upload that includes article text
        if (input.article || input.articleSnippet) {
          analyseArticleStyle().catch(err => console.error("[ArticleStyle] Auto-analyse failed:", err));
        }
        // LLM deep analysis: only runs if auto_perf_analysis_enabled flag is on (default: off)
        getCostControlConfig().then(cfg => {
          if (cfg.autoPerfAnalysisEnabled) {
            analysePerformance().catch(err => console.error("[Performance] Auto-analyse failed:", err));
          }
        }).catch(() => {});
        return { success: true };
      }),
    performanceInsights: protectedProcedure.query(async () => {
      return getPerformanceInsights();
    }),
    statPerformanceInsights: protectedProcedure.query(async () => {
      return getStatPerformanceInsights();
    }),
    analyseNow: protectedProcedure.mutation(async () => {
      // Run both: free statistical analysis first, then LLM deep analysis
      const [statResult, result] = await Promise.all([
        analysePerformanceStatistical(),
        analysePerformance(true),
      ]);
      return { success: true, insights: result, statInsights: statResult };
    }),
    analyseStatisticalNow: protectedProcedure.mutation(async () => {
      // Free-only analysis — no LLM cost
      const result = await analysePerformanceStatistical();
      return { success: true, statInsights: result };
    }),

    // Upload a batch of headlines with engagement data for learning
    uploadHeadlines: protectedProcedure
      .input(
        z.object({
          headlines: z.array(
            z.object({
              headline: z.string().min(1),
              views: z.number().optional(),
              likes: z.number().optional(),
              comments: z.number().optional(),
              shares: z.number().optional(),
            })
          ).min(1).max(500),
        })
      )
      .mutation(async ({ input }) => {
        // Save each headline as a historical post for the learning pipeline
        let saved = 0;
        for (const h of input.headlines) {
          try {
            await createHistoricalPost({
              headline: h.headline,
              views: h.views,
              likes: h.likes,
              comments: h.comments,
              shares: h.shares,
              sourceType: "manual_upload",
            });
            saved++;
          } catch { /* skip duplicates */ }
        }
        // Free statistical analysis — always runs, zero cost
        const statInsights = await analysePerformanceStatistical();
        // LLM deep analysis — forced (batch upload warrants fresh analysis)
        const insights = await analysePerformance(true);
        return { success: true, saved, insights, statInsights };
      }),



    // Get the current headline style guide
    headlineStyleGuide: protectedProcedure.query(async () => {
      const raw = await getScoringConfig("headline_style_guide");
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    }),
  }),
  exampleArticles: router({
    list: protectedProcedure.query(async () => {
      return getExampleArticles();
    }),
    add: protectedProcedure
      .input(z.object({
        label: z.string().min(1).max(256),
        articleText: z.string().min(10),
      }))
      .mutation(async ({ input }) => {
        await addExampleArticle(input.label, input.articleText);
        // Fire-and-forget: re-analyse writing style patterns whenever a new example is added
        analyseArticleStyle().catch(err => console.error("[ArticleStyle] Auto-analyse failed:", err));
        return { success: true };
      }),
    remove: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        await deleteExampleArticle(input.id);
        return { success: true };
      }),
  }),

    instagram: router({
    /**
     * Verify the stored Instagram token and return the connected username.
     */
    verifyToken: protectedProcedure.query(async () => {
      return verifyInstagramToken();
    }),
    /**
     * Manually trigger an Instagram sync (pulls last 50 posts).
     */
    syncPosts: protectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
      .mutation(async ({ input }) => {
        return syncInstagramPosts(input.limit ?? 50);
      }),
  }),

  digest: router({
    /**
     * List the most recent weekly digests.
     */
    list: protectedProcedure.query(async () => {
      return getRecentDigests(8);
    }),
    /**
     * Generate a fresh weekly digest for the current (or specified) week.
     */
    generate: protectedProcedure
      .input(z.object({ referenceDate: z.string().optional() }))
      .mutation(async ({ input }) => {
        const ref = input.referenceDate ? new Date(input.referenceDate) : undefined;
        return generateWeeklyDigest(ref);
      }),
  }),


  // ── FlightDrama AI Assistant ───────────────────────────────────────────────────────────────
  assistant: router({
    chat: protectedProcedure
      .input(z.object({
        message: z.string().min(1).max(2000),
        history: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })).max(20).optional(),
      }))
      .mutation(async ({ input }) => {
        const history: AssistantMessage[] = input.history ?? [];
        const reply = await chatWithAssistant(input.message, history);
        return { reply };
      }),
  }),


  // ── Wikimedia manual image browser (free — no LLM, no API key) ────────────
  // The client pre-fills the query from buildImageQueries (aircraft + airline + model)
  // extracted from the full source article text, so the editor sees the right
  // airline livery, right colour scheme, right model number in the first results.
  wikimediaSearch: protectedProcedure
    .input(z.object({
      query: z.string().min(1).max(200),
      limit: z.number().min(1).max(50).default(40),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const results = await searchWikimedia(input.query, input.limit, input.offset);
      return results.map(img => ({
        thumbUrl: img.thumbUrl,
        url: img.url,
        title: img.title,
        attribution: img.attribution,
        licence: img.licence,
        pageUrl: img.pageUrl,
        description: img.description ?? "",
        source: img.source,
      }));
    }),

  // ── Pexels manual image browser ────────────────────────────────────────────
  pexelsSearch: protectedProcedure
    .input(z.object({
      query: z.string().min(1).max(200),
      limit: z.number().min(1).max(30).default(12),
    }))
    .query(async ({ input }) => {
      const results = await searchPexels(input.query, input.limit);
      return results.map(img => ({
        thumbUrl: img.thumbUrl,
        url: img.url,
        title: img.title,
        attribution: img.attribution,
        licence: img.licence,
        pageUrl: img.pageUrl,
        description: img.description ?? "",
        source: img.source,
      }));
    }),

  // ── Image Search — live search for manual image selection (zero LLM) ────────
  imageSearch: router({
    /**
     * Smart combined search: Pexels + Wikimedia, routed by query type.
     * People/scene queries → Pexels first. Aircraft/hardware → Wikimedia first.
     * Zero LLM calls — pure API search.
     */
    search: protectedProcedure
      .input(z.object({
        query: z.string().min(1).max(200),
        limit: z.number().min(1).max(20).default(8),
        storyTitle: z.string().optional(),
        slotRole: z.enum(["aircraft", "context"]).optional(),
      }))
      .query(async ({ input }) => {
        // slotRole hint: aircraft slots prefer Wikimedia, context slots prefer Pexels
        const preferWikimedia = input.slotRole === "aircraft";
        const results = await smartImageSearch(input.query, input.limit, input.storyTitle, preferWikimedia);
        return results.map(img => ({
          thumbUrl: img.thumbUrl,
          url: img.url,
          title: img.title,
          attribution: img.attribution,
          licence: img.licence,
          pageUrl: img.pageUrl ?? "",
          description: img.description ?? "",
          source: img.source,
        }));
      }),
    /**
     * Upload a custom image (base64 data URL) to S3 and return a proxied URL.
     * Used by the "Upload your own" button in the image slot UI.
     */
    uploadCustom: protectedProcedure
      .input(z.object({
        // Either a base64 data URL (data:image/...) or a remote https:// URL
        dataUrl: z.string().min(10),
        filename: z.string().default("custom-image.jpg"),
      }))
      .mutation(async ({ input }) => {
        let buffer: Buffer;
        let mimeType: string;
        if (input.dataUrl.startsWith("data:")) {
          // Base64 data URL
          const match = input.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) throw new Error("Invalid data URL format");
          mimeType = match[1];
          buffer = Buffer.from(match[2], "base64");
        } else if (input.dataUrl.startsWith("http")) {
          // Remote URL — fetch and re-upload to S3
          const axios = (await import("axios")).default;
          const resp = await axios.get(input.dataUrl, { responseType: "arraybuffer", timeout: 15000 });
          mimeType = (resp.headers["content-type"] as string)?.split(";")[0] ?? "image/jpeg";
          buffer = Buffer.from(resp.data);
        } else {
          throw new Error("dataUrl must be a base64 data URL or a remote https:// URL");
        }
        const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
        const key = `custom-images/${Date.now()}-${input.filename.replace(/[^a-zA-Z0-9._-]/g, "-")}.${ext}`;
        const { url } = await storagePut(key, buffer, mimeType);
        return {
          url,
          thumbUrl: url,
          title: input.filename,
          attribution: "Custom upload",
          licence: "Custom",
          pageUrl: "",
          description: "Custom uploaded image",
          source: "custom" as const,
        };
      }),
  }),
  // ── Ingest Log ─────────────────────────────────────────────────────────────
  ingestLog: router({
    summary: protectedProcedure
      .input(z.object({ sinceHours: z.number().optional() }))
      .query(async ({ input }) => {
        const since = input.sinceHours
          ? new Date(Date.now() - input.sinceHours * 60 * 60 * 1000)
          : undefined;
        return getIngestLogSummary(since);
      }),
    list: protectedProcedure
      .input(z.object({
        limit: z.number().optional(),
        dropReason: z.string().optional(),
        sinceHours: z.number().optional(),
      }))
      .query(async ({ input }) => {
        const since = input.sinceHours
          ? new Date(Date.now() - input.sinceHours * 60 * 60 * 1000)
          : undefined;
        return getIngestLog({
          limit: input.limit ?? 200,
          dropReason: input.dropReason,
          since,
        });
      }),
  }),
  // ── Cost Control — toggle LLM features on/off ──────────────────────────────
  costControl: router({
    get: protectedProcedure.query(async () => {
      return getCostControlConfig();
    }),
    set: protectedProcedure
      .input(z.object({
        llmScoringEnabled: z.boolean().optional(),
        autoPerfAnalysisEnabled: z.boolean().optional(),
        autoKeywordRegenEnabled: z.boolean().optional(),
        autoDeepLearnEnabled: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        await setCostControlConfig(input);
        return { success: true };
      }),
  }),
});
export type AppRouter = typeof appRouter;
