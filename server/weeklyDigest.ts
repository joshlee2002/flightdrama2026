/**
 * weeklyDigest.ts
 *
 * Generates a weekly digest summarising approved stories, category trends,
 * and concrete content recommendations for the coming week.
 *
 * Called by:
 *  - tRPC procedure  stories.generateDigest  (manual trigger)
 *  - Heartbeat       /api/scheduled/weekly-digest  (every Monday 09:00)
 */

import { getDb } from "./db";
import { stories, historicalPosts, weeklyDigests } from "../drizzle/schema";
import { and, gte, lte, eq, desc } from "drizzle-orm";
import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon...
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date: Date): Date {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function generateWeeklyDigest(referenceDate?: Date): Promise<{
  id: number;
  summary: string;
  recommendations: string;
  storiesApproved: number;
  topCategory: string | null;
  weekStart: Date;
  weekEnd: Date;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const now = referenceDate ?? new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);

  // ── 1. Pull approved stories from this week ──────────────────────────────
  const approvedStories = await db
    .select({
      id: stories.id,
      title: stories.title,
      category: stories.category,
      viralScore: stories.viralScore,
      overrideScore: stories.overrideScore,
      statusLabel: stories.statusLabel,
      viralReason: stories.viralReason,
      createdAt: stories.createdAt,
    })
    .from(stories)
    .where(
      and(
        eq(stories.approvalStatus, "approved"),
        gte(stories.createdAt, weekStart),
        lte(stories.createdAt, weekEnd)
      )
    )
    .orderBy(desc(stories.viralScore));

  // ── 2. Pull recent historical posts for engagement context ───────────────
  const recentPosts = await db
    .select({
      headline: historicalPosts.headline,
      category: historicalPosts.category,
      views: historicalPosts.views,
      likes: historicalPosts.likes,
      usedHeadlineVariant: historicalPosts.usedHeadlineVariant,
      createdAt: historicalPosts.createdAt,
    })
    .from(historicalPosts)
    .orderBy(desc(historicalPosts.createdAt))
    .limit(20);

  // ── 3. Compute category breakdown ────────────────────────────────────────
  const categoryCounts: Record<string, number> = {};
  for (const s of approvedStories) {
    const cat = s.category ?? "General Aviation";
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }
  const topCategory =
    Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const topStory = approvedStories[0] ?? null;

  // ── 4. Build LLM prompt ──────────────────────────────────────────────────
  const approvedList = approvedStories
    .slice(0, 15)
    .map(
      (s: typeof approvedStories[0], i: number) =>
        `${i + 1}. [Score: ${s.overrideScore ?? s.viralScore}] ${s.title} (${s.category ?? "General"}) — ${s.viralReason?.slice(0, 80) ?? "no reason"}`
    )
    .join("\n");

  const performanceList =
    recentPosts.length > 0
      ? recentPosts
          .slice(0, 10)
          .map(
            (p: typeof recentPosts[0]) =>
              `• ${p.headline} | ${p.category ?? "?"} | ${p.views ? `${p.views.toLocaleString()} views` : "no views"} | ${p.likes ? `${p.likes.toLocaleString()} likes` : "no likes"}`
          )
          .join("\n")
      : "No performance data logged yet.";

  const categoryBreakdown = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `  ${cat}: ${count} stories`)
    .join("\n");

  const prompt = `You are the editorial intelligence layer for FlightDrama, an aviation content brand on Instagram with a highly engaged audience.

Here is a summary of this week's approved stories (${weekStart.toDateString()} – ${weekEnd.toDateString()}):

APPROVED STORIES THIS WEEK (${approvedStories.length} total):
${approvedList || "No stories approved this week."}

CATEGORY BREAKDOWN:
${categoryBreakdown || "No categories."}

RECENT PERFORMANCE DATA (last 20 posts):
${performanceList}

Your job is to write a weekly digest for the editor. Be direct, specific, and useful. No fluff.

Write two sections:

1. WEEKLY SUMMARY (3–5 sentences)
   - What story types dominated this week?
   - Any notable patterns in what got approved vs. rejected?
   - What does the performance data tell us about what the audience responds to?
   - Be honest if there's not enough data yet.

2. RECOMMENDATIONS FOR NEXT WEEK (4–6 bullet points, each starting with "•")
   - Specific story types or angles to prioritise based on this week's patterns
   - Any headline structures that appear to be working
   - Gaps or underserved story types worth exploring
   - One concrete tip for improving engagement based on performance data
   - Keep each bullet to 1–2 sentences, actionable and specific

Respond in plain text. No markdown headers. No asterisks. Just the two sections, separated by a blank line.`;

  const response = await invokeLLM({
    model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content:
          "You are an editorial intelligence assistant for a high-performing aviation Instagram account. You write concise, actionable weekly digests for the editor.",
      },
      { role: "user", content: prompt },
    ],
  });

  const rawText: string =
    (response as any)?.choices?.[0]?.message?.content ?? "";

  // Split into summary and recommendations
  const parts = rawText.split(/\n\s*\n/);
  const summary = parts[0]?.trim() ?? rawText.trim();
  const recommendations = parts.slice(1).join("\n\n").trim() || summary;

  // ── 5. Persist to DB ─────────────────────────────────────────────────────
  const [inserted] = await db
    .insert(weeklyDigests)
    .values({
      weekStart,
      weekEnd,
      storiesApproved: approvedStories.length,
      topCategory,
      topStoryTitle: topStory?.title ?? null,
      topStoryScore: topStory ? (topStory.overrideScore ?? topStory.viralScore) : null,
      summary,
      recommendations,
      rawData: {
        categoryCounts,
        approvedCount: approvedStories.length,
        topStoryId: topStory?.id ?? null,
        recentPostCount: recentPosts.length,
      },
    })
    .$returningId();

  return {
    id: (inserted as { id: number }).id,
    summary,
    recommendations,
    storiesApproved: approvedStories.length,
    topCategory,
    weekStart,
    weekEnd,
  };
}

// ─── Fetch recent digests ─────────────────────────────────────────────────────

export async function getRecentDigests(limit = 8) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(weeklyDigests)
    .orderBy(desc(weeklyDigests.createdAt))
    .limit(limit);
}
