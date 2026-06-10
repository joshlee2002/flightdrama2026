/**
 * Heartbeat handler for the hourly Instagram sync job.
 * Registered at POST /api/scheduled/instagram-sync
 */

import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { syncInstagramPosts } from "./instagramSync";
import { ENV } from "./_core/env";

export async function scheduledInstagramSyncHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user?.isCron) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!ENV.instagramAccessToken) {
      return res.status(200).json({ ok: false, reason: "INSTAGRAM_ACCESS_TOKEN not configured" });
    }

    const result = await syncInstagramPosts(50);
    console.log(`[InstagramSync] synced=${result.synced} skipped=${result.skipped} errors=${result.errors.length}`);

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[InstagramSync] handler error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
