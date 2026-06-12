import { COOKIE_NAME } from "@shared/const";
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
} from "./db";
import { eq, sql } from "drizzle-orm";
import { stories } from "../drizzle/schema";
import { fetchArticleContent, fetchRssFeed, isSimilarTitle, isAviationRelevant, DEFAULT_RSS_SOURCES } from "./ingestion";
import { scoreStory } from "./viralScoring";
import { scoreStoryWithLLM, learnFromOverrides, learnFromOverridesStatistical } from "./llmScoring";
import { runFullSoyunciPipeline, rewriteArticleOnly, runResearchAndWrite } from "./soyunci";
import { analysePerformance, getPerformanceInsights, analysePerformanceStatistical, getStatPerformanceInsights, analyseArticleStyle, getArticleStyleInsights } from "./performanceAnalysis";
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
        const appPassword = process.env.APP_PASSWORD;
        if (!appPassword) {
          throw new Error("Server misconfiguration: APP_PASSWORD not set");
        }
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
        // Mark as processing immediately so the UI shows the spinner
        await updateStoryPackage(input.id, { processingStatus: "processing", processingError: null });
        // Fire-and-forget: run full Soyunci pipeline in background after approval
        setImmediate(async () => {
          try {
            const story = await getStoryById(input.id);
            if (!story) return;
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
              sourceConfirmation: pkg.sourceConfirmation ?? null,
              headlineObjects: pkg.headlineObjects ?? [],
              selectedViralityScore: pkg.selectedViralityScore ?? null,
              selectedHeadlineType: pkg.selectedHeadlineType ?? null,
            });

            // Auto-log to historical_posts so performance data feeds the model.
            // Use the SNAPSHOT headlines (what the editor saw before pipeline re-ran),
            // not the freshly generated ones, so the chosen variant is accurate.
            try {
              const variant = input.usedHeadlineVariant ?? "selected";
              const usedHeadline =
                variant === "selected"
                  ? (snapshotSelected ?? pkg.selectedHeadline)
                  : variant.startsWith("alt_")
                    ? snapshotHeadlines[parseInt(variant.replace("alt_", ""), 10) - 1]
                      ?? snapshotSelected
                      ?? pkg.selectedHeadline
                    : snapshotSelected ?? pkg.selectedHeadline;
              // Find the virality score and type for the chosen headline variant
              const chosenHeadlineObj = variant === "selected"
                ? { viralityScore: pkg.selectedViralityScore, type: pkg.selectedHeadlineType }
                : (pkg.headlineObjects ?? []).find((_: any, i: number) => `alt_${i + 1}` === variant) ?? {};
              await createHistoricalPost({
                headline: usedHeadline ?? story.title,
                article: pkg.article ?? null,
                articleSnippet: pkg.article ? pkg.article.slice(0, 300) : null,
                category: story.category ?? null,
                viralAngle: pkg.viralAngle ?? null,
                selectedHeadline: pkg.selectedHeadline ?? null,
                usedHeadlineVariant: variant,
                storyId: input.id,
                sourceType: "approved_story",
                headlineType: (chosenHeadlineObj as any).type ?? null,
                headlineViralityScore: (chosenHeadlineObj as any).viralityScore ?? null,
              });
              console.log(`[Soyunci] Auto-logged historical post for story ${input.id}`);
            } catch (logErr) {
              console.warn(`[Soyunci] Failed to log historical post for story ${input.id}:`, logErr);
            }

            console.log(`[Soyunci] Auto-run complete for story ${input.id}`);
          } catch (err) {
            console.error(`[Soyunci] Auto-run failed for story ${input.id}:`, err);
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

    reject: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.id);
        await updateStoryApproval(input.id, "rejected");
        // Block the URL from ever being re-ingested
        if (story?.sourceUrl) await markUrlAsSeen(story.sourceUrl, "manually_rejected");
        return { success: true };
      }),

    /**
     * Permanently dismiss a story — hides it from all views forever.
     * The URL stays in seen_urls so it is never re-ingested.
     */
    dismiss: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await updateStoryApproval(input.id, "dismissed");
        return { success: true };
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
        const recentTitles = await getRecentStoryTitles(300);
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
            if (isSimilarTitle(title, recentTitles)) {
              results.push({ url, status: "duplicate_title", title });
              continue;
            }

            // ── 5. Viral scoring ─────────────────────────────────────────
            const scoring = scoreStory(title, content);

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
                    const pkg = await runFullSoyunciPipeline(
            story.title,
            story.content || "",
            story.sourceUrl || "",
            story.viralReason || "",
            story.category || "General Aviation"
          );
          await updateStoryPackage(input.storyId, {
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
            sourceConfirmation: pkg.sourceConfirmation ?? null,
            editorReview: pkg.editorReview ?? null,
            editorScore: pkg.editorReview?.soyunciScore ?? null,
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
     * Re-research and rewrite only — runs the Soyunci research, fact extraction,
     * angle detection, article writing, and headline generation steps but does NOT
     * regenerate images. Scoped strictly to research + write so the editor's chosen
     * images are preserved.
     */
    reResearch: protectedProcedure
      .input(z.object({ storyId: z.number() }))
      .mutation(async ({ input }) => {
        const story = await getStoryById(input.storyId);
        if (!story) throw new Error("Story not found");

        await updateStoryPackage(input.storyId, { processingStatus: "processing", processingError: null });

        try {
          const result = await runResearchAndWrite(
            story.title,
            story.content ?? "",
            story.sourceUrl ?? "",
            story.viralReason ?? "",
            story.category ?? "General Aviation"
          );
          await updateStoryPackage(input.storyId, {
            soyunciArticle: result.article,
            hashtags: result.hashtags,
            selectedHeadline: result.selectedHeadline,
            allHeadlines: result.alternativeHeadlines,
            topThreeHeadlines: result.alternativeHeadlines.slice(0, 3),
            processingStatus: "complete",
            viralAngle: result.viralAngle,
            extractedFacts: JSON.stringify(result.extractedFacts),
            alternativeHeadlines: JSON.stringify(result.alternativeHeadlines),
            researchContext: result.researchContext.slice(0, 12000),
            sourcesResearched: result.sourcesResearched,
            sourceConfirmation: result.sourceConfirmation ?? null,
            editorReview: result.editorReview ?? null,
            editorScore: result.editorReview?.soyunciScore ?? null,
          });
          return { success: true, sourcesResearched: result.sourcesResearched };
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
     * Refresh all active RSS feeds and ingest new stories.
     * Aviation gate applied to all viral/mainstream sources.
     * Returns immediately — the ingest runs in the background so the HTTP
     * request never times out regardless of how many feeds are configured.
     */
    refreshFeeds: protectedProcedure.mutation(async () => {
      // Fire-and-forget: kick off the ingest in the background and return
      // immediately so the client never hits a request timeout.
      setImmediate(async () => {
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

          // Auto-expiry: skip AI keyword feeds that have passed their expiry date
          if (source.sourceType === "ai_keyword" && source.expiresAt && source.expiresAt < new Date()) {
            console.log(`[Feeds] Skipping expired AI feed: ${source.name}`);
            continue;
          }

          try {
            const items = await fetchRssFeed(source.url, source.name);
            await updateRssSourceLastFetched(source.id);

            for (const item of items) {
              // Fast dedup: check seen_urls table first (covers all URLs ever seen,
              // including those rejected by the score gate or aviation filter)
              if (await hasSeenUrl(item.sourceUrl)) { skippedCount++; continue; }

              // Title similarity check (catches reposts with slightly different URLs)
              if (isSimilarTitle(item.title, recentTitles)) {
                await markUrlAsSeen(item.sourceUrl, "similar_title");
                skippedCount++;
                continue;
              }

              // Aviation gate for viral/mainstream sources
              if (!isAviationRelevant(item.title, item.content, source.category)) {
                await markUrlAsSeen(item.sourceUrl, "not_aviation");
                skippedCount++;
                continue;
              }

              // Cost control: use rule-based scoring if LLM scoring is disabled (default: off)
              const { llmScoringEnabled } = await getCostControlConfig();
              const scoring = llmScoringEnabled
                ? await scoreStoryWithLLM(item.title, item.content)
                : (() => { const s = scoreStory(item.title, item.content); return { ...s, scoringMethod: "rule_based" as const }; })();

              // Mark as seen BEFORE the score gate — so low-scoring stories are
              // never re-evaluated on the next fetch, even though they won't be stored.
              await markUrlAsSeen(item.sourceUrl, scoring.score < feedThreshold ? "score_below_threshold" : undefined);

              if (scoring.score < feedThreshold) { skippedCount++; continue; }
              const newStoryId = await createStory({
                sourceUrl: item.sourceUrl,
                // Use the rss_sources.name (not the feed title) so AI keyword feeds
                // can be matched back to their source row for performance tracking
                sourceName: source.name,
                title: item.title,
                content: item.content,
                publishedAt: item.publishedAt,
                viralScore: scoring.score,
                statusLabel: scoring.statusLabel,
                category: scoring.category,
                viralReason: scoring.viralReason,
                viralTriggers: scoring.triggers,
                scoringMethod: scoring.scoringMethod,
                isDuplicate: false,
                approvalStatus: "pending",
                processedAt: new Date(),
              });

              if (newStoryId) {
                await createStoryPackage({ storyId: newStoryId, processingStatus: "queued" });
                recentTitles.push(item.title);
                newCount++;
              }
            }
          } catch (err) {
            console.error(`[Feeds] Error fetching ${source.name}:`, err);
          }
        }
        console.log(`[Feeds] Background ingest complete — ${newCount} new, ${skippedCount} skipped`);
      });

      // Return immediately so the UI button never spins forever
      return { started: true, newCount: 0, skippedCount: 0 };
    }),

    /**
     * Re-score and re-rank all pending stories.
     */
        rerank: protectedProcedure.mutation(async () => {
      const allStories = await getStoriesWithPackages({ approvalStatus: "pending", limit: 200 });

      for (const { story } of allStories) {
        // Skip stories with a manual override — preserve the editor's judgement
        if (story.overrideScore !== null && story.overrideScore !== undefined) continue;
        const scoring = await scoreStoryWithLLM(story.title, story.content || "");
        await updateStoryScores(story.id, scoring.score, scoring.statusLabel, scoring.viralReason, scoring.category, scoring.scoringMethod);
        await updateStoryTriggers(story.id, scoring.triggers);
      }
      return { reranked: allStories.length };
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

        // ── Free statistical learner: runs on EVERY override, zero cost ──────
        // Instantly updates category weights and keyword boost/penalty lists
        // from your override history using pure statistics (no LLM).
        learnFromOverridesStatistical().catch(err =>
          console.warn("[StatLearn] Background stat learn failed:", err)
        );

        // ── LLM deep learner: only runs if auto_deep_learn_enabled flag is on (default: off) ──
        (async () => {
          try {
            const { getScoringConfig, getCostControlConfig: getCCC } = await import("./db");
            const { autoDeepLearnEnabled } = await getCCC();
            if (!autoDeepLearnEnabled) {
              console.log("[AutoLearn] LLM learn skipped — auto_deep_learn_enabled is off");
              return;
            }
            const lastLearnedAt = await getScoringConfig("last_learned_at");
            const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
            if (lastLearnedAt && new Date(lastLearnedAt).getTime() > thirtyMinutesAgo) {
              console.log("[AutoLearn] LLM learn skipped — ran less than 30 minutes ago");
              return;
            }
            console.log("[AutoLearn] Override saved — triggering LLM deep learn cycle...");
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
        learnedRules: config["learned_scoring_rules"] ?? null,
        learnedWeights: config["learned_category_weights"] ?? null,
        learnedInsights: config["learned_editor_insights"] ?? null,
        lastLearnedAt: config["last_learned_at"] ?? null,
        lastLearnedExamplesCount: config["last_learned_examples_count"]
          ? parseInt(config["last_learned_examples_count"])
          : null,
      };
    }),
  }),

  // ── Historical Posts ───────────────────────────────────────────────────
    historicalPosts: router({
    list: publicProcedure.query(async () => {
      return getHistoricalPosts(200);
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
