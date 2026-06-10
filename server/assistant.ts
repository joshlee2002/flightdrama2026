/**
 * assistant.ts
 *
 * FlightDrama AI Assistant — a dedicated editorial AI that knows everything
 * about the FlightDrama site and can take real actions through conversation.
 *
 * Powered by Groq (Llama 3.3 70B) — free tier, ~640ms response time.
 *
 * Available tools:
 * - get_dashboard_summary: current story queue stats
 * - get_story_details: full details of a specific story
 * - get_recent_stories: list recent stories with scores
 * - rewrite_article: rewrite a story's article
 * - rescore_story: re-run viral scoring on a story
 * - fetch_rss_sources: get RSS source status
 * - trigger_ingest: manually trigger RSS ingestion
 * - update_scoring_rules: update the AI scoring config
 * - get_performance_summary: recent performance data
 * - get_rss_source_status: diagnose RSS feed issues
 */

import { invokeLLM, type Message } from "./_core/llm";
import {
  getDb,
  getStoriesWithPackages,
  getStoryById,
  getPackageByStoryId,
  updateStoryPackage,
  updateStoryScores,
  getRssSources,
  getScoringConfig,
  setScoringConfig,
  getHistoricalPosts,
  getLastIngestTime,
} from "./db";
import { rewriteArticleOnly } from "./soyunci";
import { scoreStory } from "./viralScoring";
import { fetchRssFeed } from "./ingestion";
import { sql } from "drizzle-orm";
import { stories } from "../drizzle/schema";

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the FlightDrama Editorial AI Assistant — a dedicated AI built exclusively for the FlightDrama aviation Instagram account (@flightdrama). You know everything about this site and can take real actions.

ABOUT FLIGHTDRAMA:
- Aviation content account covering everything in global aviation: incidents, new routes, airline news, aircraft deliveries, passenger chaos, viral moments
- Posts 4:5 Instagram images with bold yellow/white headlines in Barlow Condensed ExtraBold font
- Articles are 120-220 words, punchy, direct, no moralising endings
- Uses a 6-step Soyunci editorial pipeline: Research → Facts → Angle → Article → Headlines → Images
- Scores stories 0-100 on viral potential (80+ = Must Post, 60-79 = Strong Candidate, 40-59 = Maybe, <40 = Reject)

YOUR CAPABILITIES:
You can read live data from the database and take the following actions using your tools:
1. get_dashboard_summary — see current story queue, pending count, last ingest time
2. get_recent_stories — list recent stories with their scores and status
3. get_story_details — get full details of a specific story including article, headlines, images
4. rewrite_article — rewrite a story's article (provide story ID and optional instructions)
5. rescore_story — re-run viral scoring on a story
6. get_rss_source_status — check which RSS feeds are active and when they last fetched
7. trigger_rss_fetch — manually fetch a specific RSS feed right now
8. update_scoring_rule — update a scoring configuration rule
9. get_performance_summary — see recent post performance data
10. get_scoring_config — read the current AI scoring rules

PERSONALITY:
- Direct and efficient — you are a professional editorial assistant
- You know aviation deeply — you understand airline names, aircraft types, routes, incidents
- When asked to fix something, you fix it immediately using your tools, then confirm what you did
- When asked about a coding/programming issue, explain clearly what the problem likely is and tell the user to ask Manus (the AI that built this site) to fix it
- You only think about FlightDrama — you don't discuss unrelated topics
- Keep responses concise — this is a working tool, not a chatbot

IMPORTANT: Always use your tools to get real data before answering questions about stories, scores, or RSS feeds. Never make up data.`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_dashboard_summary",
      description: "Get a summary of the current story dashboard: pending count, approved count, last ingest time, and top stories",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_recent_stories",
      description: "Get a list of recent stories with their viral scores, status, and approval state",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of stories to return (default 10, max 20)" },
          status: { type: "string", enum: ["pending", "approved", "all"], description: "Filter by approval status" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_story_details",
      description: "Get full details of a specific story including article text, headlines, viral angle, images, and scores",
      parameters: {
        type: "object",
        properties: {
          story_id: { type: "number", description: "The story ID" },
        },
        required: ["story_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rewrite_article",
      description: "Rewrite the article for a specific story. Use this when the user says an article is too long, sounds wrong, is generic, or needs improvement.",
      parameters: {
        type: "object",
        properties: {
          story_id: { type: "number", description: "The story ID to rewrite" },
          instructions: { type: "string", description: "Optional specific instructions for the rewrite (e.g. 'make it shorter', 'focus on the emergency angle', 'more punchy')" },
        },
        required: ["story_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rescore_story",
      description: "Re-run viral scoring on a story to update its score and status label",
      parameters: {
        type: "object",
        properties: {
          story_id: { type: "number", description: "The story ID to rescore" },
        },
        required: ["story_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_rss_source_status",
      description: "Get the status of all RSS sources — which are active, when they last fetched, and any that might be having issues",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "trigger_rss_fetch",
      description: "Manually fetch a specific RSS feed right now to get the latest stories",
      parameters: {
        type: "object",
        properties: {
          source_name: { type: "string", description: "The name of the RSS source to fetch (e.g. 'Simple Flying', 'BBC News')" },
        },
        required: ["source_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_scoring_config",
      description: "Read the current AI scoring rules and configuration",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_scoring_rule",
      description: "Update a scoring configuration rule to change how stories are scored",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The config key to update" },
          value: { type: "string", description: "The new value for the config" },
          reason: { type: "string", description: "Why this change is being made" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_performance_summary",
      description: "Get a summary of recent post performance data including top performing stories",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of posts to include (default 10)" },
        },
        required: [],
      },
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {

      case "get_dashboard_summary": {
        const db = await getDb();
        if (!db) return "Database not connected.";
        const [pendingResult, approvedResult] = await Promise.all([
          db.select({ count: sql<number>`COUNT(*)` }).from(stories).where(sql`approvalStatus = 'pending'`),
          db.select({ count: sql<number>`COUNT(*)` }).from(stories).where(sql`approvalStatus = 'approved'`),
        ]);
        const lastIngest = await getLastIngestTime();
        const topStories = await getStoriesWithPackages({ limit: 5, sortBy: "top_scored" });
        const pending = Number(pendingResult[0]?.count ?? 0);
        const approved = Number(approvedResult[0]?.count ?? 0);
        const topList = topStories.slice(0, 5).map(({ story }) =>
          `  - Story ${story.id}: "${story.title.slice(0, 60)}..." (score: ${story.overrideScore ?? story.viralScore}, status: ${story.approvalStatus})`
        ).join("\n");
        return `Dashboard Summary:
- Pending stories: ${pending}
- Approved stories: ${approved}
- Last RSS ingest: ${lastIngest ? new Date(lastIngest).toLocaleString() : "Never"}
- Top 5 stories by score:
${topList || "  (no stories yet)"}`;
      }

      case "get_recent_stories": {
        const limit = Math.min(args.limit ?? 10, 20);
        const statusFilter = args.status === "approved" ? "approved" : args.status === "pending" ? "pending" : undefined;
        const items = await getStoriesWithPackages({
          approvalStatus: statusFilter,
          limit,
          sortBy: "newest",
        });
        if (items.length === 0) return "No stories found.";
        const list = items.map(({ story, package: pkg }) => {
          const score = story.overrideScore ?? story.viralScore;
          const status = story.approvalStatus;
          const label = story.statusLabel?.replace("_", " ") ?? "unknown";
          const hasArticle = pkg?.soyunciArticle ? "✓ article" : "no article";
          return `  Story ${story.id} [${status}] score:${score} (${label}) — "${story.title.slice(0, 70)}..." [${hasArticle}]`;
        }).join("\n");
        return `Recent ${items.length} stories:\n${list}`;
      }

      case "get_story_details": {
        const story = await getStoryById(args.story_id);
        if (!story) return `Story ${args.story_id} not found.`;
        const pkg = await getPackageByStoryId(args.story_id);
        const article = pkg?.soyunciArticle ?? "(no article yet)";
        const headline = pkg?.selectedHeadline ?? "(no headline yet)";
        const angle = pkg?.viralAngle ?? story.viralReason ?? "(none)";
        const wordCount = article.split(/\s+/).filter(Boolean).length;
        return `Story ${story.id}: "${story.title}"
Source: ${story.sourceName ?? "unknown"} | URL: ${story.sourceUrl}
Score: ${story.overrideScore ?? story.viralScore} | Status: ${story.approvalStatus} | Label: ${story.statusLabel}
Viral angle: ${angle}
Headline: ${headline}
Article (${wordCount} words): ${article.slice(0, 800)}${article.length > 800 ? "..." : ""}
Pipeline status: ${pkg?.processingStatus ?? "not started"}`;
      }

      case "rewrite_article": {
        const story = await getStoryById(args.story_id);
        if (!story) return `Story ${args.story_id} not found.`;
        const pkg = await getPackageByStoryId(args.story_id);
        const researchContext = pkg?.researchContext ?? "";
        const viralAngle = pkg?.viralAngle ?? story.viralReason ?? "";
        // Run the rewrite
        const rewriteResult = await rewriteArticleOnly(
          story.title,
          story.content ?? "",
          researchContext,
          viralAngle,
          []
        );
        const newArticle = rewriteResult.article;
        await updateStoryPackage(args.story_id, { soyunciArticle: newArticle });
        const wordCount = newArticle.split(/\s+/).filter(Boolean).length;
        return `Article for story ${args.story_id} rewritten successfully (${wordCount} words):\n\n"${newArticle.slice(0, 400)}${newArticle.length > 400 ? "..." : ""}"`;
      }

      case "rescore_story": {
        const story = await getStoryById(args.story_id);
        if (!story) return `Story ${args.story_id} not found.`;
        const result = scoreStory(story.title, story.content ?? "");
        await updateStoryScores(
          args.story_id,
          result.score,
          result.statusLabel,
          result.viralReason,
          result.category ?? story.category ?? "Aviation"
        );
        return `Story ${args.story_id} rescored: ${result.score}/100 (${result.statusLabel.replace("_", " ")}) — ${result.viralReason}`;
      }

      case "get_rss_source_status": {
        const sources = await getRssSources();
        if (sources.length === 0) return "No RSS sources configured.";
        const active = sources.filter(s => s.isActive);
        const inactive = sources.filter(s => !s.isActive);
        const now = Date.now();
        const stale = active.filter(s => {
          if (!s.lastFetchedAt) return true;
          const age = now - new Date(s.lastFetchedAt).getTime();
          return age > 3 * 60 * 60 * 1000; // stale if not fetched in 3 hours
        });
        const lines = [
          `Total: ${sources.length} sources (${active.length} active, ${inactive.length} inactive)`,
          stale.length > 0 ? `\nPotentially stale (not fetched in 3+ hours):` : "",
          ...stale.map(s => `  - ${s.name}: last fetched ${s.lastFetchedAt ? new Date(s.lastFetchedAt).toLocaleString() : "NEVER"}`),
          `\nAll active sources:`,
          ...active.slice(0, 15).map(s => `  - [${s.category}] ${s.name}: ${s.lastFetchedAt ? new Date(s.lastFetchedAt).toLocaleString() : "never fetched"}`),
          active.length > 15 ? `  ... and ${active.length - 15} more` : "",
        ];
        return lines.filter(Boolean).join("\n");
      }

      case "trigger_rss_fetch": {
        const sources = await getRssSources();
        const source = sources.find(s =>
          s.name.toLowerCase().includes(args.source_name.toLowerCase()) ||
          args.source_name.toLowerCase().includes(s.name.toLowerCase())
        );
        if (!source) return `Could not find RSS source matching "${args.source_name}". Available sources: ${sources.slice(0, 10).map(s => s.name).join(", ")}`;
        const items = await fetchRssFeed(source.url, source.name);
        return `Fetched ${items.length} items from "${source.name}". Latest: "${items[0]?.title ?? "(none)"}"`;
      }

      case "get_scoring_config": {
        const keys = ["scoring_rules", "viral_patterns", "category_weights", "override_patterns"];
        const results: string[] = [];
        for (const key of keys) {
          const val = await getScoringConfig(key);
          if (val) results.push(`${key}:\n${val.slice(0, 300)}`);
        }
        return results.length > 0 ? results.join("\n\n") : "No scoring config found yet. Override some story scores to start training the AI.";
      }

      case "update_scoring_rule": {
        await setScoringConfig(args.key, args.value);
        return `Scoring rule "${args.key}" updated${args.reason ? ` (reason: ${args.reason})` : ""}. This will affect future story scoring.`;
      }

      case "get_performance_summary": {
        const posts = await getHistoricalPosts(args.limit ?? 10);
        if (posts.length === 0) return "No performance data logged yet. Use 'Log This Post' in the Approved Queue after posting to Instagram.";
        const sorted = [...posts].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
        const list = sorted.slice(0, 10).map(p =>
          `  - "${(p.headline ?? "").slice(0, 60)}..." | views:${p.views ?? "?"} likes:${p.likes ?? "?"} comments:${p.comments ?? "?"}`
        ).join("\n");
        return `Performance data (${posts.length} posts logged):\nTop posts by views:\n${list}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Main chat function ────────────────────────────────────────────────────────

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export async function chatWithAssistant(
  userMessage: string,
  history: AssistantMessage[]
): Promise<string> {
  // Use fast 8B model for initial response — it handles simple chat instantly
  // and only calls tools when genuinely needed (unlike 70B which always picks tools)
  const FAST_MODEL = "llama-3.1-8b-instant";
  const SMART_MODEL = "llama-3.3-70b-versatile";

  // Build message history
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  // First LLM call with fast model
  let response = await invokeLLM({
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    model: FAST_MODEL,
  });

  // If the fast model gave a direct text response, return it immediately
  const quickContent = response.choices?.[0]?.message?.content;
  if (
    response.choices?.[0]?.finish_reason === "stop" &&
    typeof quickContent === "string" &&
    quickContent.trim().length > 0
  ) {
    return quickContent;
  }

  // Agentic tool-call loop — switch to smarter model for synthesis
  let iterations = 0;
  const MAX_ITERATIONS = 5;
  while (response.choices?.[0]?.finish_reason === "tool_calls" && iterations < MAX_ITERATIONS) {
    iterations++;
    const assistantMsg = response.choices[0].message;
    const toolCalls = assistantMsg.tool_calls ?? [];
    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      toolCalls.map(async (tc: any) => {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments ?? "{}"); } catch { /* ignore */ }
        const result = await executeTool(tc.function.name, args);
        return { tool_call_id: tc.id, role: "tool" as const, content: result };
      })
    );
    // Continue with smarter model once we have tool results to synthesise
    const continuedMessages: Message[] = [
      ...messages,
      { role: "assistant", content: typeof assistantMsg.content === "string" ? assistantMsg.content : "", tool_calls: toolCalls } as any,
      ...toolResults as any,
    ];
    response = await invokeLLM({
      messages: continuedMessages,
      tools: TOOLS,
      tool_choice: "auto",
      model: SMART_MODEL,
    });
  }

  const finalContent = response.choices?.[0]?.message?.content;
  if (typeof finalContent === "string" && finalContent.trim().length > 0) return finalContent;
  return "I couldn't generate a response. Please try again.";
}
