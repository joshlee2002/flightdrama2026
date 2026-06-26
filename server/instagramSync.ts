/**
 * Instagram Graph API sync pipeline.
 *
 * Pulls the last N posts from the connected Instagram Business/Creator account,
 * fetches per-post insights (likes, comments, saves, reach, impressions),
 * parses the caption to extract headline + article body, then upserts each post
 * into the historical_posts table for use by the scoring model and headline learner.
 *
 * Requires: INSTAGRAM_ACCESS_TOKEN env var (long-lived token, expires ~60 days).
 */

import { ENV } from "./_core/env";
import { getDb } from "./db";
import { historicalPosts } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const GRAPH_BASE = "https://graph.instagram.com/v21.0";

// ── Types ────────────────────────────────────────────────────────────────────

interface IgMedia {
  id: string;
  caption?: string;
  timestamp: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  like_count?: number;
  comments_count?: number;
}

interface IgInsights {
  reach?: number;
  saved?: number;
  impressions?: number;
  shares?: number;
  plays?: number; // Reels
  total_interactions?: number;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

// ── Graph API helpers ────────────────────────────────────────────────────────

async function graphGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = ENV.instagramAccessToken;
  if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN is not set");

  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch the Instagram Business Account ID linked to the token. */
async function getIgUserId(): Promise<string> {
  const data = await graphGet<{ id: string }>("/me", { fields: "id" });
  return data.id;
}

/** Fetch up to `limit` recent media objects. */
async function fetchRecentMedia(userId: string, limit = 50): Promise<IgMedia[]> {
  const data = await graphGet<{ data: IgMedia[] }>(`/${userId}/media`, {
    fields: "id,caption,timestamp,media_type,like_count,comments_count",
    limit: String(limit),
  });
  return data.data ?? [];
}

/** Fetch insights for a single media object. Returns empty object on failure. */
async function fetchMediaInsights(mediaId: string, mediaType: string): Promise<IgInsights> {
  // Metric set differs by media type
  const isReel = mediaType === "VIDEO";
  const metrics = isReel
    ? "reach,saved,shares,plays,total_interactions"
    : "reach,saved,impressions,total_interactions";

  try {
    const data = await graphGet<{ data: Array<{ name: string; values: Array<{ value: number }> }> }>(
      `/${mediaId}/insights`,
      { metric: metrics, period: "lifetime" }
    );
    const result: IgInsights = {};
    for (const item of data.data ?? []) {
      const val = item.values?.[0]?.value ?? 0;
      (result as Record<string, number>)[item.name] = val;
    }
    return result;
  } catch {
    // Insights may be unavailable for old posts — don't fail the whole sync
    return {};
  }
}

// ── Caption parser ────────────────────────────────────────────────────────────

/**
 * Parses an Instagram caption into { headline, article, hashtags }.
 *
 * FlightDrama caption format (typical):
 *   HEADLINE TEXT\n\nArticle body text...\n\n#hashtag1 #hashtag2
 *
 * Heuristics:
 *   - First non-empty line → headline
 *   - Lines between headline and hashtag block → article body
 *   - Lines starting with # → hashtags
 */
function parseCaption(caption: string): { headline: string; article: string; hashtags: string[] } {
  if (!caption) return { headline: "", article: "", hashtags: [] };

  const lines = caption.split("\n").map((l) => l.trim());
  const hashtagLineIdx = lines.findIndex((l) => l.startsWith("#"));

  const contentLines = hashtagLineIdx >= 0 ? lines.slice(0, hashtagLineIdx) : lines;
  const hashtagLine = hashtagLineIdx >= 0 ? lines.slice(hashtagLineIdx).join(" ") : "";

  const nonEmpty = contentLines.filter((l) => l.length > 0);
  const headline = nonEmpty[0] ?? "";
  const article = nonEmpty.slice(1).join(" ").trim();

  const hashtags = hashtagLine.match(/#\w+/g) ?? [];

  return { headline, article, hashtags };
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Sync Instagram posts into historical_posts.
 * Safe to call repeatedly — uses instagramPostId for deduplication.
 * @param limit  Maximum number of recent posts to fetch (default 50)
 */
export async function syncInstagramPosts(limit = 50): Promise<SyncResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result: SyncResult = { synced: 0, skipped: 0, errors: [] };

  const userId = await getIgUserId();
  const media = await fetchRecentMedia(userId, limit);

  for (const post of media) {
    try {
      // Dedup: skip if already in DB
      const existing = await db
        .select({ id: historicalPosts.id })
        .from(historicalPosts)
        .where(eq(historicalPosts.instagramPostId, post.id))
        .limit(1);

      if (existing.length > 0) {
        // Update engagement stats on existing row (they change over time)
        const insights = await fetchMediaInsights(post.id, post.media_type);
        await db
          .update(historicalPosts)
          .set({
            likes: post.like_count ?? 0,
            comments: post.comments_count ?? 0,
            shares: insights.shares ?? 0,
            saves: insights.saved ?? 0,
            reach: insights.reach ?? 0,
            views: insights.impressions ?? insights.plays ?? 0,
          })
          .where(eq(historicalPosts.instagramPostId, post.id));
        result.skipped++;
        continue;
      }

      // New post — fetch insights and insert
      const insights = await fetchMediaInsights(post.id, post.media_type);
      const { headline, article } = parseCaption(post.caption ?? "");

      if (!headline) {
        // No parseable headline — skip (e.g. pure image with no caption)
        result.skipped++;
        continue;
      }

      const postedAt = new Date(post.timestamp);
      const hour = postedAt.getUTCHours();
      const postingTime =
        hour < 6 ? "midnight" :
        hour < 12 ? "morning" :
        hour < 17 ? "afternoon" :
        hour < 21 ? "evening" : "night";

      await db.insert(historicalPosts).values({
        headline,
        article: article || null,
        articleSnippet: article ? article.slice(0, 300) : null,
        postingTime,
        likes: post.like_count ?? 0,
        comments: post.comments_count ?? 0,
        shares: insights.shares ?? 0,
        saves: insights.saved ?? 0,
        reach: insights.reach ?? 0,
        views: insights.impressions ?? insights.plays ?? 0,
        platform: "Instagram",
        sourceType: "instagram_sync",
        instagramPostId: post.id,
        createdAt: postedAt,
      });

      result.synced++;
    } catch (err) {
      result.errors.push(`Post ${post.id}: ${String(err)}`);
    }
  }

  return result;
}

/**
 * Check whether the Instagram token is configured, valid, and has the required permissions.
 * Returns the connected account username, granted permissions, and token expiry on success.
 */
export async function verifyInstagramToken(): Promise<{
  ok: boolean;
  username?: string;
  error?: string;
  permissions?: string[];
  missingPermissions?: string[];
  tokenExpiresAt?: string | null;
}> {
  const REQUIRED_PERMISSIONS = [
    "instagram_basic",
    "instagram_manage_insights",
    "pages_read_engagement",
  ];

  try {
    // 1. Verify token is valid and get username
    const data = await graphGet<{ id: string; username: string }>("/me", { fields: "id,username" });

    // 2. Check granted permissions and token expiry via the token debug endpoint
    const token = ENV.instagramAccessToken;
    let grantedPermissions: string[] = [];
    let tokenExpiresAt: string | null = null;
    try {
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${token}&access_token=${token}`;
      const debugRes = await fetch(debugUrl);
      if (debugRes.ok) {
        const debugData = await debugRes.json() as {
          data?: { scopes?: string[]; expires_at?: number; is_valid?: boolean };
        };
        grantedPermissions = debugData?.data?.scopes ?? [];
        if (debugData?.data?.expires_at) {
          tokenExpiresAt = new Date(debugData.data.expires_at * 1000).toISOString();
        }
      }
    } catch {
      // Permission check failed — token is valid but we can't verify scopes.
      // Non-fatal: sync will fail with a clear API error if permissions are missing.
    }

    const missingPermissions = grantedPermissions.length > 0
      ? REQUIRED_PERMISSIONS.filter(p => !grantedPermissions.includes(p))
      : []; // If debug endpoint unavailable, assume permissions are OK

    return {
      ok: missingPermissions.length === 0,
      username: data.username,
      permissions: grantedPermissions.length > 0 ? grantedPermissions : undefined,
      missingPermissions: missingPermissions.length > 0 ? missingPermissions : undefined,
      tokenExpiresAt,
      error: missingPermissions.length > 0
        ? `Token is missing required permissions: ${missingPermissions.join(", ")}. Re-authorise the Instagram connection in Settings.`
        : undefined,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
