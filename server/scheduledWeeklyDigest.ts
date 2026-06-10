/**
 * Heartbeat handler for the Monday 09:00 UTC weekly digest job.
 * Registered at POST /api/scheduled/weekly-digest
 */

import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { generateWeeklyDigest } from "./weeklyDigest";

export async function scheduledWeeklyDigestHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user?.isCron) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await generateWeeklyDigest();
    console.log(
      `[WeeklyDigest] Generated digest id=${result.id} storiesApproved=${result.storiesApproved} topCategory=${result.topCategory}`
    );

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[WeeklyDigest] handler error:", err);
    return res.status(500).json({
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
}
