/**
 * articleFetcher.ts
 *
 * Server-side HTML scraper used by the Soyunci pipeline research step.
 * Fetches a URL, strips navigation/ads/footers/sidebars, and returns only
 * the main article body text. Used to enrich the research context fed to
 * the LLM writer with facts, quotes, and context from multiple sources.
 *
 * v2: Higher content limits, smarter extraction, Google News redirect resolution,
 * paragraph-level scoring to find the densest content block.
 */

import { parse as parseHtml } from "node-html-parser";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FetchedArticle {
  url: string;
  title: string;
  /** Cleaned main body text, stripped of boilerplate */
  bodyText: string;
  /** Approximate word count of the extracted body */
  wordCount: number;
  /** Whether extraction succeeded */
  success: boolean;
  /** Error message if extraction failed */
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** CSS selectors for elements that are reliably boilerplate — strip these first */
const BOILERPLATE_SELECTORS = [
  "nav", "header", "footer", "aside",
  "[role='navigation']", "[role='banner']", "[role='complementary']", "[role='search']",
  ".nav", ".navbar", ".navigation", ".menu", ".sidebar", ".side-bar", ".side-nav",
  ".header", ".footer", ".site-header", ".site-footer", ".page-header",
  ".ad", ".ads", ".advertisement", ".advert", ".ad-unit", ".ad-container",
  ".dfp", ".gpt-ad", "[id^='ad-']", "[class*='advert']", "[class*='sponsor']",
  ".cookie", ".cookie-banner", ".gdpr", ".consent", ".cookie-notice",
  ".social", ".social-share", ".share-buttons", ".share-bar", ".sharing",
  ".related", ".related-articles", ".recommended", ".more-stories", ".also-read",
  ".comments", ".comment-section", ".comment-form", "#comments",
  ".newsletter", ".subscribe", ".subscription", ".email-signup",
  ".popup", ".modal", ".overlay", ".lightbox",
  ".breadcrumb", ".breadcrumbs", ".pagination",
  "[aria-label='advertisement']", "[aria-label='related articles']",
  "[data-ad]", "[data-ads]", "[data-module='RelatedContent']",
  ".tags", ".tag-list", ".topics",
  ".author-bio", ".byline-bio", ".contributor-bio",
  ".read-more", ".read-next",
  ".trending", ".popular",
  "script", "style", "noscript", "iframe", "figure.embed", ".video-embed",
];

/** CSS selectors for elements that are reliably the main article body — try in order */
const ARTICLE_SELECTORS = [
  // Semantic HTML5
  "article",
  "[role='main']",
  "main",
  // Common CMS patterns
  ".article-body",
  ".article-content",
  ".article__body",
  ".article__content",
  ".article-text",
  ".article-copy",
  ".story-body",
  ".story-content",
  ".story__body",
  ".story-text",
  ".post-body",
  ".post-content",
  ".post__content",
  ".entry-content",
  ".entry-body",
  ".content-body",
  ".content__body",
  ".body-content",
  ".news-body",
  ".news-content",
  ".text-content",
  ".main-content",
  ".page-content",
  // ID-based
  "#article-body",
  "#article-content",
  "#story-body",
  "#main-content",
  "#content",
  "#article",
  "#post-content",
  // Aviation-specific outlets
  ".simpleflying-article",
  ".avherald-content",
  ".aviationweek-body",
  // Generic fallbacks
  '[itemprop="articleBody"]',
  '[itemprop="text"]',
  ".body",
  ".text",
];

/** Minimum word count to consider an extraction successful */
const MIN_WORD_COUNT = 50;

/**
 * Maximum characters to return per article.
 * Increased from 6000 to 12000 to give the LLM writer much more material.
 * At ~5 chars/word this is ~2400 words per source — enough for a full article.
 */
const MAX_CHARS = 12000;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 12000;

// ── Google News redirect resolver ─────────────────────────────────────────────

/**
 * Google News RSS links are redirect URLs (news.google.com/rss/articles/...).
 * Resolve them to the real article URL before fetching, so we hit the actual
 * news outlet rather than a redirect page with no content.
 */
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  if (!url.includes("news.google.com")) return url;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SoyunciBot/1.0)" },
      signal: AbortSignal.timeout(6000),
    });
    // After redirect chain, res.url is the final destination
    if (res.url && res.url !== url && !res.url.includes("news.google.com")) {
      return res.url;
    }
  } catch {
    // If HEAD fails, try GET with redirect follow
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SoyunciBot/1.0)" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.url && res.url !== url && !res.url.includes("news.google.com")) {
        return res.url;
      }
    } catch { /* give up, use original */ }
  }
  return url;
}

// ── Core fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract the main article body text.
 * Returns a FetchedArticle with success=false on any error so callers
 * can safely continue without crashing the pipeline.
 */
export async function fetchArticleText(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };

  try {
    // Resolve Google News redirect URLs to the real article URL
    const resolvedUrl = await resolveGoogleNewsUrl(url);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(resolvedUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
        redirect: "follow",
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return { ...blank, error: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { ...blank, error: `Non-HTML content type: ${contentType}` };
    }

    const html = await response.text();
    return extractFromHtml(resolvedUrl, html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("aborted") || message.includes("timeout")) {
      return { ...blank, error: "Fetch timed out" };
    }
    return { ...blank, error: message };
  }
}

/**
 * Extract the main article body from raw HTML.
 * Exported for unit testing without needing a real HTTP call.
 *
 * Strategy:
 * 1. Remove all boilerplate elements
 * 2. Try each ARTICLE_SELECTOR in order — use the first match with enough text
 * 3. If no selector works, use paragraph-density scoring to find the best content block
 * 4. Fall back to body if all else fails
 */
export function extractFromHtml(url: string, html: string): FetchedArticle {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };

  try {
    const root = parseHtml(html, {
      lowerCaseTagName: true,
      comment: false,
      blockTextElements: {
        script: false,
        noscript: false,
        style: false,
        pre: true,
      },
    });

    // Extract page title from og:title first (more accurate than <title>)
    const ogTitle = root.querySelector('meta[property="og:title"]');
    const titleEl = root.querySelector("title");
    const title =
      ogTitle?.getAttribute("content")?.trim() ||
      titleEl?.text?.trim() ||
      "";

    // Extract og:description as a fallback content snippet
    const ogDesc = root.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ?? "";

    // Remove boilerplate elements in-place before any content extraction
    for (const selector of BOILERPLATE_SELECTORS) {
      try {
        root.querySelectorAll(selector).forEach((el) => el.remove());
      } catch { /* some selectors may not be supported — skip */ }
    }

    // ── Strategy 1: Try known article container selectors ──────────────────
    for (const selector of ARTICLE_SELECTORS) {
      try {
        const el = root.querySelector(selector);
        if (!el) continue;
        const text = cleanText(el.text ?? "");
        const wc = countWords(text);
        if (wc >= MIN_WORD_COUNT) {
          return {
            url,
            title,
            bodyText: text.slice(0, MAX_CHARS),
            wordCount: wc,
            success: true,
          };
        }
      } catch { /* selector may fail on malformed HTML */ }
    }

    // ── Strategy 2: Paragraph density scoring ──────────────────────────────
    // Find the div/section with the most <p> tag word content — this is
    // usually the article body even when no standard class names are used.
    const body = root.querySelector("body");
    if (body) {
      const candidates = body.querySelectorAll("div, section");
      let bestText = "";
      let bestScore = 0;

      for (const candidate of candidates) {
        const paragraphs = candidate.querySelectorAll("p");
        if (paragraphs.length < 3) continue; // Need at least 3 paragraphs
        const combinedText = paragraphs.map(p => p.text.trim()).filter(t => t.length > 30).join("\n\n");
        const wc = countWords(combinedText);
        // Score = word count × paragraph count (rewards dense, multi-paragraph blocks)
        const score = wc * paragraphs.length;
        if (score > bestScore && wc >= MIN_WORD_COUNT) {
          bestScore = score;
          bestText = combinedText;
        }
      }

      if (bestText.length > 0) {
        const cleaned = cleanText(bestText);
        return {
          url,
          title,
          bodyText: cleaned.slice(0, MAX_CHARS),
          wordCount: countWords(cleaned),
          success: true,
        };
      }
    }

    // ── Strategy 3: Full body fallback ─────────────────────────────────────
    const bodyText = cleanText(body?.text ?? root.text ?? "");
    const wordCount = countWords(bodyText);

    if (wordCount < MIN_WORD_COUNT) {
      // Last resort: use og:description if available
      if (ogDesc.length > 50) {
        return {
          url,
          title,
          bodyText: ogDesc,
          wordCount: countWords(ogDesc),
          success: true,
        };
      }
      return {
        ...blank,
        title,
        error: `Extracted text too short (${wordCount} words) — likely a paywall or JS-rendered page`,
      };
    }

    return {
      url,
      title,
      bodyText: bodyText.slice(0, MAX_CHARS),
      wordCount,
      success: true,
    };
  } catch (err) {
    return { ...blank, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanText(raw: string): string {
  return raw
    // Collapse whitespace runs into single spaces
    .replace(/[ \t]+/g, " ")
    // Collapse 3+ newlines into 2
    .replace(/\n{3,}/g, "\n\n")
    // Remove lines that are purely whitespace or very short (nav links, labels)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 15) // Filter out very short lines (nav items, labels)
    .join("\n")
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ── Batch fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch multiple URLs concurrently (up to `concurrency` at a time).
 * Returns results in the same order as the input URLs.
 * Never throws — failed fetches return success=false entries.
 */
export async function fetchArticlesBatch(
  urls: string[],
  concurrency = 3
): Promise<FetchedArticle[]> {
  const results: FetchedArticle[] = new Array(urls.length);
  const queue = urls.map((url, i) => ({ url, i }));

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      results[item.i] = await fetchArticleText(item.url);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
