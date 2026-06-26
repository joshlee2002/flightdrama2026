/**
 * articleFetcher.ts
 *
 * Server-side HTML scraper used by the Soyunci pipeline research step.
 * Fetches a URL, strips navigation/ads/footers/sidebars, and returns only
 * the main article body text. Used to enrich the research context fed to
 * the LLM writer with facts, quotes, and context from multiple sources.
 *
 * v3: 6-layer fallback chain, smarter Google News decoding, paywall detection,
 * og:description enrichment, increased content limits, better HTML extraction.
 *
 * Fetch layers (in order):
 *   1. Direct Chrome headers
 *   2. Safari UA + Google Referer
 *   3. Googlebot UA (bypasses many paywalls that whitelist Google)
 *   4. Jina AI Reader (renders JS, bypasses Cloudflare)
 *   5. Diffbot Extract API (free tier — handles JS-heavy and paywalled sites)
 *   6. AllOrigins proxy (last resort)
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
  /** Which fetch layer succeeded */
  fetchLayer?: string;
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
  // Paywall / subscription wall elements — remove so we don't count them as content
  ".paywall", ".pay-wall", ".subscription-wall", ".premium-content",
  "[data-paywall]", ".tp-modal", ".tp-backdrop", ".piano-modal",
  ".subscriber-only", ".members-only", ".locked-content",
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
  // BBC-specific
  '[data-component="text-block"]',
  ".ssrcss-11r1m41-RichTextComponentWrapper",
  // Guardian-specific
  ".article-body-commercial-selector",
  ".dcr-1eu1p0w",
  // Reuters-specific
  ".article__body",
  '[data-testid="ArticleBody"]',
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
 * 40,000 chars (~8,000 words) — covers the longest investigative pieces,
 * NTSB accident reports, and multi-source deep dives without truncation.
 * The LLM context window is 128k tokens so this is well within budget.
 */
const MAX_CHARS = 40000;

/** Fetch timeout in milliseconds for direct fetches */
const FETCH_TIMEOUT_MS = 12000;

/** Jina AI Reader base URL — renders JS, bypasses most bot blocks, returns clean markdown */
const JINA_READER_BASE = "https://r.jina.ai/";

/**
 * Phrases that indicate a paywall or login wall was returned instead of article content.
 * Used to detect when a fetch "succeeded" (HTTP 200) but returned a wall, not the article.
 */
const PAYWALL_PHRASES = [
  "subscribe to read",
  "subscribe to continue",
  "subscribe for full access",
  "sign in to read",
  "sign in to continue",
  "create an account to read",
  "create a free account",
  "subscriber only",
  "subscribers only",
  "premium content",
  "this article is for subscribers",
  "to read this article",
  "unlock this article",
  "already a subscriber",
  "start your free trial",
];

/** Returns true if the fetched HTML looks like a paywall/login wall rather than article content */
function isPaywallPage(html: string): boolean {
  const lower = html.toLowerCase();
  return PAYWALL_PHRASES.some(phrase => lower.includes(phrase));
}

// ── Google News redirect resolver ─────────────────────────────────────────────

/**
 * Google News RSS links are redirect URLs (news.google.com/rss/articles/...).
 * Resolve them to the real article URL before fetching.
 *
 * Strategy:
 * 1. Try HEAD redirect follow (fast, no body download)
 * 2. Try GET redirect follow if HEAD fails
 * 3. Try decoding the base64 URL embedded in the Google News link
 */
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  if (!url.includes("news.google.com")) return url;

  // Strategy 1 & 2: Follow HTTP redirects
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.url && res.url !== url && !res.url.includes("news.google.com")) {
        return res.url;
      }
    } catch { /* try next */ }
  }

  // Strategy 3: Decode the base64 article URL embedded in the Google News link
  // Google News URLs contain a base64-encoded destination URL in the path
  try {
    const match = url.match(/articles\/([A-Za-z0-9_-]+)/);
    if (match) {
      // The encoded part uses URL-safe base64 — pad and decode
      let encoded = match[1];
      // Add padding
      while (encoded.length % 4 !== 0) encoded += "=";
      const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
      // The decoded string contains the URL somewhere — extract it
      const urlMatch = decoded.match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch && !urlMatch[0].includes("google.com")) {
        return urlMatch[0];
      }
    }
  } catch { /* give up */ }

  return url;
}

// ── Core fetch layers ─────────────────────────────────────────────────────────

/**
 * Layer 1: Direct fetch with Chrome-like headers.
 * Works on most open news sites.
 */
async function fetchDirect(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });
    if (!response.ok) return { ...blank, error: `HTTP ${response.status}` };
    const ct = response.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return { ...blank, error: `Non-HTML: ${ct}` };
    const html = await response.text();
    if (isPaywallPage(html)) return { ...blank, error: "Paywall detected" };
    const result = extractFromHtml(url, html);
    return result.success ? { ...result, fetchLayer: "direct-chrome" } : result;
  } catch (err) {
    return { ...blank, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Layer 2: Safari UA with Google Referer — bypasses some bot-detection that blocks Chrome bots.
 */
async function fetchWithSafariUA(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Referer": "https://www.google.com/",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });
    if (!response.ok) return { ...blank, error: `HTTP ${response.status}` };
    const html = await response.text();
    if (isPaywallPage(html)) return { ...blank, error: "Paywall detected" };
    const result = extractFromHtml(url, html);
    return result.success ? { ...result, fetchLayer: "safari-ua" } : result;
  } catch (err) {
    return { ...blank, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Layer 3: Googlebot UA — many publishers whitelist Googlebot to allow indexing,
 * which means paywalled content is often served in full to this user agent.
 * This is the "Google First Click Free" / "Flexible Sampling" bypass.
 */
async function fetchWithGooglebotUA(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "From": "googlebot(at)googlebot.com",
      },
      redirect: "follow",
    });
    if (!response.ok) return { ...blank, error: `HTTP ${response.status}` };
    const html = await response.text();
    // Don't check for paywall here — Googlebot may get different content
    const result = extractFromHtml(url, html);
    return result.success ? { ...result, fetchLayer: "googlebot-ua" } : result;
  } catch (err) {
    return { ...blank, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Layer 4: Jina AI Reader (r.jina.ai) — renders JavaScript, bypasses Cloudflare and most
 * bot-detection, and returns clean markdown text.
 * Works on: The Aviation Herald, FlightGlobal, Reuters, AP, most paywalled sites.
 * Uses API key if available (higher rate limits, better success on blocked sites).
 */
async function fetchViaJina(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };
  const jinaUrl = `${JINA_READER_BASE}${url}`;
  const jinaApiKey = process.env.JINA_API_KEY ?? "";
  try {
    const response = await fetch(jinaUrl, {
      headers: {
        "Accept": "text/plain, text/markdown, */*",
        "User-Agent": "Mozilla/5.0 (compatible; FlightDrama/3.0 aviation-research-bot)",
        "X-Return-Format": "markdown",
        "X-Timeout": "20",
        // Request full content without truncation
        "X-No-Cache": "true",
        ...(jinaApiKey ? { "Authorization": `Bearer ${jinaApiKey}` } : {}),
      },
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });
    if (!response.ok) return { ...blank, error: `Jina HTTP ${response.status}` };
    const markdown = await response.text();
    // Jina returns clean markdown — strip markdown syntax for plain text
    const plainText = markdown
      .replace(/^#{1,6}\s+/gm, "")              // headings
      .replace(/\*\*(.+?)\*\*/g, "$1")          // bold
      .replace(/\*(.+?)\*/g, "$1")              // italic
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links
      .replace(/^[\-*>]\s+/gm, "")              // list markers / blockquotes
      .replace(/`{1,3}[^`]*`{1,3}/g, "")        // code
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const wc = plainText.split(/\s+/).filter(w => w.length > 0).length;
    if (wc < MIN_WORD_COUNT) return { ...blank, error: `Jina returned too little text (${wc} words)` };
    // Extract title from first heading line if present
    const titleMatch = markdown.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : "";
    return {
      url,
      title,
      bodyText: plainText.slice(0, MAX_CHARS),
      wordCount: wc,
      success: true,
      fetchLayer: "jina-reader",
    };
  } catch (err) {
    return { ...blank, error: `Jina failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Layer 5: 12ft.io — free paywall removal service.
 * Prepends "https://12ft.io/" to the URL to get the full article.
 * Works on many soft paywalls (NYT, Bloomberg, etc.)
 */
async function fetchVia12ft(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };
  try {
    const proxyUrl = `https://12ft.io/proxy?q=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://12ft.io/",
      },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!response.ok) return { ...blank, error: `12ft HTTP ${response.status}` };
    const html = await response.text();
    const result = extractFromHtml(url, html);
    return result.success ? { ...result, fetchLayer: "12ft-proxy" } : result;
  } catch (err) {
    return { ...blank, error: `12ft failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Layer 6: AllOrigins proxy — last resort.
 * Routes the request through allorigins.win servers.
 */
async function fetchViaProxy(url: string): Promise<FetchedArticle> {
  const blank: FetchedArticle = { url, title: "", bodyText: "", wordCount: 0, success: false };
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { ...blank, error: `Proxy HTTP ${response.status}` };
    const json = await response.json() as { contents?: string; status?: { http_code: number } };
    if (!json.contents || json.contents.length < 200) return { ...blank, error: "Proxy returned empty content" };
    const result = extractFromHtml(url, json.contents);
    return result.success ? { ...result, fetchLayer: "allorigins-proxy" } : result;
  } catch (err) {
    return { ...blank, error: `Proxy failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Fetch a URL and extract the main article body text.
 *
 * Uses a 6-layer fallback chain to maximise success rate:
 *   1. Direct Chrome headers (fast, works on most open sites)
 *   2. Safari UA + Google Referer (bypasses some bot detection)
 *   3. Googlebot UA (bypasses many soft paywalls via Google's whitelisting)
 *   4. Jina AI Reader (renders JS, bypasses Cloudflare — works on most blocked sites)
 *   5. 12ft.io proxy (free paywall removal for NYT, Bloomberg, etc.)
 *   6. AllOrigins proxy (last resort)
 *
 * Returns a FetchedArticle with success=false only if ALL layers fail.
 */
export async function fetchArticleText(url: string): Promise<FetchedArticle> {
  // Resolve Google News redirect URLs to the real article URL first
  const resolvedUrl = await resolveGoogleNewsUrl(url);

  // Layer 1: Direct Chrome fetch
  const direct = await fetchDirect(resolvedUrl);
  if (direct.success && direct.wordCount >= MIN_WORD_COUNT) {
    return direct;
  }
  console.log(`[Fetcher] L1 failed (${resolvedUrl.slice(0, 70)}): ${direct.error ?? 'insufficient content'}`);

  // Layer 2: Safari UA
  const safari = await fetchWithSafariUA(resolvedUrl);
  if (safari.success && safari.wordCount >= MIN_WORD_COUNT) {
    console.log(`[Fetcher] L2 Safari succeeded (${resolvedUrl.slice(0, 70)}) — ${safari.wordCount}w`);
    return safari;
  }
  console.log(`[Fetcher] L2 failed: ${safari.error ?? 'insufficient content'}`);

  // Layer 3: Googlebot UA (paywall bypass via Google whitelisting)
  const googlebot = await fetchWithGooglebotUA(resolvedUrl);
  if (googlebot.success && googlebot.wordCount >= MIN_WORD_COUNT) {
    console.log(`[Fetcher] L3 Googlebot succeeded (${resolvedUrl.slice(0, 70)}) — ${googlebot.wordCount}w`);
    return googlebot;
  }
  console.log(`[Fetcher] L3 failed: ${googlebot.error ?? 'insufficient content'}`);

  // Layer 4: Jina AI Reader (JS rendering, Cloudflare bypass)
  const jina = await fetchViaJina(resolvedUrl);
  if (jina.success && jina.wordCount >= MIN_WORD_COUNT) {
    console.log(`[Fetcher] L4 Jina succeeded (${resolvedUrl.slice(0, 70)}) — ${jina.wordCount}w`);
    return jina;
  }
  console.log(`[Fetcher] L4 failed: ${jina.error ?? 'insufficient content'}`);

  // Layer 5: 12ft.io paywall removal
  const ft12 = await fetchVia12ft(resolvedUrl);
  if (ft12.success && ft12.wordCount >= MIN_WORD_COUNT) {
    console.log(`[Fetcher] L5 12ft succeeded (${resolvedUrl.slice(0, 70)}) — ${ft12.wordCount}w`);
    return ft12;
  }
  console.log(`[Fetcher] L5 failed: ${ft12.error ?? 'insufficient content'}`);

  // Layer 6: AllOrigins proxy
  const proxy = await fetchViaProxy(resolvedUrl);
  if (proxy.success && proxy.wordCount >= MIN_WORD_COUNT) {
    console.log(`[Fetcher] L6 proxy succeeded (${resolvedUrl.slice(0, 70)})`);
    return proxy;
  }

  // All layers failed — return the best result we got (most words)
  const best = [direct, safari, googlebot, jina, ft12, proxy].sort((a, b) => b.wordCount - a.wordCount)[0];
  console.warn(`[Fetcher] ALL 6 LAYERS FAILED (${resolvedUrl.slice(0, 70)}) — best: ${best.wordCount}w`);
  return {
    ...best,
    success: false,
    error: `All fetch layers failed. Best: ${best.wordCount} words. Last error: ${proxy.error ?? ft12.error ?? jina.error ?? googlebot.error ?? safari.error ?? direct.error}`,
  };
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
 * 5. Last resort: use og:description meta tag
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

    // Extract JSON-LD structured data — often contains full article text on news sites
    let jsonLdText = "";
    try {
      const jsonLdScripts = root.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        const raw = script.text;
        if (!raw) continue;
        const data = JSON.parse(raw);
        // articleBody is the full text in Schema.org Article markup
        const articleBody = data.articleBody || data.description || "";
        if (articleBody && articleBody.length > jsonLdText.length) {
          jsonLdText = articleBody;
        }
      }
    } catch { /* JSON-LD parse failure is fine */ }

    // Remove boilerplate elements in-place before any content extraction
    for (const selector of BOILERPLATE_SELECTORS) {
      try {
        root.querySelectorAll(selector).forEach((el) => el.remove());
      } catch { /* some selectors may not be supported — skip */ }
    }

    // ── Strategy 0: JSON-LD articleBody (cleanest possible source) ─────────
    if (jsonLdText && countWords(jsonLdText) >= MIN_WORD_COUNT) {
      const cleaned = cleanText(jsonLdText);
      return {
        url,
        title,
        bodyText: cleaned.slice(0, MAX_CHARS),
        wordCount: countWords(cleaned),
        success: true,
      };
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

    if (wordCount >= MIN_WORD_COUNT) {
      return {
        url,
        title,
        bodyText: bodyText.slice(0, MAX_CHARS),
        wordCount,
        success: true,
      };
    }

    // ── Strategy 4: og:description last resort ─────────────────────────────
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
  concurrency = 5
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
