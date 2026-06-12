/**
 * Soyunci — FlightDrama Editorial Engine
 *
 * NOT a summarisation engine. An aviation angle-finding engine.
 *
 * Pipeline:
 *   Step 0: Deep Research   — web search for additional sources, quotes, facts
 *   Step 1: Fact Extraction — identify what matters most to readers
 *   Step 2: Angle Detection — find the single strongest viral angle
 *   Step 3: Article Writing — 80–160 words, Soyunci style, with feedback learning
 *   Step 4: Headlines       — recommended + alternatives + predicted winner
 *   Step 5: Image Recs      — primary, secondary, optional inset
 *   Step 6: Output Package  — viral angle, article, headlines, images, hashtags
 *
 * Feedback loop: top-rated past outputs are injected as few-shot examples
 * so Soyunci learns the editor's voice over time.
 */

import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { fetchArticleText, fetchArticlesBatch } from "./articleFetcher";

// Model routing: llama-4-scout for research/writing (30k TPM, own pool)
// llama-3.3-70b-versatile for headlines only (higher quality, shared 100k TPD pool)
const PIPELINE_MODEL = ENV.defaultLlmModel || "llama-3.3-70b-versatile";
const HEADLINE_MODEL = ENV.headlineModel || ENV.defaultLlmModel || "llama-3.3-70b-versatile";
import { getDb } from "./db";
import { storyPackages } from "../drizzle/schema";
import { isNotNull, desc } from "drizzle-orm";
import { getPerformanceInsights, getArticleStyleInsights, type PerformanceInsights } from "./performanceAnalysis";
import { getScoringConfig, getExampleArticles } from "./db";
import { searchImages, buildImageQueries, generateTextImageRec, type FoundImage } from "./imageSearch";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoyunciOutput {
  viralAngle: string;
  extractedFacts: string[];
  article: string;
  hashtags: string[];
  selectedHeadline: string;
  alternativeHeadlines: string[];
  imageRecommendations: ImageRecommendation[];
  imageCandidates: Record<string, ImageRecommendation[]>;
  canvaBrief: CanvaBrief;
  researchContext: string;
  /** Number of sources successfully fetched and used during the research step */
  sourcesResearched: number;
  /** SEO title (55-60 chars, includes primary keyword) */
  seoTitle: string;
  /** SEO meta description (140-160 chars) */
  seoDescription: string;
  /** FlightDrama Editor quality review */
  editorReview: EditorReview;
}

export interface EditorReview {
  storyAngle: string;
  biggestWeakness: string;
  missingContext: string;
  fillerSentences: string[];
  soyunciScore: number;
  verdict: "Approve" | "Needs Revision";
}

export interface CanvaBrief {
  headline: string;
  aspectRatio: string;
  visualIdea: string;
  aircraftToShow: string;
  circleInsert: string;
  mood: string;
  background: string;
  hierarchy: string;
}

export interface ImageRecommendation {
  // Legacy text fields (kept for backwards compatibility)
  title?: string;          // Raw image file title e.g. "Boeing 737-800 Southwest Airlines N8301J"
  description: string;
  source: string;
  licence: string;
  attributionRequired: string;
  copyrightRisk: string;
  whyItFits: string;
  canvaUse: string;
  // Real image fields (populated when a live photo is found)
  imageUrl?: string;       // Direct full-resolution URL
  thumbUrl?: string;       // Thumbnail URL (≤1200px)
  pageUrl?: string;        // Attribution page link
  attribution?: string;    // Photographer credit
  imageSource?: string;    // "wikimedia" | "pexels" | "unsplash"
  role?: "aircraft" | "context"; // Which slot this image fills
  aiPrompt?: string;   // The prompt used to generate this image (AI-generated only)
  searchQuery?: string; // The exact query sent to Wikimedia/Pexels for this image slot
  altQueries?: string[]; // 3 alternative search suggestions the user can try
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(response: any): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

// ── Step 0: Deep Research ─────────────────────────────────────────────────────

/**
 * Known aviation Twitter/X accounts whose tweets are pulled for context.
 * These are authoritative sources (safety databases, regulators, trackers).
 * IDs are stable and pre-resolved to avoid a profile lookup on every run.
 */
// Twitter/X removed — all research uses free Google/Bing News RSS + direct article fetches only.



/**
 * Gathers additional context about a story from multiple sources:
 *  1. Google News RSS — finds real news articles covering the same story for cross-referencing
 *  2. Direct fetch of the original source URL for full article text
 *  3. Twitter/X — recent tweets from aviation authority accounts, filtered by story keywords
 * Then uses the LLM to extract all useful facts from the combined material.
 */

/** Strip HTML tags and collapse whitespace from raw HTML */
function stripHtml(html: string, maxLen = 4000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * Fetch Bing News RSS and return top article items with REAL article URLs.
 *
 * Bing News RSS wraps article URLs in redirect links of the form:
 *   http://www.bing.com/news/apiclick.aspx?...&url=https%3a%2f%2factual-site.com%2farticle
 * We decode the `url=` query parameter to get the real article URL.
 *
 * Falls back to Google News RSS if Bing fails, extracting source URLs from
 * the `url=` parameter in Google's redirect links where available.
 */
async function fetchNewsRss(query: string): Promise<Array<{ title: string; source: string; url: string }>> {
  const encoded = encodeURIComponent(query);

  // ── Try Bing News RSS first (returns real URLs in redirect params) ────────
  try {
    const bingUrl = `https://www.bing.com/news/search?q=${encoded}&format=rss`;
    const res = await fetch(bingUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const xml = await res.text();
      const items: Array<{ title: string; source: string; url: string }> = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let match: RegExpExecArray | null;
      while ((match = itemRe.exec(xml)) !== null) {
        const block = match[1];
        const titleMatch = block.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
                           block.match(/<title>([^<]+)<\/title>/);
        const linkMatch = block.match(/<link>([^<]+)<\/link>/);
        if (!titleMatch || !linkMatch) continue;

        // Extract real URL from Bing redirect: ...&url=https%3a%2f%2factual.com%2farticle&...
        const rawLink = linkMatch[1].trim();
        let realUrl = rawLink;
        try {
          const urlParam = new URL(rawLink.replace(/&amp;/g, "&")).searchParams.get("url");
          if (urlParam && urlParam.startsWith("http")) realUrl = urlParam;
        } catch { /* keep rawLink */ }

        // Skip MSN aggregator pages — they're paywalled or JS-rendered
        if (realUrl.includes("msn.com")) continue;

        const sourceMatch = block.match(/<source[^>]*>([^<]+)<\/source>/);
        items.push({
          title: titleMatch[1].trim(),
          source: sourceMatch ? sourceMatch[1].trim() : new URL(realUrl).hostname.replace(/^www\./, ""),
          url: realUrl,
        });
        if (items.length >= 20) break;
      }
      if (items.length > 0) {
        console.log(`[Soyunci] Bing News: ${items.length} articles found for "${query.slice(0, 60)}"`);
        return items;
      }
    }
  } catch (err) {
    console.warn("[Soyunci] Bing News RSS failed:", err);
  }

  // ── Fallback: Google News RSS ─────────────────────────────────────────────
  try {
    const googleUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(googleUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FlightDrama/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: Array<{ title: string; source: string; url: string }> = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;
    while ((match = itemRe.exec(xml)) !== null) {
      const block = match[1];
      const titleMatch = block.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
                         block.match(/<title>([^<]+)<\/title>/);
      const linkMatch = block.match(/<link>([^<]+)<\/link>/);
      const sourceMatch = block.match(/<source[^>]*>([^<]+)<\/source>/);
      if (titleMatch && linkMatch) {
        items.push({
          title: titleMatch[1].trim(),
          source: sourceMatch ? sourceMatch[1].trim() : "Unknown",
          url: linkMatch[1].trim(), // Google News redirect URL — will fail fetch, but title/source are still useful
        });
      }
      if (items.length >= 20) break;
    }
    return items;
  } catch {
    return [];
  }
}

/** @deprecated Use fetchNewsRss instead */
async function fetchGoogleNewsRss(query: string): Promise<Array<{ title: string; source: string; url: string }>> {
  return fetchNewsRss(query);
}

/** Result from deepResearch — includes the context string and how many sources were successfully fetched */
export interface DeepResearchResult {
  context: string;
  sourcesResearched: number;
  /** Full raw text of the primary source article (before LLM synthesis). Empty string if fetch failed. */
  primarySourceText: string;
}

async function deepResearch(title: string, sourceUrl: string, rssContent = ""): Promise<DeepResearchResult> {
  try {
    const searchQuery = title.replace(/[^\w\s]/g, " ").trim().slice(0, 120);
    const sourceParts: string[] = [];
    let sourcesResearched = 0;
    let primarySourceText = "";

    // ── Source 1: Fetch the original article for full text ────────────────────────────────────
    // fetchArticleText now uses a 4-layer fallback chain:
    //   1. Direct Chrome headers  2. Safari UA  3. Jina AI Reader (JS rendering)  4. AllOrigins proxy
    // This covers the vast majority of sites including Cloudflare-protected and JS-rendered pages.
    try {
      const originalArticle = await fetchArticleText(sourceUrl);
      if (originalArticle.success && originalArticle.bodyText.length > 200) {
        primarySourceText = originalArticle.bodyText;
        sourceParts.push(`=== PRIMARY SOURCE: ${sourceUrl} ===`);
        sourceParts.push(originalArticle.bodyText);
        sourcesResearched++;
        console.log(`[Soyunci] Primary source: ${originalArticle.wordCount} words from ${sourceUrl}`);
      } else {
        // All 4 fetch layers failed — fall back to RSS content
        if (rssContent && rssContent.trim().length > 100) {
          primarySourceText = rssContent.trim();
          sourceParts.push(`=== PRIMARY SOURCE (RSS snippet — all fetch layers failed): ${sourceUrl} ===`);
          sourceParts.push(rssContent.trim());
          sourcesResearched++;
          console.warn(`[Soyunci] All fetch layers failed — using RSS content (${rssContent.trim().split(/\s+/).length} words) for ${sourceUrl}`);
        } else {
          console.warn(`[Soyunci] *** ALL FETCH LAYERS FAILED AND NO RSS CONTENT — ${sourceUrl} ***`);
        }
      }
    } catch (err) {
      if (rssContent && rssContent.trim().length > 100) {
        primarySourceText = rssContent.trim();
        sourceParts.push(`=== PRIMARY SOURCE (RSS snippet — fetch exception): ${sourceUrl} ===`);
        sourceParts.push(rssContent.trim());
        sourcesResearched++;
        console.warn(`[Soyunci] Fetch exception — using RSS content as fallback`);
      } else {
        console.warn("[Soyunci] *** PRIMARY ARTICLE FETCH FAILED — will rely on secondary sources:", err);
      }
    }

    // ── Source 2+: Bing/Google News RSS — find and fetch secondary articles ─────
    // Uses Bing News RSS which returns real article URLs (not Google redirect wrappers).
    // Falls back to Google News RSS if Bing fails.
    // RELEVANCE GATE: Secondary sources are only used if their title shares at least
    // 2 significant words with the primary story title. This prevents loosely-related
    // articles from polluting the fact matrix with irrelevant information.
    try {
      const newsItems = await fetchNewsRss(searchQuery);
      if (newsItems.length > 0) {
        // ── Relevance filter: only accept secondary sources that are clearly about the same story ──
        // Extract significant words from the primary title (ignore stop words)
        const STOP_WORDS = new Set(["a","an","the","and","or","but","in","on","at","to","for",
          "of","with","by","from","is","was","are","were","be","been","has","have","had",
          "it","its","this","that","as","after","over","into","about","up","out","after",
          "flight","airline","aircraft","plane","airport"]);
        const titleWords = title.toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter(w => w.length > 3 && !STOP_WORDS.has(w));

        const isRelevantSecondary = (candidateTitle: string): boolean => {
          const candidateWords = candidateTitle.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3 && !STOP_WORDS.has(w));
          // Count how many significant words from the primary title appear in the candidate
          const overlap = titleWords.filter(w => candidateWords.some(cw => cw.includes(w) || w.includes(cw)));
          return overlap.length >= 2;
        };

        const relevantItems = newsItems.filter(item => isRelevantSecondary(item.title));
        const irrelevantCount = newsItems.length - relevantItems.length;
        if (irrelevantCount > 0) {
          console.log(`[Soyunci] Relevance gate: rejected ${irrelevantCount}/${newsItems.length} secondary sources as unrelated`);
        }

        // Fetch full text from ALL relevant secondary articles in parallel
        // No artificial cap — we want every source covering this story
        const secondaryUrls = relevantItems
          .map((item) => item.url)
          .filter((u) => u && u !== sourceUrl && !u.includes("msn.com"));

        if (secondaryUrls.length > 0) {
          console.log(`[Soyunci] Fetching ALL ${secondaryUrls.length} relevant secondary articles in parallel...`);
          // Fetch all in parallel with concurrency limit of 10
          const BATCH_SIZE = 10;
          let secondaryCount = 0;
          for (let i = 0; i < secondaryUrls.length; i += BATCH_SIZE) {
            const batch = secondaryUrls.slice(i, i + BATCH_SIZE);
            const batchResults = await fetchArticlesBatch(batch, BATCH_SIZE);
            for (const article of batchResults) {
              if (article.success && article.bodyText.length > 200) {
                sourceParts.push(`=== SECONDARY SOURCE [${article.title || article.url}] ===`);
                sourceParts.push(article.bodyText);
                sourcesResearched++;
                secondaryCount++;
                console.log(`[Soyunci] Secondary source: ${article.wordCount} words from ${article.url}`);
              } else {
                console.warn(`[Soyunci] Secondary fetch failed: ${article.error ?? 'unknown'} — ${article.url}`);
              }
            }
          }
          console.log(`[Soyunci] ${secondaryCount}/${secondaryUrls.length} secondary articles successfully fetched`);
        } else {
          console.log(`[Soyunci] No relevant secondary sources found for "${title.slice(0, 60)}"`);
        }
      }
    } catch (err) {
      console.warn("[Soyunci] News RSS failed:", err);
    }

    if (sourceParts.length === 0) {
      return {
        context: `Story: ${title}\nSource: ${sourceUrl}\nNo additional sources could be fetched.`,
        sourcesResearched: 0,
        primarySourceText: "",
      };
    }

    const combinedSources = sourceParts.join("\n\n");
    const totalWords = combinedSources.split(/\s+/).length;
    console.log(`[Soyunci] Research complete: ${sourcesResearched} sources, ~${totalWords} words of raw material (no LLM synthesis — passed directly to writer)`);

    // ── No LLM synthesis step — raw sources passed directly to researchAndWrite ──
    // Eliminates one full LLM call per story. The article writer handles raw text fine.
    // Cap at 40,000 chars — Groq llama-3.3-70b has 128k context; use more of it for multi-source stories.
    const context = combinedSources.slice(0, 40000) || `Story: ${title}\nSource: ${sourceUrl}`;
    return { context, sourcesResearched, primarySourceText };
  } catch (err) {
    console.warn("[Soyunci] deepResearch failed:", err);
    return { context: `Story: ${title}\nSource: ${sourceUrl}`, sourcesResearched: 0, primarySourceText: "" };
  }
}

// ── Steps 1+2: Fact Extraction & Angle Detection ──────────────────────────────

async function extractFactsAndAngle(
  title: string,
  primarySourceText: string,
  researchContext: string
): Promise<{ facts: string[]; angle: string }> {
  // Build the source material block — prioritise full primary source text.
  // The RSS snippet is NOT used here; we only work from what we actually read.
  const sourceBlock = primarySourceText.length > 200
    ? `FULL PRIMARY SOURCE ARTICLE (read in full):\n${primarySourceText.slice(0, 8000)}`
    : `(Primary source could not be fetched — working from research brief only)`;

  const response = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are FlightDrama's senior editorial analyst. Your job is to extract every concrete fact from the full source article and research brief, then identify the single strongest viral angle.

CRITICAL RULE: You are working from the FULL TEXT of the original article, not a summary or RSS snippet. Read it carefully. Extract every specific number, name, date, quote, consequence, and piece of context you can find.

VIRAL ANGLES (ranked by reader impact):
1. Death and accountability — deaths, injuries, who is responsible
2. Passenger outrage — passengers stranded, mistreated, lied to
3. Safety failure — near-miss, maintenance failure, pilot error, ATC failure
4. Money / financial scandal — costs, fines, compensation, fraud
5. Pilot or crew pay — strikes, pay cuts, working conditions
6. Historic milestone — first, last, only, biggest, fastest, longest, rarest
7. Rare aircraft — unusual type, retirement, special livery, one-of-a-kind
8. Boeing vs Airbus controversy — defects, groundings, certification failures
9. Human interest / emotion — survivor story, reunion, heroism, tragedy
10. Corporate failure / lawsuit — airline sued, executive fired, cover-up
11. Regulatory conflict — FAA/EASA action, grounding, investigation
12. Nostalgia — retirement, anniversary, last flight
13. Hidden aviation fact — something most people don't know

When choosing an angle, pick the one supported by the STRONGEST specific facts found in the full article text. Do not pick a vague angle when a specific one is supported by evidence.`,
      },
      {
        role: "user",
        content: `STORY TITLE: ${title}

${sourceBlock}

RESEARCH BRIEF (additional context from secondary sources):
${researchContext.slice(0, 8000)}

Extract at least 10 specific facts (numbers, names, dates, quotes, costs, consequences) directly from the source article text above.
Choose the single strongest viral angle that is directly supported by the facts you found.

Return ONLY valid JSON:
{
  "facts": [
    "Exact fact with specific number/name/date/quote",
    "Another specific fact",
    "..."
  ],
  "angle": "the angle name from the list above",
  "angleReason": "one sentence explaining why this angle is the strongest based on the facts"
}`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e > s) {
      const parsed = JSON.parse(raw.slice(s, e + 1)) as { facts: string[]; angle: string; angleReason?: string };
      return {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        angle: parsed.angle ?? "Aviation incident",
      };
    }
  } catch { /* fall through */ }
  return { facts: [], angle: "Aviation incident" };
}

// ── Feedback Learning: load top-rated examples ────────────────────────────────

async function loadFeedbackExamples(): Promise<string> {
  try {
    const db = await getDb();
    if (!db) return "";

    const topRated = await db
      .select({
        article: storyPackages.soyunciArticle,
        soyunciRating: storyPackages.soyunciRating,
        soyunciFeedbackNote: storyPackages.soyunciFeedbackNote,
        viralAngle: storyPackages.viralAngle,
      })
      .from(storyPackages)
      .where(isNotNull(storyPackages.soyunciRating))
      .orderBy(desc(storyPackages.updatedAt))
      .limit(10);

    const amazing = topRated.filter(r => r.soyunciRating === "amazing");
    const good = topRated.filter(r => r.soyunciRating === "good");
    const bad = topRated.filter(r => r.soyunciRating === "bad");

    const lines: string[] = [];
    if (amazing.length > 0) {
      lines.push("=== ARTICLES THE EDITOR LOVED (rating: amazing) ===");
      amazing.slice(0, 3).forEach((r, i) => {
        lines.push(`\nExample ${i + 1} [Angle: ${r.viralAngle ?? "unknown"}]:\n${r.article ?? ""}`);
        if (r.soyunciFeedbackNote) lines.push(`Editor note: "${r.soyunciFeedbackNote}"`);
      });
    }
    if (good.length > 0) {
      lines.push("\n=== ARTICLES THE EDITOR LIKED (rating: good) ===");
      good.slice(0, 2).forEach((r, i) => {
        lines.push(`\nExample ${i + 1} [Angle: ${r.viralAngle ?? "unknown"}]:\n${r.article ?? ""}`);
      });
    }
    if (bad.length > 0) {
      lines.push("\n=== ARTICLES THE EDITOR DID NOT LIKE (rating: bad) — AVOID THESE PATTERNS ===");
      bad.slice(0, 2).forEach((r, i) => {
        lines.push(`\nExample ${i + 1} [Angle: ${r.viralAngle ?? "unknown"}]:\n${r.article ?? ""}`);
        if (r.soyunciFeedbackNote) lines.push(`Editor note: "${r.soyunciFeedbackNote}"`);
      });
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ── Performance Context Builder ─────────────────────────────────────────────

function buildPerformanceContext(perf: PerformanceInsights | null): string {
  if (!perf || perf.postsAnalysed < 3) return "";
  const lines: string[] = ["\n=== WHAT PERFORMS BEST FOR FLIGHTDRAMA (based on real post data) ==="];
  if (perf.topAngles.length > 0) lines.push(`Top viral angles by engagement: ${perf.topAngles.slice(0, 3).join(", ")}`);
  if (perf.topCategories.length > 0) lines.push(`Best performing categories: ${perf.topCategories.slice(0, 3).join(", ")}`);
  if (perf.writingTips.length > 0) {
    lines.push("Writing tips from top posts:");
    perf.writingTips.slice(0, 3).forEach(t => lines.push(`- ${t}`));
  }
  if (perf.summary) lines.push(`Summary: ${perf.summary}`);
  return lines.join("\n");
}

/**
 * Builds a free (no-LLM) writing style context block from the statistical
 * article style analyser. Injected into the Soyunci article writer alongside
 * the LLM-based performance context.
 */
async function buildStyleContext(): Promise<string> {
  try {
    const style = await getArticleStyleInsights();
    if (!style || style.totalArticles < 1) return "";
    const lines: string[] = ["\n=== YOUR WRITING STYLE (learned from your uploaded articles — free, no LLM) ==="];
    if (style.avgSentenceLength > 0) {
      lines.push(`Your average sentence length: ${style.avgSentenceLength} words — match this rhythm.`);
    }
    if (style.topSentenceOpeners.length > 0) {
      lines.push(`Sentence openers you use most: ${style.topSentenceOpeners.slice(0, 8).join(", ")}`);
    }
    if (style.powerWords.length > 0) {
      lines.push(`Power words from your best articles: ${style.powerWords.slice(0, 15).join(", ")}`);
    }
    if (style.avoidWords.length > 0) {
      lines.push(`Words that appear in your weaker articles — avoid: ${style.avoidWords.slice(0, 8).join(", ")}`);
    }
    if (style.topPhrases.length > 0) {
      lines.push(`Common phrases in your articles: ${style.topPhrases.slice(0, 10).join(", ")}`);
    }
    if (style.structuralPatterns.length > 0) {
      lines.push(`Structural patterns in your writing: ${style.structuralPatterns.join(" | ")}`);
    }
    lines.push(`(Learned from ${style.totalArticles} uploaded articles. Upload more to improve accuracy.)`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ── Voice Examples: load editor-curated example articles ────────────────────

async function loadVoiceExamples(): Promise<string> {
  try {
    const examples = await getExampleArticles();
    if (!examples || examples.length === 0) return "";
    const top3 = examples.slice(-3); // most recently added 3
    const lines: string[] = ["=== REAL FLIGHTDRAMA ARTICLES — MATCH THIS VOICE EXACTLY ==="];
    top3.forEach((ex, i) => {
      lines.push(`\nVoice Example ${i + 1} [${ex.label}]:\n${ex.articleText}`);
    });
    lines.push("\n(These are real published articles. Match their tone, sentence rhythm, and style precisely.)");
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ── Step 3: Article Writing ───────────────────────────────────────────────────

async function writeSoyunciArticle(
  title: string,
  primarySourceText: string,
  researchContext: string,
  viralAngle: string,
  extractedFacts: string[],
  feedbackExamples: string,
  performanceContext = ""
): Promise<{ article: string; hashtags: string[] }> {
  // Facts are passed to the headline generator only — NOT to the article writer.
  // Feeding the same facts as both a bullet list AND raw source text causes the LLM
  // to repeat the same information in different sentences (the main repetition bug).
  const factsBlock = extractedFacts.length > 0
    ? `KEY FACTS (extracted from full source article):\n${extractedFacts.map(f => `- ${f}`).join("\n")}`
    : "";
  void factsBlock; // intentionally unused in article prompt — see comment above

  const response = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are an aviation publisher writing for FlightDrama.

You are not a columnist, analyst, television presenter, narrator, or opinion writer. Your job is to present the facts in the most interesting, human way possible — with enough depth that readers feel fully informed.

CORE RULE — FACTS CREATE EMOTION:
Do not create emotion through adjectives. The facts themselves create the emotional reaction. Never tell readers how they should feel.

BANNED WORDS AND PHRASES — never use any of these:
shocking, furious, heated, dramatic, devastating, agonizing, unprecedented, chaotic, powerful reply, slammed shut, sent shockwaves, this raises questions, investigators will undoubtedly focus on, highlighting the impact, underscoring concerns, sparking debate, at the heart of the conflict, tragic reminder, devastating loss, unprecedented move, it's worth noting, in a significant development, this comes as.

INSTEAD OF DRAMATIC WORDING — ALWAYS CHOOSE A STRONGER FACT:
- Instead of "The aviation world was stunned" → write "The aircraft crashed less than two minutes after takeoff."
- Instead of "The exchange became heated" → write the actual quote.
- Instead of "Airlines scrambled" → write "Flights were diverted around Iranian and Iraqi airspace."

SPECIFICITY RULE — always prioritise:
- Exact numbers, exact dates, exact aircraft types, exact routes, exact quotes, exact costs, exact consequences.
- Specific facts outperform vague descriptions every time.

EVERY SENTENCE MUST CONTAIN ONE OF:
1. A new fact not yet mentioned in the article
2. A new consequence not yet mentioned
3. A new quote not yet used
4. A new piece of context not yet introduced
Delete any sentence that does not achieve one of those goals.

NO-REPETITION RULE — the most important rule:
Every sentence must introduce something the previous sentences have not already said.
If two sentences cover the same fact, event, or idea — even in different words — delete the weaker one.
Do not restate the lead in a later sentence. Do not summarise what you just said. Do not circle back.
After drafting, scan every sentence: if it overlaps with any earlier sentence, cut it and replace it with the next unused fact from the source.

FORMAT AND LENGTH:
- Target 120–220 words. This is a social-first Instagram article — tight, punchy, and fact-dense. Every sentence must earn its place. Cut anything that does not add a new fact, quote, or piece of context.
- Never go below 120 words or above 220 words. If you hit 220 words, stop and cut the weakest sentence.
- Flowing prose only. No bullet points, no subheadings, no em dashes.
- Do not open with the airline or aircraft name. Do not open with a date.
- Do not mirror the source article's structure or opening.
- Vary sentence length. Mix short punchy sentences with longer ones that carry context and consequence.
- Naturally weave in the airline name, aircraft type, and location — do not force them into the opening.
- Include at least one direct quote if one is available in the research.
- Include the single most important piece of context that explains WHY this matters.

STRUCTURE (follow this loosely):
1. Lead with the most compelling specific fact — not a vague scene-setter.
2. Establish what happened, when, where, and to whom with exact details.
3. Include the most important consequence, quote, or reaction.
4. Provide context: history, pattern, regulatory background, or comparison.
5. End with the current status or what happens next — NOT a moral conclusion.

BANNED ENDINGS — never end with any of these patterns:
- "This incident highlights..."
- "This raises questions about..."
- "This serves as a reminder..."
- "This underscores the importance of..."
- "This is a stark reminder..."
- Any sentence that begins with "This" and draws a lesson or conclusion.
Instead: end with the latest known fact, the investigation status, or what happens next.

BANNED PADDING — delete these immediately:
- Sentences that restate the headline
- Sentences that say what the article is about rather than stating a fact
- Closing context sentences that explain why aviation safety matters in general
- Any sentence that could be removed without losing a specific fact

VOICE:
Professional but social-first. Clear and conversational. No corporate language. No AI-style filler. No opinionated conclusions. No moralising. No editorialising.
Write like a skilled aviation editor explaining an important story to a friend, not like a TV news presenter narrating a documentary.

VIRAL ANGLE TO BUILD AROUND: ${viralAngle}

${feedbackExamples ? `EXAMPLES OF GREAT FLIGHTDRAMA ARTICLES (learn from these):\n${feedbackExamples}\n` : ""}
${performanceContext}

After the article, generate exactly 3 SEO hashtags on a new line starting with HASHTAGS:`,
      },
      {
        role: "user",
        content: `Write a Soyunci article for this story.

TITLE: ${title}

${primarySourceText.length > 200
  ? `FULL PRIMARY SOURCE ARTICLE (your primary material — read every word, use every useful fact):\n${primarySourceText.slice(0, 10000)}`
  : "(Primary source text unavailable — use research brief only)"}

RESEARCH BRIEF (additional context from secondary sources — use to fill gaps, not to repeat what is already in the source above):
${researchContext.slice(0, 6000)}

Build the article around the viral angle: ${viralAngle}.
Draw facts, quotes, and context directly from the full source article above.
Target 120–220 words. Every sentence must introduce a new fact, consequence, quote, or context that has not appeared earlier in the article.
After drafting, read back through and delete any sentence that repeats or restates something already said.
Start directly with the article text. End with HASHTAGS: #tag1 #tag2 #tag3`,
      },
    ],
  });

  const raw = extractText(response);
  const hashtagMatch = raw.match(/HASHTAGS?:\s*(.+)/i);
  const hashtags = hashtagMatch
    ? hashtagMatch[1].split(/[\s,]+/).map(h => h.startsWith("#") ? h : `#${h}`).filter(h => h.length > 1).slice(0, 3)
    : [];
  const article = raw.replace(/HASHTAGS?:[\s\S]*/i, "").trim().replace(/—/g, ",");
  return { article, hashtags };
}

// ── Step 4: Headlines ─────────────────────────────────────────────────────────

async function generateHeadlines(
  title: string,
  article: string,
  viralAngle: string,
  extractedFacts: string[],
  headlinePatterns: string[] = []
): Promise<{ selected: string; alternatives: string[] }> {
  const factsBlock = extractedFacts.slice(0, 8).map(f => `- ${f}`).join("\n");

  // Load the learned headline style guide from DB (from real performance data)
  let styleGuideBlock = "";
  try {
    const raw = await getScoringConfig("headline_style_guide");
    if (raw) {
      const guide = JSON.parse(raw);
      const patterns = guide.rules?.structural_patterns?.ranked_by_performance ?? [];
      const kills = guide.rules?.what_kills_performance ?? [];
      const wordCount = guide.rules?.word_count;
      const examples = patterns.slice(0, 4).map((p: { pattern: string; examples: string[]; signal: string }) =>
        `  ${p.pattern}: ${p.examples.slice(0, 2).join(" | ")} (${p.signal})`
      ).join("\n");
      // Also include live-learned patterns from the most recent upload/analysis
      const livePatterns: string[] = guide.rules?.live_patterns ?? [];
      const liveAvoid: string[] = guide.rules?.live_avoid ?? [];
      const liveFormatting: string[] = guide.rules?.live_formatting ?? [];
      const livePatternsBlock = livePatterns.length > 0
        ? `\n\nLATEST LIVE PATTERNS (from ${guide.source}):\n${livePatterns.slice(0, 5).map((p: string) => `  ${p}`).join("\n")}`
        : "";
      const liveAvoidBlock = liveAvoid.length > 0
        ? `\n\nLATEST LIVE AVOID:\n${liveAvoid.slice(0, 4).map((p: string) => `  - ${p}`).join("\n")}`
        : "";
      const liveFormattingBlock = liveFormatting.length > 0
        ? `\n\nFORMATTING (live):\n${liveFormatting.slice(0, 4).map((p: string) => `  - ${p}`).join("\n")}`
        : "";

      styleGuideBlock = `

=== FLIGHTDRAMA HEADLINE STYLE GUIDE (learned from ${guide.source}) ===
TARGET LENGTH: ${wordCount?.target} words (${wordCount?.min}–${wordCount?.max} max). Shorter is sharper.

TOP PERFORMING PATTERNS (use these structures):
${examples}

NEVER DO THIS (kills performance):
${kills.slice(0, 4).map((k: string) => `  - ${k}`).join("\n")}

FORMATTING: Title Case. Use exact numerals ($450,000 not words). Dash for contrast: X - Y.${livePatternsBlock}${liveAvoidBlock}${liveFormattingBlock}`;
    }
  } catch { /* style guide unavailable, proceed without */ }

  const patternsBlock = headlinePatterns.length > 0
    ? `\nADDITIONAL PATTERNS FROM PERFORMANCE ANALYSIS:\n${headlinePatterns.slice(0, 3).map(p => `- ${p}`).join("\n")}`
    : "";

  const response = await invokeLLM({
    model: HEADLINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are Soyunci, the headline editor for Flightdrama.

Your job is not to write aviation headlines.

Your job is to write the exact kind of aviation headlines that generate clicks, comments, shares, saves, and debate on Flightdrama.

You are competing against every post in a user's feed. If a headline looks like aviation trade journalism, airline PR, corporate communications, or a newswire headline, it has failed.

Your goal is to make readers stop scrolling while remaining completely factual and credible.

FLIGHTDRAMA CORE RULE

The fact itself must be the story.

Do not make people click to discover why something matters.

The headline should already contain the reason people care.

Bad: Airbus Completes A350 Milestone
Good: The Airbus A350 Just Flew 9,700 Miles Nonstop, No Boeing Jet Comes Close

Bad: Boeing Delivers More Aircraft
Good: Boeing Delivered 44 Jets In November As Airbus Pulled Further Ahead

Bad: Airline Expands Network
Good: The World's Longest Flight Will Launch From The UK In 2027

FLIGHTDRAMA VIRAL ANGLE ANALYSIS

Before writing a single headline, identify the strongest viral angle. Choose the strongest one first:

Passenger outrage, Unfairness, Safety failure, Near-disaster, Death, Accountability, Corporate failure, Hidden truth, Shocking money, Pilot pay, Crew pay, Passenger rules, Airport rules, Boeing vs Airbus, Military aviation, Weird passenger behaviour, Rare event, History, Nostalgia, Finality, Old aircraft still flying, Aircraft nobody wanted, Aircraft that failed commercially, Biggest, Fastest, Longest, Oldest, First, Last, Only, Aviation mystery, Human story, Social debate, Public policy, Travel frustration

If multiple angles exist, prioritize the one most likely to generate comments and shares.

NON-AVIATION TEST

Before choosing the final headlines ask: Why would somebody who does not care about aviation care about this story?

If you cannot answer that question, find a stronger angle.

Many aviation stories are actually about: Money, Jobs, Safety, Death, Fairness, Government decisions, Travel pain, Human achievement, Corporate mistakes. Use those angles.

THE FACTUAL WEAPON RULE

Extract the strongest factual weapon available. Always look for:
Deaths, Money, Salary, Aircraft age, Passenger numbers, Distance, Altitude, Speed, Flight time, Route length, Aircraft type, Year, Date, Percentage, Rankings, Records, First, Last, Only, Biggest, Fastest, Oldest, Longest

Whenever possible, place the strongest number directly in the headline.

FLIGHTDRAMA WINNING HEADLINE STRUCTURES

CONTRADICTION
"American Made $54.6 Billion In Revenue And Barely $111 Million In Profit"
"251 Deliveries Later, The A380 Still Couldn't Break Even"
"Once $400M New, You Can Now Buy An A380 For $21M"

HIDDEN TRUTH
"The Boeing 777's Engines Are Massive Because Two Had To Do The Job Of Four"
"Why Quadjets Never Worked For U.S. Airlines"
"The Oxygen Masks That Drop In Airliners Are Not Meant To Keep You Alive For Long"

HUMAN UNFAIRNESS
"United Sold Gayle King A Window Seat That Had No Window And She Filmed It"
"Flight Attendants Are Expected To Work Before They're Paid. This Is Legal"
"American Airlines Could Keep Most Of Your Money Even If You Downgrade"

DANGER + CONSEQUENCE
"Aer Lingus A321XLR Hit The Runway At 3.3G, Now It's Grounded"
"67 Dead And The System Now Admits It Failed"
"After 260 Deaths, A Boeing Whistleblower Says Investigators Are Looking In The Wrong Place"

AGE SHOCK
"Built In 1991, The UPS Jet That Crashed Was Older Than Many Of Its Pilots"
"The Oldest 747 Still Flying Passengers Is Over 35 Years Old"
"Built In 1989, Delta's Oldest Jet Is Still Flying Passengers"

FIRST / LAST / ONLY
"The Last DC-8 In America Has Flown Its Final Flight"
"The World's Longest Flight Will Launch From The UK In 2027"
"United Retires The World's First Boeing 777"

MONEY ARGUMENT
"Delta's Top Pilots Now Earn Nearly $465 An Hour"
"American Airlines Pilots Can Make $450,000 A Year"
"Qantas Captains Flying A380s Make $500,000 A Year"

SOCIAL DEBATE
"Should Airline Pilots Really Be Paid More Than Surgeons?"
"Southwest Will Require Plus-Size Passengers To Pay For A Second Seat"
"Washington Draws A Line: Airlines Must Keep Two Pilots In The Cockpit"

WEIRD / SHAREABLE
"A Passenger Wouldn't Stop Farting, So Crew Handed Out Masks"
"Man Eats His Passport On Ryanair Flight From Milan To London"
"Customs Opened A Bag In Mumbai And Found 16 Live Snakes Inside"

NOSTALGIA / FINALITY
"The Last DC-8 In America Has Flown Its Final Flight"
"United Retires The World's First Boeing 777"
"The First Jumbo Jets Are Almost Gone, Just Four 747-100s Survive"

FLIGHTDRAMA DATASET LESSONS

The highest-performing Flightdrama headlines consistently involve: Numbers, Money, Death, Passenger outrage, Pilot pay, Crew pay, Travel frustrations, Rare aviation facts, Aircraft age, Big records, Hidden truths, Final flights, Industry contradictions, Public arguments, Boeing vs Airbus, Human stories.

If a headline contains none of these, it is probably weak.

AVOID THESE HEADLINES

Do not write: Airline launches route, Carrier expands network, Airbus secures order, Boeing receives approval, Aircraft completes milestone, Fleet modernization continues, Airline announces plans, Company provides update.

Instead ask: Why does this matter? Who wins? Who loses? Who gets angry? Who benefits? What number is surprising? What contradiction exists?

HEADLINE DIVERSITY RULE

The 10 headlines must not simply be rewrites. Generate:
2 contradiction headlines
2 human-focused headlines
2 money/debate headlines
2 fact-driven headlines
2 experimental/viral-angle headlines

Each headline should attack the story from a different perspective.

FLIGHTDRAMA WINNER FILTER

Before ranking, reject any headline that fails at least two of these tests:
Contains a strong number, Contains a contradiction, Contains money, Contains danger, Contains outrage, Contains accountability, Contains a hidden truth, Contains a strong human element, Creates debate, Would make a non-aviation person stop scrolling, Can be understood without opening the article, Feels shareable, Feels comment-worthy, Feels save-worthy.

RANKING SYSTEM

Rank each headline based on: Comment potential, Share potential, Save potential, View potential, Flightdrama fit, Risk of being boring.

When selecting a winner, prioritize comment potential and share potential over pure views.

TONE RULES

Be factual. Be credible. Be direct. Do not exaggerate. Do not invent drama. Do not use vague hype.

Do not use empty words like: Massive, Huge, Shocking, Terrifying, Game-changing, Groundbreaking — unless genuinely justified.

The fact itself should create the emotion.${styleGuideBlock}${patternsBlock}`,
      },
      {
        role: "user",
        content: `Write headlines for this story.

ORIGINAL TITLE: ${title}
VIRAL ANGLE: ${viralAngle}
KEY FACTS:\n${factsBlock}
ARTICLE: ${article.slice(0, 600)}

Return ONLY valid JSON with your best headline and 3 strong alternatives:
{
  "recommended": "the single best headline — most viral but still credible",
  "alternatives": ["alt 1", "alt 2", "alt 3"]
}`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e > s) {
      const parsed = JSON.parse(raw.slice(s, e + 1)) as { recommended: string; alternatives: string[] };
      return {
        selected: parsed.recommended ?? title,
        alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : [],
      };
    }
  } catch { /* fall through */ }
  return { selected: title, alternatives: [] };
}

// ── Step 5: Image Recommendations ────────────────────────────────────────────

/**
 * Build a photorealistic image generation prompt from aircraft type, airline livery, and story angle.
 * Used as the primary hero image source — AI-generated images are copyright-free.
 */
async function buildAIImagePrompt(
  title: string,
  viralAngle: string,
  aircraftQuery: string
): Promise<string> {
  const res = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a prompt engineer for a professional aviation photography AI. Write a single image generation prompt that will produce a stunning, high-resolution, photorealistic aviation photograph suitable for editorial publication.

A reference image may be provided alongside this prompt. Use it ONLY to understand the aircraft type, shape, and airline livery colours — do NOT copy or reproduce it. The output must be an entirely original, freshly composed photograph.

Your prompt must:
- Specify the exact aircraft type and airline livery (colours, tail logo style) precisely
- Describe a compelling, dynamic composition: dramatic lighting, interesting angle (low-angle ground shot, wing-tip perspective, final approach, etc.)
- Include environmental detail: golden hour light, overcast drama, heat shimmer on tarmac, etc.
- Aim for ultra-sharp, high-resolution editorial quality — like a shot from a professional aviation photographer
- Keep the prompt under 80 words
- Do NOT mention text overlays, watermarks, or logos

Output only the prompt text, nothing else.`,
      },
      {
        role: "user",
        content: `Story: "${title}"\nViral angle: "${viralAngle}"\nAircraft/subject: ${aircraftQuery}`,
      },
    ],
  });
  const content = res.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : `Photorealistic aviation photograph: ${aircraftQuery}, ${viralAngle}`;
}

async function researchImages(
  title: string,
  article: string,
  viralAngle: string
): Promise<{ recs: ImageRecommendation[]; candidates: Record<string, ImageRecommendation[]> }> {
  // Build targeted search queries from the story content
  const { aircraftQuery, contextQuery, aircraftAltQueries, contextAltQueries } = await buildImageQueries(title, article, viralAngle);

  console.log(`[Soyunci] Image search — aircraft: "${aircraftQuery}" | context: "${contextQuery}"`);

  // ── Step 1: Fetch Wikimedia aircraft images first so we can use the best one
  // as a visual reference for AI generation (exact livery, markings, variant)
  const [aircraftImages, contextImages] = await Promise.all([
    searchImages(aircraftQuery, 8, true, title),
    searchImages(contextQuery, 8, false, title),
  ]);

  // Best Wikimedia aircraft photo — used as reference image for AI generation
  // We prefer the first result (highest relevance score) from Wikimedia specifically
  const wikiReferenceImage = aircraftImages.find(img => img.source === "wikimedia");
  if (wikiReferenceImage) {
    console.log(`[Soyunci] Using Wikimedia reference image for AI generation: ${wikiReferenceImage.title}`);
  }

  // ── Step 2: AI image generation disabled — using Wikimedia/Pexels only ───────
  // AI image generation has been disabled to eliminate Manus credit usage.
  // Wikimedia Commons provides exact aircraft photos (real livery, real registration)
  // which are higher quality than AI-generated images for aviation content.
  let aiGeneratedUrl: string | undefined;
  let aiPromptUsedForGeneration: string | undefined;
  console.log(`[Soyunci] Using Wikimedia/Pexels photos (AI generation disabled)`);

  // Generate precise visual briefs for both slots in parallel
  const [aircraftBrief, contextBrief] = await Promise.all([
    generateTextImageRec(title, viralAngle, aircraftQuery, "aircraft"),
    generateTextImageRec(title, viralAngle, contextQuery, "context"),
  ]);

  const toRec = (img: FoundImage, role: "aircraft" | "context", whyItFits: string, query?: string): ImageRecommendation => ({
    // title = raw image filename — most specific identifier (e.g. "Boeing 737-800 Southwest Airlines N8301J")
    title: img.title,
    // Use the actual image description when available, fall back to title
    description: img.description ? `${img.title} — ${img.description}` : img.title,
    source: img.source === "wikimedia" ? "Wikimedia Commons" : img.source === "pexels" ? "Pexels" : "Unsplash",
    licence: img.licence,
    attributionRequired: img.source === "wikimedia" ? "Yes" : "No",
    copyrightRisk: "Low",
    whyItFits,
    canvaUse: role === "aircraft" ? "Use as the main hero image — crop to 4:5 for Instagram" : "Use as background or secondary visual element",
    imageUrl: img.url,
    thumbUrl: img.thumbUrl,
    pageUrl: img.pageUrl,
    attribution: img.attribution,
    imageSource: img.source,
    role,
    searchQuery: query,
    altQueries: role === "aircraft" ? aircraftAltQueries : contextAltQueries,
  });

  const results: ImageRecommendation[] = [];

  // Slot 1: AI-generated image as primary hero (copyright-free, photorealistic)
  // Fall back to best Wikimedia/Pexels aircraft photo if AI generation fails
  if (aiGeneratedUrl) {
    // Use the prompt that was actually sent to the model (already computed above)
    const aiPromptUsed = aiPromptUsedForGeneration ?? aircraftBrief;
    const refNote = wikiReferenceImage ? ` (reference: ${wikiReferenceImage.title})` : "";
    results.push({
      description: `AI-generated${refNote}: ${aircraftBrief}`,
      source: "AI Generated",
      licence: "AI Generated — no attribution required",
      attributionRequired: "No",
      copyrightRisk: "None",
      whyItFits: wikiReferenceImage
        ? `Generated using Wikimedia photo of ${wikiReferenceImage.title} as livery reference`
        : aircraftBrief,
      canvaUse: "Use as the main hero image — crop to 4:5 for Instagram",
      imageUrl: aiGeneratedUrl,
      thumbUrl: aiGeneratedUrl,
      pageUrl: "",
      attribution: "AI Generated",
      imageSource: "ai-generated",
      role: "aircraft",
      aiPrompt: aiPromptUsed,
    } as any);
  } else if (aircraftImages[0]) {
    results.push(toRec(aircraftImages[0], "aircraft", aircraftBrief, aircraftQuery));
  } else {
    results.push({
      description: aircraftBrief,
      source: "Wikimedia Commons",
      licence: "CC BY-SA",
      attributionRequired: "Yes",
      copyrightRisk: "Low",
      whyItFits: `Ideal photo: ${aircraftBrief} — search Wikimedia Commons manually`,
      canvaUse: "Use as the main hero image — crop to 4:5 for Instagram",
      pageUrl: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(aircraftQuery)}&ns6=1`,
      role: "aircraft",
      imageSource: "text-rec",
      searchQuery: aircraftQuery,
      altQueries: aircraftAltQueries,
    } as any);
  }

  // Slot 2: best context/atmosphere photo — with precise visual brief
  if (contextImages[0]) {
    results.push(toRec(contextImages[0], "context", contextBrief, contextQuery));
  } else {
    results.push({
      description: contextBrief,
      source: "Wikimedia Commons",
      licence: "CC BY-SA",
      attributionRequired: "Yes",
      copyrightRisk: "Low",
      whyItFits: `Ideal photo: ${contextBrief} — search Pexels or Wikimedia manually`,
      canvaUse: "Use as background or secondary visual element",
      pageUrl: `https://www.pexels.com/search/${encodeURIComponent(contextQuery)}/`,
      role: "context",
      imageSource: "text-rec",
      searchQuery: contextQuery,
      altQueries: contextAltQueries,
    } as any);
  }

  // Build candidates map per slot:
  // Slot 0 (aircraft hero): remaining aircraft images starting from index 1
  //   but skip index 1 if it was already used as slot 2
  const slot2UsedAircraftIdx1 = !!aircraftImages[1];
  const candidates: Record<string, ImageRecommendation[]> = {
    "0": aircraftImages.slice(slot2UsedAircraftIdx1 ? 2 : 1).map(img => toRec(img, "aircraft", "Alternative aircraft photo", aircraftQuery)),
    "1": contextImages.slice(1).map(img => toRec(img, "context", "Alternative context photo", contextQuery)),
    "2": slot2UsedAircraftIdx1
      ? aircraftImages.slice(2).map(img => toRec(img, "aircraft", "Alternative aircraft photo"))
      : aircraftImages.slice(1).map(img => toRec(img, "aircraft", "Alternative aircraft photo")),
  };

  return { recs: results, candidates };
}

// ── Canva Brief ───────────────────────────────────────────────────────────────

async function generateCanvaBrief(
  article: string,
  headline: string,
  viralAngle: string
): Promise<CanvaBrief> {
  const response = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are FlightDrama's creative director. Create precise, actionable Canva briefs for aviation social media posts. Always respond in the exact format requested.`,
      },
      {
        role: "user",
        content: `Create a Canva visual brief for this story.

HEADLINE: ${headline}
VIRAL ANGLE: ${viralAngle}
ARTICLE: ${article.slice(0, 600)}

OUTPUT FORMAT (one line per field, no extra text):
HEADLINE FOR POSTER: [max 10 words]
ASPECT RATIO: [1:1 or 4:5]
MAIN VISUAL IDEA: [specific hero image description]
AIRCRAFT TO SHOW: [specific type and livery, or None]
CIRCLE INSERT: [small inset image idea, or None]
MOOD: [one word]
BACKGROUND: [specific background description]
VISUAL HIERARCHY: [text and image arrangement]`,
      },
    ],
  });

  const raw = extractText(response);
  const get = (key: string): string => {
    const m = raw.match(new RegExp(`${key}:\\s*(.+)`, "i"));
    return m ? m[1].trim() : "";
  };
  return {
    headline: get("HEADLINE FOR POSTER") || headline.slice(0, 80),
    aspectRatio: get("ASPECT RATIO") || "1:1",
    visualIdea: get("MAIN VISUAL IDEA") || "",
    aircraftToShow: get("AIRCRAFT TO SHOW") || "",
    circleInsert: get("CIRCLE INSERT") || "None",
    mood: get("MOOD") || "dramatic",
    background: get("BACKGROUND") || "",
    hierarchy: get("VISUAL HIERARCHY") || "",
  };
}

// ── Optimised 2-Call Pipeline Core ───────────────────────────────────────────
/**
 * STEP A — Fact Matrix Extraction (token-efficient, no writing).
 *
 * Reads the full primary source + research brief and produces a clean,
 * structured fact matrix. This step is intentionally cheap:
 *   • Input: raw source text (capped at 18,000 chars) + research brief (8,000 chars)
 *   • Output: compact JSON fact matrix (~400-700 tokens output)
 *   • No article writing happens here — zero wasted tokens on prose
 *
 * The fact matrix is then passed to STEP B as the ONLY source of truth,
 * preventing the writer from hallucinating or ignoring buried context.
 */
async function extractFactMatrix(
  title: string,
  primarySourceText: string,
  researchContext: string,
  sourcesResearched: number
): Promise<{
  facts: string[];
  angle: string;
  primaryStory: string;
  timeline: string;
  keyEntities: string;
  directQuotes: string[];
  consequences: string;
  backgroundContext: string;
}> {
  const sourceBlock = primarySourceText.length > 200
    ? `FULL PRIMARY SOURCE (read every word):\n${primarySourceText.slice(0, 24000)}`
    : `(Primary source unavailable — use research brief only)`;

  const response = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a senior aviation news analyst. Your job is to identify the ONE primary story and extract only the facts that support it.

STEP 1 — IDENTIFY THE PRIMARY STORY FIRST.
Before extracting any facts, ask: "If this source contains multiple threads, which single one is the most interesting story?"
A source may mention financial results, safety, acquisitions, and fleet changes. Choose ONE. The others are background noise.
The primary story is the one a reader would find most surprising, most consequential, or most worth sharing.
Write it as a single sentence in the "primaryStory" field.

STEP 2 — EXTRACT FACTS THAT SUPPORT ONLY THAT STORY.
Do not list facts from secondary threads unless they directly explain or support the primary story.
Every fact must be specific: a number, a date, a name, a location, an aircraft registration, a cost, a consequence.
No vague statements. No "some critics say" without naming who and when.

STEP 3 — EXTRACT SUPPORTING ELEMENTS:
- TIMELINE: Chronological sequence of events for the primary story only
- KEY ENTITIES: Airlines, airports, aircraft types, regulators, officials directly involved
- DIRECT QUOTES: Verbatim quotes only — include speaker name and role. If a quote is vague or unattributed, exclude it.
- CONSEQUENCES: What actually happened as a result — injuries, deaths, groundings, investigations, fines, lawsuits
- BACKGROUND: Only context that directly explains why the primary story matters
- VIRAL ANGLE: The single strongest angle from: death_accountability | passenger_outrage | safety_failure | money_scandal | pilot_crew_pay | historic_milestone | rare_aircraft | boeing_airbus_controversy | human_interest | corporate_failure | regulatory_conflict | nostalgia | hidden_fact`,
      },
      {
        role: "user",
        content: `STORY: ${title}\n\n${sourceBlock}\n\nADDITIONAL SOURCES (${sourcesResearched} total — read all of them):\n${researchContext.slice(0, 16000)}\n\nIMPORTANT: Before listing facts, identify the ONE primary story. If the source contains multiple threads (e.g. financial performance + safety + acquisition), choose the single most interesting one. The "angle" field must reflect that primary story. Facts from secondary threads should only appear if they directly support the primary story.\n\nReturn ONLY valid JSON:\n{\n  "facts": ["exact fact with number/name/date — primary story only", ...],\n  "angle": "angle_name",\n  "primaryStory": "one sentence: what is the actual story?",\n  "timeline": "chronological sequence as a single paragraph",\n  "keyEntities": "comma-separated list of airlines, airports, aircraft, people",\n  "directQuotes": ["verbatim quote — Source Name", ...],\n  "consequences": "what happened as a result",\n  "backgroundContext": "relevant history or context that supports the primary story only"\n}`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e > s) {
      const parsed = JSON.parse(raw.slice(s, e + 1)) as {
        facts: string[]; angle: string; primaryStory: string; timeline: string; keyEntities: string;
        directQuotes: string[]; consequences: string; backgroundContext: string;
      };
      return {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        angle: parsed.angle ?? "Aviation incident",
        primaryStory: parsed.primaryStory ?? "",
        timeline: parsed.timeline ?? "",
        keyEntities: parsed.keyEntities ?? "",
        directQuotes: Array.isArray(parsed.directQuotes) ? parsed.directQuotes : [],
        consequences: parsed.consequences ?? "",
        backgroundContext: parsed.backgroundContext ?? "",
      };
    }
  } catch { /* fall through */ }
  return { facts: [], angle: "Aviation incident", primaryStory: "", timeline: "", keyEntities: "", directQuotes: [], consequences: "", backgroundContext: "" };
}

/**
 * STEP B — Article Writing from Fact Matrix (token-efficient, no raw source text).
 *
 * Receives ONLY the clean fact matrix from Step A — NOT the raw source text.
 * This means:
 *   • The writer cannot miss buried facts (they were already extracted)
 *   • The writer cannot hallucinate (it only has verified facts)
 *   • Input tokens are minimal (~2,000-3,500 chars of structured facts)
 *   • The writer focuses 100% on voice, structure, and impact
 *
 * This is the key architectural change: separate knowing from writing.
 */
async function writeFromFactMatrix(
  title: string,
  factMatrix: {
    facts: string[];
    angle: string;
    timeline: string;
    keyEntities: string;
    directQuotes: string[];
    consequences: string;
    backgroundContext: string;
  },
  feedbackExamples: string,
  voiceExamples: string,
  perfContext: string,
  editorFeedback?: EditorReview
): Promise<{ article: string; hashtags: string[]; seoTitle: string; seoDescription: string }> {
  const examplesBlock = [voiceExamples, feedbackExamples].filter(Boolean).join("\n\n");

  // Build a compact, structured brief from the fact matrix
  // primaryStory goes FIRST — it is the editorial decision the writer must build around
  const factsBrief = [
    factMatrix.primaryStory ? `THE STORY (build the entire article around this one sentence):\n${factMatrix.primaryStory}` : "",
    factMatrix.facts.length > 0 ? `FACTS (primary story only — do not introduce unrelated threads):\n${factMatrix.facts.map(f => `- ${f}`).join("\n")}` : "",
    factMatrix.timeline ? `TIMELINE:\n${factMatrix.timeline}` : "",
    factMatrix.keyEntities ? `KEY ENTITIES: ${factMatrix.keyEntities}` : "",
    factMatrix.directQuotes.length > 0 ? `DIRECT QUOTES (use these — they make the article credible):\n${factMatrix.directQuotes.map(q => `- "${q}"`).join("\n")}` : "",
    factMatrix.consequences ? `CONSEQUENCES:\n${factMatrix.consequences}` : "",
    factMatrix.backgroundContext ? `BACKGROUND (only use if it supports the primary story):\n${factMatrix.backgroundContext}` : "",
  ].filter(Boolean).join("\n\n");

  const response = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are the lead writer for FlightDrama, an aviation news account with a reputation for telling stories that make readers think: "I didn't know that."

Write like a journalist, not a summariser.

Before writing, answer one question: "What is the actual story?" Build the entire article around that answer.

Lead with the most interesting fact, consequence, contradiction, conflict, surprise, or unusual detail. Do not treat every fact from the source as equally important. Most facts are background. One or two facts are the story. Find them.

Do not simply tell readers what happened. Explain why it is interesting.

YOU ARE AN AVIATION EXPERT. Use everything you know.
You have deep knowledge of: aircraft types and their characteristics, airline economics and business models, load factors and what is normal vs exceptional, fleet strategy and aircraft orders, aviation regulators (FAA, EASA, NTSB, CAA, AAIB), accident investigation procedures, pilot unions and labour disputes, passenger rights regulations, airport operations, maintenance requirements, historical incidents and precedents, and how the industry has changed over time.

This knowledge is your most valuable tool. A fact from the source becomes a story when you add the context that explains why it matters. If the source says Delta sold 87% of first-class seats, you know that a decade ago airlines routinely gave those seats away as upgrades rather than selling them — that context is what makes the number interesting. Use it. If a Boeing 737 MAX is mentioned, you know its history. If an airline posts a 15% margin, you know what typical margins look like. If a regulator issues an airworthiness directive, you know what that means operationally.

The rule: you may use your aviation knowledge to add context, historical comparison, industry norms, and significance. You may NOT invent facts, fabricate quotes, or claim causation the source does not support.

CONTENT TYPE CHECK — do this before anything else:
Identify what type of content the source is:
- Breaking news / incident report: write the article normally
- Press release / company announcement: find the single most newsworthy fact and lead with that. Ignore the PR framing.
- Analysis / opinion piece: find the concrete fact or development being discussed and report that
- Listicle / ranking / "best of" / travel guide / product review: DO NOT write a news article about the list. Either find the single most newsworthy item within it (e.g. "One of America's largest indoor water parks is getting an $85 million expansion") and write about that specific item only, or if there is no genuinely newsworthy individual item, write a brief 2-paragraph note on the most interesting single entry. Never summarise the list.
- Earnings report / financial results: find the single most surprising or significant number and build the article around what that number means, not around the report itself.

SINGLE STORY DISCIPLINE — the most important rule:
The fact matrix contains ONE primary story. Build the entire article around it. Do not introduce a second thread, a second topic, or a second angle. If the facts mention financial results AND safety AND an acquisition, pick ONE and ignore the others entirely. A 180-word article cannot cover three stories. It can cover one story well. Choose the most interesting one and own it completely.

ANTI-REPETITION — the clearest AI tell:
Before you finalise the article, read it back sentence by sentence and ask: does this sentence say something already said in a previous sentence? If yes, cut it. No exceptions.
Each paragraph has ONE job:
- Paragraph 1: Deliver the story. The reader must know what happened and why it is interesting by the end of this paragraph.
- Paragraph 2: Add something the reader did not know from paragraph 1. A new consequence. New context. A direct quote. A new fact. If paragraph 2 is just paragraph 1 reworded, it fails its job and must be rewritten or cut entirely.
- Paragraph 3: Move the story forward. What happens next, what is under investigation, what the lasting consequence is. End on a fact, not a summary of what you just wrote.
If you catch yourself writing the same idea twice in different words, stop. Cut one. A repeated idea is worse than a missing one. Repetition is the single clearest sign that an AI wrote this, not a journalist.

EDITORIAL RULES — non-negotiable:
- Write like a human journalist, not an AI summariser. Natural, confident, direct.
- Do not restate the headline in the opening sentence.
- Do not open with the airline name, aircraft type, or a date.
- Avoid generic conclusions, corporate language, marketing copy, and filler.
- If a sentence could be removed without changing the reader's understanding of the story, remove it.
- If there is a contradiction, lead with it. If there is a consequence, explain it. If there is a surprise, surface it.
- Every paragraph must either: advance the story, add important context, explain why the story matters, or teach the reader something new. If a paragraph does none of these, cut it.
- NEVER tell readers something is important. SHOW them why it is important. The difference: "This is a significant development" tells. "Air France-KLM is set to take a majority stake in SAS less than two years after helping rescue it from bankruptcy" shows. Always show.
- NEVER make predictions or assumptions about future outcomes unless the source explicitly states them. Do not write "will enable," "will play a crucial role," "expected to have a lasting impact," or any other forward-looking claim the source does not support. Report what has happened, not what you think will happen.
- NEVER stack facts. If a paragraph mentions more than two airlines, two aircraft types, or two separate developments, it is fact-stacking, not storytelling. Pick the most important one and build around it.

FACTUAL DISCIPLINE — the hardest rule to follow, the most important:
- NEVER claim something is historic, unprecedented, industry-changing, shocking, revolutionary, game-changing, or widely influential unless the source explicitly provides evidence for that claim. If the source does not say it, you cannot say it.
- NEVER assume causation. If the source says Delta sold 87% of first-class seats, you cannot write "Delta's success can be attributed to strategic pricing and marketing" unless the source or an analyst explicitly said that. You do not know why. Do not invent reasons.
- NEVER manufacture drama. The facts are interesting enough. Your job is to explain why they are interesting, not to add hype on top of them. "Sent shockwaves," "altered the landscape," "executives scrambled," "the industry was left reeling" — these are movie-trailer phrases. They are not journalism. Cut every single one.
- NEVER write a sentence that could be pasted into an article about a completely different company and still make sense. If a sentence is that generic, it adds nothing and must be cut.
- The interesting fact is already interesting. Explain it. Do not dress it up.

FORMAT RULES — non-negotiable:
- Write in PARAGRAPHS. Minimum 2 paragraphs, ideally 3. Each paragraph is 2-4 sentences.
- Separate paragraphs with a blank line (double newline \\n\\n between paragraphs).
- NEVER use bullet points, numbered lists, subheadings, or dashes as separators.
- NEVER list facts one after another like a bullet list in sentence form. Weave facts together into flowing narrative. Connect them with cause, consequence, contrast, or context.
- NEVER use em dashes (—). If you need a pause, use a comma or a full stop.
- NEVER use the words or phrases: shocking, furious, dramatic, devastating, unprecedented, chaotic, sparking debate, sending shockwaves, altered the landscape, far-reaching implications, push the boundaries, game-changing, industry-changing, widely influential, executives scrambled, the industry was left reeling, it is worth noting, in a significant development, highlighting the importance of, underscoring concerns, this raises questions, this serves as a reminder, reassessing strategies, reimagining the future, poised, crucial, noteworthy, lasting impact, will enable, will play a key role, expected to have, significant milestone, important development, major implications.
- NEVER end with a lesson, moral, or "This highlights..." sentence.
- No passive voice where active is possible.
- TARGET: 140-200 words. For a brief factual statement with limited context, 120 words is acceptable. Never exceed 200 words.

VOICE RULES:
- Lead with the single most compelling specific fact: a number, a quote, a consequence, a record, or a contradiction.
- Every sentence must introduce something new.
- Use direct quotes when available. A real quote makes the article feel alive and credible.
- Vary sentence length. Short sentences land hard. Longer sentences carry weight and context.
- Write like you are explaining an important story to a smart friend who follows aviation closely.

STRUCTURE (3 paragraphs, 140-200 words total):
Paragraph 1 (2-3 sentences): The hook. Lead with the most interesting angle, not the most obvious one. Establish what happened, when, where, and to whom.
Paragraph 2 (2-4 sentences): Build the full picture. Weave in consequences, context, quotes, and background. Connect facts, do not list them. Each sentence flows from the one before it.
Paragraph 3 (2-3 sentences): What happens next, the investigation status, or the most striking remaining consequence. End on a fact, not a conclusion.

SEO RULES:
- After the article, produce a SEO_TITLE (55-60 characters, includes primary keyword, no clickbait)
- Produce a SEO_DESCRIPTION (140-160 characters, factual summary, includes airline/aircraft/location)

${examplesBlock ? `VOICE EXAMPLES — match this style exactly:\n${examplesBlock.slice(0, 2500)}\n` : ""}
${perfContext ? `${perfContext}\n` : ""}`,
      },
      {
        role: "user",
        content: [
          `STORY: ${title}`,
          `VIRAL ANGLE: ${factMatrix.angle}`,
          ``,
          factsBrief,
          ``,
          editorFeedback ? [
            `EDITOR FEEDBACK FROM PREVIOUS DRAFT (fix these specific issues):`,
            `- Story Angle Identified: ${editorFeedback.storyAngle}`,
            `- Biggest Weakness: ${editorFeedback.biggestWeakness}`,
            `- Missing Context: ${editorFeedback.missingContext}`,
            editorFeedback.fillerSentences.length > 0
              ? `- Filler to Remove: ${editorFeedback.fillerSentences.join(" | ")}`
              : "",
            ``,
            `Address every one of these weaknesses in your rewrite. Do not repeat the same mistakes.`,
          ].filter(Boolean).join("\n") : "",
          `Write the article now. 140-200 words total. Output format — plain text, no JSON, no markdown:`,
          ``,
          `[Paragraph 1]`,
          ``,
          `[Paragraph 2]`,
          ``,
          `[Paragraph 3]`,
          ``,
          `HASHTAGS: #tag1 #tag2 #tag3`,
          `SEO_TITLE: [55-60 char title]`,
          `SEO_DESCRIPTION: [140-160 char description]`,
        ].filter(s => s !== undefined).join("\n"),
      },
    ],
  });

  const raw = extractText(response);

  // Extract hashtags
  const hashtagMatch = raw.match(/HASHTAGS?:\s*(.+)/i);
  const hashtags = hashtagMatch
    ? hashtagMatch[1].split(/[\s,]+/).map(h => h.startsWith("#") ? h : `#${h}`).filter(h => h.length > 1).slice(0, 3)
    : [];

  // Extract SEO fields
  const seoTitleMatch = raw.match(/SEO_TITLE:\s*(.+)/i);
  const seoDescMatch = raw.match(/SEO_DESCRIPTION:\s*(.+)/i);
  const seoTitle = seoTitleMatch ? seoTitleMatch[1].trim() : title.slice(0, 60);
  const seoDescription = seoDescMatch ? seoDescMatch[1].trim() : "";

  // Extract article: everything before HASHTAGS line, strip any JSON leakage
  let article = raw
    .replace(/HASHTAGS?:[\s\S]*/i, "")  // remove hashtags and everything after
    .replace(/SEO_TITLE:[\s\S]*/i, "")   // remove SEO fields if they appear before hashtags
    .replace(/```[\s\S]*?```/g, "")       // strip any code blocks (JSON leakage)
    .replace(/^\s*\{[\s\S]*\}\s*$/m, "") // strip bare JSON objects
    .replace(/—/g, ",")                   // replace em dashes with commas
    .replace(/–/g, ",")                   // replace en dashes too
    .trim();

  // Ensure paragraphs are separated by double newlines
  // Collapse 3+ newlines to 2, ensure single newlines between sentences become spaces
  article = article
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { article, hashtags, seoTitle, seoDescription };
}

/**
 * Step C: FlightDrama Editor quality gate.
 *
 * Reviews the completed article against 10 editorial criteria.
 * Returns a structured review with score and verdict.
 * If score < 7, the pipeline triggers a targeted rewrite.
 *
 * Token cost: ~800 input tokens, ~300 output tokens per review.
 * Only runs once per article (twice if a rewrite is triggered).
 */
async function runEditorReview(
  title: string,
  article: string,
  angle: string
): Promise<EditorReview> {
  const response = await invokeLLM({
    model: PIPELINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are the FlightDrama Editor. Your job is to review completed articles before they are approved for publication.

You do not rewrite the article. You identify weaknesses with precision.

Review the article against these 10 questions:
1. What is the story in one sentence?
2. Is the article built around that story, or does it drift?
3. What is the most interesting angle available in this story?
4. Is that angle introduced in the first paragraph, or is it buried?
5. Does every paragraph add new information not already stated?
6. Does any paragraph repeat information from a previous paragraph?
7. Is there any corporate PR language, marketing copy, generic filler, or AI-sounding text?
8. Does the article explain why readers should care?
9. Does the article teach the reader something beyond what the source states?
10. Does the article feel like an editor wrote it, or an AI summarised it?

Scoring:
- 9-10: Excellent. Publishes immediately.
- 7-8: Good. Minor issues but approvable.
- 5-6: Needs revision. Clear weaknesses that undermine the article.
- 1-4: Significant problems. Rewrite required.

Verdict: "Approve" if score >= 7. "Needs Revision" if score < 7.

Output JSON only. No other text.`,
      },
      {
        role: "user",
        content: `STORY TITLE: ${title}\nINTENDED ANGLE: ${angle}\n\nARTICLE:\n${article}\n\nOutput JSON:\n{\n  "storyAngle": "one sentence",\n  "biggestWeakness": "one sentence",\n  "missingContext": "one sentence or none",\n  "fillerSentences": ["exact sentence if any"],\n  "soyunciScore": 7,\n  "verdict": "Approve"\n}`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e > s) {
      const parsed = JSON.parse(raw.slice(s, e + 1)) as Partial<EditorReview>;
      return {
        storyAngle: parsed.storyAngle ?? "",
        biggestWeakness: parsed.biggestWeakness ?? "",
        missingContext: parsed.missingContext ?? "None",
        fillerSentences: Array.isArray(parsed.fillerSentences) ? parsed.fillerSentences : [],
        soyunciScore: typeof parsed.soyunciScore === "number" ? Math.min(10, Math.max(1, parsed.soyunciScore)) : 7,
        verdict: parsed.verdict === "Needs Revision" ? "Needs Revision" : "Approve",
      };
    }
  } catch { /* fall through */ }

  // Fallback: if JSON parse fails, approve with score 7 to avoid blocking the pipeline
  return {
    storyAngle: angle,
    biggestWeakness: "Editor review parse failed",
    missingContext: "None",
    fillerSentences: [],
    soyunciScore: 7,
    verdict: "Approve",
  };
}

/**
 * Main pipeline orchestrator: runs Step A (extract) then Step B (write).
 *
 * Token efficiency vs old single-shot approach:
 *   OLD: 1 call with 20,000 chars raw text + full article output in one shot
 *        → LLM loses track of facts buried mid-context, misses key details
 *   NEW: Step A: 18,000 chars raw → compact JSON fact matrix (~500 tokens)
 *        Step B: ~2,500 chars structured facts → article (~300 tokens)
 *        → Writer has 100% of facts, uses 100% of context window for writing
 */
async function researchAndWrite(
  title: string,
  primarySourceText: string,
  researchContext: string,
  feedbackExamples: string,
  voiceExamples: string,
  perfContext: string,
  sourcesResearched: number
): Promise<{ facts: string[]; angle: string; article: string; hashtags: string[]; seoTitle: string; seoDescription: string }> {
  // Step A: Extract everything from the raw sources into a clean fact matrix
  console.log(`[Soyunci] Step A — extracting fact matrix from ${sourcesResearched} source(s)...`);
  const factMatrix = await extractFactMatrix(title, primarySourceText, researchContext, sourcesResearched);
  console.log(`[Soyunci] Step A complete — ${factMatrix.facts.length} facts, angle: ${factMatrix.angle}, ${factMatrix.directQuotes.length} quotes`);

  // Step B: Write the article from the clean fact matrix only
  console.log(`[Soyunci] Step B — writing article from fact matrix...`);
  let { article, hashtags, seoTitle, seoDescription } = await writeFromFactMatrix(
    title, factMatrix, feedbackExamples, voiceExamples, perfContext
  );
  console.log(`[Soyunci] Step B complete — article: ${article.split(/\s+/).length} words`);

  // Step C: Editor review — quality gate with one auto-rewrite if score < 7
  console.log(`[Soyunci] Step C — editor review...`);
  let editorReview = await runEditorReview(title, article, factMatrix.angle);
  console.log(`[Soyunci] Editor score: ${editorReview.soyunciScore}/10 — ${editorReview.verdict}`);

  if (editorReview.verdict === "Needs Revision" && editorReview.soyunciScore < 7) {
    console.log(`[Soyunci] Step C — score ${editorReview.soyunciScore}/10, triggering targeted rewrite...`);
    const rewriteResult = await writeFromFactMatrix(
      title, factMatrix, feedbackExamples, voiceExamples, perfContext,
      editorReview  // pass editor feedback into the rewrite
    );
    article = rewriteResult.article;
    hashtags = rewriteResult.hashtags;
    seoTitle = rewriteResult.seoTitle;
    seoDescription = rewriteResult.seoDescription;
    // Re-review the rewritten article
    editorReview = await runEditorReview(title, article, factMatrix.angle);
    console.log(`[Soyunci] Rewrite editor score: ${editorReview.soyunciScore}/10 — ${editorReview.verdict}`);
  }

  return {
    facts: factMatrix.facts,
    angle: factMatrix.angle,
    article,
    hashtags,
    seoTitle,
    seoDescription,
    editorReview,
  };
}

/**
 * Call 2: Generate headlines + Canva brief together in one shot.
 * Saves one full LLM round trip vs the original 2-step approach.
 */
async function generateHeadlinesAndCanva(
  title: string,
  article: string,
  angle: string,
  facts: string[],
  headlinePatterns: string[]
): Promise<{ selected: string; alternatives: string[]; canvaBrief: CanvaBrief }> {
  // Load style guide
  let styleGuide = "";
  try {
    const raw = await getScoringConfig("headline_style_guide");
    if (raw) {
      const guide = JSON.parse(raw);
      const patterns = guide.rules?.structural_patterns?.ranked_by_performance ?? [];
      const kills = guide.rules?.what_kills_performance ?? [];
      styleGuide = `TOP PATTERNS: ${patterns.slice(0, 3).map((p: any) => p.pattern).join(" | ")}\nAVOID: ${kills.slice(0, 3).join(" | ")}`;
    }
  } catch { /* no style guide yet */ }

  const factsBlock = facts.slice(0, 8).map((f, i) => `${i + 1}. ${f}`).join("\n");
  const patternsBlock = headlinePatterns.length > 0 ? `\nPATTERNS: ${headlinePatterns.slice(0, 3).join(" | ")}` : "";

  const response = await invokeLLM({
    model: HEADLINE_MODEL,
    messages: [
      {
        role: "system",
        content: `You are Soyunci, FlightDrama's headline editor and creative director.
Write headlines that make people stop scrolling. The fact IS the story — put it in the headline.
FlightDrama style: specific numbers, airline names, consequences. Title Case. 6-12 words.
NEVER: vague teasers, "You won't believe", trade journal style, question headlines.
${styleGuide}${patternsBlock}

Also produce a Canva visual brief for the Instagram post.

Return ONLY valid JSON with these fields:
- "selected": the single best headline
- "alternatives": array of 4 alternative headlines
- "canvaHeadline": max 10 words for the poster
- "aspectRatio": "4:5" or "1:1"
- "visualIdea": specific hero image description
- "aircraftToShow": specific aircraft type and livery, or "None"
- "circleInsert": small inset image idea, or "None"
- "mood": one word
- "background": specific background description
- "hierarchy": text and image arrangement`,
      },
      {
        role: "user",
        content: `TITLE: ${title}\nVIRAL ANGLE: ${angle}\nARTICLE: ${article.slice(0, 600)}\nKEY FACTS:\n${factsBlock}\n\nReturn ONLY valid JSON.`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e > s) {
      const p = JSON.parse(raw.slice(s, e + 1)) as any;
      return {
        selected: p.selected ?? title,
        alternatives: Array.isArray(p.alternatives) ? p.alternatives.slice(0, 5) : [],
        canvaBrief: {
          headline: p.canvaHeadline ?? (p.selected ?? title).slice(0, 80),
          aspectRatio: p.aspectRatio ?? "4:5",
          visualIdea: p.visualIdea ?? "",
          aircraftToShow: p.aircraftToShow ?? "",
          circleInsert: p.circleInsert ?? "None",
          mood: p.mood ?? "dramatic",
          background: p.background ?? "",
          hierarchy: p.hierarchy ?? "",
        },
      };
    }
  } catch { /* fall through */ }
  return {
    selected: title,
    alternatives: [],
    canvaBrief: { headline: title.slice(0, 80), aspectRatio: "4:5", visualIdea: "", aircraftToShow: "", circleInsert: "None", mood: "dramatic", background: "", hierarchy: "" },
  };
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

export async function runFullSoyunciPipeline(
  title: string,
  content: string,
  sourceUrl: string,
  viralReason: string,
  _category: string
): Promise<SoyunciOutput> {
  console.log(`[Soyunci] Starting 2-call pipeline for: "${title}"`);

  // Fetch sources + load context in parallel (all free, no LLM tokens)
  const [researchResult, perfInsights, feedbackExamples, voiceExamples, styleContext] = await Promise.all([
    deepResearch(title, sourceUrl, content),
    getPerformanceInsights(),
    loadFeedbackExamples(),
    loadVoiceExamples(),
    buildStyleContext(),
  ]);

  const { context: researchContext, sourcesResearched, primarySourceText } = researchResult;
  const perfContext = [buildPerformanceContext(perfInsights), styleContext].filter(Boolean).join("\n");

  if (!primarySourceText) {
    console.warn(`[Soyunci] No primary source text for "${title}" — RSS content used as fallback`);
  } else {
    console.log(`[Soyunci] Primary source: ${primarySourceText.split(/\s+/).length} words | Secondary sources: ${sourcesResearched}`);
  }

  // ── CALL 1: Research + Facts + Angle + Article + Editor Review (Steps A, B, C) ────────────
  const { facts, angle, article, hashtags, seoTitle, seoDescription, editorReview } = await researchAndWrite(
    title, primarySourceText, researchContext, feedbackExamples, voiceExamples, perfContext, sourcesResearched
  );

  // ── CALL 2: Headlines + Canva brief (one shot) ────────────────────────────────────────────────────────────────────────────────────────
  const [headlinesResult, imagesResult] = await Promise.all([
    generateHeadlinesAndCanva(title, article, angle, facts, perfInsights?.headlinePatterns ?? []),
    researchImages(title, article, angle),
  ]);

  const { selected: selectedHeadline, alternatives: alternativeHeadlines, canvaBrief } = headlinesResult;
  const { recs: imageRecommendations, candidates: imageCandidates } = imagesResult;

  console.log(`[Soyunci] Pipeline complete — ${sourcesResearched} sources, ${facts.length} facts, angle: "${angle}", editor score: ${editorReview.soyunciScore}/10`);

  return {
    viralAngle: angle,
    extractedFacts: facts,
    article,
    hashtags,
    selectedHeadline,
    alternativeHeadlines,
    imageRecommendations,
    imageCandidates,
    canvaBrief,
    researchContext,
    sourcesResearched,
    seoTitle: seoTitle ?? title.slice(0, 60),
    seoDescription: seoDescription ?? "",
    editorReview,
  };
}

// ── Legacy exports ────────────────────────────────────────────────────────────

export { generateHeadlines, generateCanvaBrief, researchImages };

/**
 * Re-research and rewrite step only — runs the full Soyunci research, fact extraction,
 * angle detection, article writing, and headline generation steps but does NOT
 * regenerate images. Used by the "Re-Research" button on story cards so the editor
 * can get a richer article without discarding their chosen images.
 *
 * Returns the same fields as runFullSoyunciPipeline except imageRecommendations,
 * imageCandidates, and canvaBrief (those are left unchanged by the caller).
 */
export async function runResearchAndWrite(
  title: string,
  content: string,
  sourceUrl: string,
  viralReason: string,
  _category: string
): Promise<{
  viralAngle: string;
  extractedFacts: string[];
  article: string;
  hashtags: string[];
  selectedHeadline: string;
  alternativeHeadlines: string[];
  researchContext: string;
  sourcesResearched: number;
  seoTitle: string;
  seoDescription: string;
  editorReview: EditorReview;
}> {
    console.log(`[Soyunci] Re-research + write for: "${title}"`);
  const [researchResult, perfInsights, feedbackExamples, voiceExamples, styleContext] = await Promise.all([
    deepResearch(title, sourceUrl, content),
    getPerformanceInsights(),
    loadFeedbackExamples(),
    loadVoiceExamples(),
    buildStyleContext(),
  ]);
  const { context: researchContext, sourcesResearched, primarySourceText } = researchResult;
  const perfContext = [buildPerformanceContext(perfInsights), styleContext].filter(Boolean).join("\n");

  if (!primarySourceText) {
    console.warn(`[Soyunci] No primary source text for re-research of "${title}" — RSS content used as fallback`);
  }

  // 3-step pipeline (extract, write, editor review)
  const { facts, angle, article, hashtags, seoTitle, seoDescription, editorReview } = await researchAndWrite(
    title, primarySourceText, researchContext, feedbackExamples, voiceExamples, perfContext, sourcesResearched
  );
  const { selected: selectedHeadline, alternatives: alternativeHeadlines } = await generateHeadlinesAndCanva(
    title, article, angle, facts, perfInsights?.headlinePatterns ?? []
  );

  console.log(`[Soyunci] Re-research complete — ${sourcesResearched} source(s), primary: ${primarySourceText ? 'YES' : 'NO'}`);

  return {
    viralAngle: angle,
    extractedFacts: facts,
    article,
    hashtags,
    selectedHeadline,
    alternativeHeadlines,
    researchContext,
    sourcesResearched,
    seoTitle: seoTitle ?? title.slice(0, 60),
    seoDescription: seoDescription ?? "",
    editorReview,
  };
}

export async function runSoyunci(
  title: string,
  content: string,
  viralReason: string,
  _category: string
) {
  const [feedbackExamples, voiceExamples] = await Promise.all([
    loadFeedbackExamples(),
    loadVoiceExamples(),
  ]);
  const combinedExamples = [voiceExamples, feedbackExamples].filter(Boolean).join("\n\n");
  const result = await writeSoyunciArticle(title, content, "", viralReason, [], combinedExamples);
  return { article: result.article, hashtags: result.hashtags, imageRecommendations: [] };
}

/**
 * Rewrite the article text only — uses the full editorial prompt + voice examples
 * but skips research, images, and headlines. Fast (single LLM call).
 */
export async function rewriteArticleOnly(
  title: string,
  content: string,
  researchContext: string,
  viralAngle: string,
  extractedFacts: string[]
): Promise<{ article: string; hashtags: string[] }> {
  const [feedbackExamples, voiceExamples] = await Promise.all([
    loadFeedbackExamples(),
    loadVoiceExamples(),
  ]);
  const combinedExamples = [voiceExamples, feedbackExamples].filter(Boolean).join("\n\n");
  return writeSoyunciArticle(title, content, researchContext, viralAngle, extractedFacts, combinedExamples);
}
