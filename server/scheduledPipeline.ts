/**
 * Scheduled pipeline processor.
 *
 * Registered at POST /api/scheduled/pipeline
 * Runs every 30 minutes (after the ingest cron) to automatically process
 * stories that are stuck in `processingStatus = 'queued'` through the
 * research extraction pipeline.
 *
 * Processes up to 5 stories per run to avoid LLM rate limits and long
 * execution times. Prioritises highest-scored stories first.
 */
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { getDb, getStoryById, updateStoryPackage, createStoryPackage } from "./db";
import { extractResearchPackage, researchImages } from "./soyunci";
import { storyPackages, stories } from "../drizzle/schema";
import { eq, and, sql, desc } from "drizzle-orm";

const BATCH_SIZE = 5; // stories per run

export async function scheduledPipelineHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }

    console.log(`[Pipeline] Cron triggered (taskUid: ${user.taskUid}) — checking for queued stories...`);

    const db = await getDb();
    if (!db) {
      return res.json({ ok: true, processed: 0, message: "No database connection" });
    }

    // Find stories with queued packages, ordered by score descending
    const queuedRows = await db
      .select({
        storyId: storyPackages.storyId,
        viralScore: stories.viralScore,
        overrideScore: stories.overrideScore,
      })
      .from(storyPackages)
      .innerJoin(stories, eq(stories.id, storyPackages.storyId))
      .where(
        and(
          eq(storyPackages.processingStatus, "queued"),
          eq(stories.approvalStatus, "pending" as any)
        )
      )
      .orderBy(desc(sql`COALESCE(${stories.overrideScore}, ${stories.viralScore})`))
      .limit(BATCH_SIZE);

    // Also find pending stories with NO package at all and create packages for them
    const unpackagedRows = await db
      .select({ id: stories.id })
      .from(stories)
      .leftJoin(storyPackages, eq(storyPackages.storyId, stories.id))
      .where(
        and(
          eq(stories.approvalStatus, "pending" as any),
          sql`${storyPackages.id} IS NULL`
        )
      )
      .limit(20);

    let packagesCreated = 0;
    for (const row of unpackagedRows) {
      try {
        await createStoryPackage({ storyId: row.id, processingStatus: "queued" });
        packagesCreated++;
      } catch {
        // ignore duplicate key errors
      }
    }
    if (packagesCreated > 0) {
      console.log(`[Pipeline] Created ${packagesCreated} missing packages for unpackaged stories`);
    }

    if (queuedRows.length === 0) {
      console.log(`[Pipeline] No queued stories to process`);
      return res.json({ ok: true, processed: 0, packagesCreated, message: "No queued stories" });
    }

    console.log(`[Pipeline] Processing ${queuedRows.length} queued stories...`);

    let processed = 0;
    let failed = 0;

    for (const row of queuedRows) {
      const storyId = row.storyId;
      try {
        const story = await getStoryById(storyId);
        if (!story) continue;

        await updateStoryPackage(storyId, { processingStatus: "processing", processingError: null });

        const rp = await extractResearchPackage(
          story.title,
          story.content || "",
          story.sourceUrl || "",
          story.viralReason || "",
          story.category || "General Aviation"
        );

        const { recs: imageRecommendations, candidates: imageCandidates } = await researchImages(
          story.title, "", rp.viralAngle
        );

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

        console.log(`[Pipeline] ✓ Processed story ${storyId}: ${story.title.slice(0, 60)}`);
        processed++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[Pipeline] ✗ Failed story ${storyId}:`, errorMsg);
        await updateStoryPackage(storyId, {
          processingStatus: "failed",
          processingError: errorMsg,
        });
        failed++;
      }
    }

    console.log(`[Pipeline] Complete — ${processed} processed, ${failed} failed, ${packagesCreated} packages created`);
    return res.json({ ok: true, processed, failed, packagesCreated });
  } catch (err) {
    console.error("[Pipeline] Handler error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
}
