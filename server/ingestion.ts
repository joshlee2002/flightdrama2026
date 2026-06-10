import Parser from "rss-parser";
import { parse as parseHtml } from "node-html-parser";

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; FlightDrama/1.0 aviation aggregator)",
  },
});

export interface FetchedStory {
  title: string;
  sourceUrl: string;
  sourceName: string;
  content: string;
  publishedAt: Date | null;
}

// ── All confirmed source URLs from the FlightDrama inoreader config ───────────
export const DEFAULT_RSS_SOURCES = [
  // ── RAW AVIATION ─────────────────────────────────────────────────────────
  { name: "Simple Flying", url: "https://simpleflying.com/feed/", category: "aviation" as const },
  { name: "Simple Flying Aviation News", url: "https://simpleflying.com/feed/category/aviation-news/", category: "aviation" as const },
  { name: "AeroTime", url: "https://www.aerotime.aero/feed", category: "aviation" as const },
  { name: "AeroTime RSS", url: "https://www.aerotime.aero/rss", category: "aviation" as const },
  { name: "AIRLIVE.net", url: "https://www.airlive.net/feed/", category: "aviation" as const },
  { name: "Aviation A2Z", url: "https://aviationa2z.com/index.php/feed/", category: "aviation" as const },
  { name: "The Aviationist", url: "https://theaviationist.com/feed/", category: "aviation" as const },
  { name: "The Aviation Geek Club", url: "https://theaviationgeekclub.com/feed/", category: "aviation" as const },
  { name: "View from the Wing", url: "http://boardingarea.com/blogs/viewfromthewing/feed/", category: "aviation" as const },
  { name: "AeroTelegraph", url: "https://www.aerotelegraph.com/feed", category: "aviation" as const },
  { name: "AviationSource News", url: "https://aviationsourcenews.com/feed/", category: "aviation" as const },
  { name: "One Mile at a Time", url: "https://onemileatatime.com/feed/", category: "aviation" as const },
  { name: "AOPA General Aviation News", url: "https://www.aopa.org/rss", category: "aviation" as const },
  { name: "Aviation Humor", url: "https://aviationhumor.net/feed/", category: "aviation" as const },
  { name: "Airlines Aviation Economic Times", url: "https://economictimes.indiatimes.com/rssfeeds/13354027.cms", category: "aviation" as const },
  // NOTE: TIME, Guardian, WSJ, Independent are general news sources — moved to viral
  // so they go through the strict aviation keyword gate instead of bypassing it.
  { name: "TIME", url: "https://time.com/feed/", category: "viral" as const },
  { name: "The Guardian World", url: "https://feeds.guardian.co.uk/theguardian/world/rss", category: "viral" as const },
  { name: "WSJ World News", url: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews", category: "viral" as const },
  { name: "Independent", url: "https://www.independent.co.uk/rss", category: "viral" as const },

  // ── VIRAL SOURCES ─────────────────────────────────────────────────────────
  { name: "New York Post", url: "https://nypost.com/feed/", category: "viral" as const },
  { name: "New York Post News", url: "http://www.nypost.com/rss/news.xml", category: "viral" as const },
  { name: "ABC News Top Stories", url: "https://feeds.abcnews.com/abcnews/topstories", category: "viral" as const },
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml", category: "viral" as const },
  { name: "Mail Online Home", url: "https://www.dailymail.co.uk/home/index.rss", category: "viral" as const },
  { name: "Mail Online News", url: "https://www.dailymail.co.uk/news/index.rss", category: "viral" as const },
  { name: "LADbible", url: "https://www.ladbible.com/index.rss", category: "viral" as const },
  { name: "The Sun YouTube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCIzXayRP7-P0ANpq-nD-h5g", category: "viral" as const },
  { name: "CNN YouTube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCupvZG-5ko_eiXAupbDfxWw", category: "viral" as const },
  { name: "Washington Post World", url: "https://feeds.washingtonpost.com/rss/world", category: "viral" as const },
  { name: "NBC News", url: "https://feeds.nbcnews.com/nbcnews/public/news", category: "viral" as const },

  // ── PASSENGER CHAOS ───────────────────────────────────────────────────────
  { name: "Flight Emergency Google News", url: "https://news.google.com/news/rss/search?q=flight%20emergency&hl=en", category: "viral" as const },
];

// ── Aviation relevance gate ───────────────────────────────────────────────────
// TWO-TIER FILTER:
//   - Aviation-native sources (category="aviation"): pass all stories through.
//     These sources are already curated aviation feeds — we trust them.
//     The filter was incorrectly blocking real aviation stories from these feeds.
//   - Viral/mainstream sources (category="viral"): apply strict keyword matching.
//     Only stories that explicitly mention aviation in the title get through.
//     We check title-only (not content) to avoid false positives from buried keywords.

// Strict keywords for viral/mainstream sources — title must contain one of these.
// Only unambiguous aviation-specific terms. No short abbreviations that appear in other contexts.
const VIRAL_SOURCE_AVIATION_KEYWORDS = [
  // Core aviation terms (unambiguous)
  "flight", "airline", "airlines", "airport", "airports", "aircraft", "plane", "planes",
  "pilot", "pilots", "aviation", "aviator",
  // Manufacturers & models (all unambiguous)
  "boeing", "airbus", "embraer", "bombardier", "cessna", "gulfstream", "dassault",
  "a380", "a350", "a330", "a320", "a321", "a319", "a318", "a220",
  "747", "737", "777", "787", "767", "757", "727", "717",
  "dreamliner", "concorde", "supersonic jet",
  // Infrastructure (unambiguous in title context)
  "runway", "taxiway", "tarmac", "hangar",
  "cockpit", "flight attendant", "air hostess", "stewardess",
  "air traffic control", "air traffic controller",
  // Regulators
  "faa ", "ntsb", "easa", "icao", "iata",
  // Incidents (specific phrases only)
  "plane crash", "aircraft crash", "mid-air collision", "runway collision",
  "aviation incident", "aviation accident", "flight emergency", "in-flight emergency", "mayday",
  "emergency landing", "belly landing", "bird strike", "engine failure",
  "flight diverted", "plane diverted", "plane grounded",
  // Passenger experience (specific phrases)
  "passenger chaos", "passengers stranded", "flight cancelled", "flight delayed",
  "checked baggage", "carry-on", "overhead bin", "first class", "business class",
  "economy class", "airport lounge", "flight lounge",
  // Aircraft types (specific enough)
  "helicopter crash", "helicopter emergency", "private jet", "cargo plane", "cargo aircraft",
  "low-cost carrier", "budget airline",
  // Airlines by full name (no ambiguous short names)
  "united airlines", "american airlines", "delta air", "southwest airlines", "spirit airlines",
  "ryanair", "easyjet", "wizz air", "british airways", "virgin atlantic",
  "lufthansa", "air france", "klm", "emirates", "etihad", "qatar airways",
  "singapore airlines", "cathay pacific", "qantas", "air canada",
  "turkish airlines", "aeromexico", "frontier airlines", "allegiant", "jetblue",
  "alaska airlines", "hawaiian airlines", "indigo airlines", "air india",
  "flydubai", "flyadeal", "wizz", "vueling", "transavia", "norwegian air",
  "sun country", "breeze airways", "avelo airlines", "riyadh air",
  // Airports by full name (not 3-letter codes which are too ambiguous)
  "heathrow", "gatwick", "stansted", "jfk airport", "lax airport",
  "o'hare", "ohare airport", "schiphol", "charles de gaulle",
  "frankfurt airport", "dubai airport", "changi airport", "hong kong airport",
  "narita", "incheon airport", "doha airport",
];

export function isAviationRelevant(title: string, content: string, category: string): boolean {
  // Aviation-native sources: trust the source, pass everything through.
  // These are dedicated aviation publications — every story is relevant by definition.
  if (category === "aviation") {
    return true;
  }

  // Viral/mainstream sources: check the TITLE ONLY against strict aviation keywords.
  // We check title only (not content) to avoid false positives from buried mentions
  // like "cabin" in "Cabinet reshuffle" or "lax" in "relaxed attitude".
  const titleLower = title.toLowerCase();
  return VIRAL_SOURCE_AVIATION_KEYWORDS.some((kw) => titleLower.includes(kw));
}

/** How far back (in days) to accept articles from RSS feeds. */
const RSS_LOOKBACK_DAYS = 7;

/**
 * Fetch and parse a single RSS feed.
 * Articles older than RSS_LOOKBACK_DAYS are silently skipped so stale
 * stories from slow-updating feeds never surface on the dashboard.
 */
export async function fetchRssFeed(
  feedUrl: string,
  sourceName: string,
): Promise<FetchedStory[]> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const items = feed.items || [];
    const cutoff = new Date(Date.now() - RSS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const results: FetchedStory[] = [];
    for (const item of items) {
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      // Skip articles older than the lookback window (but keep those with no date)
      if (pubDate && pubDate < cutoff) continue;

      const rawContent =
        (item as any)["content:encoded"] ||
        item.content ||
        item.contentSnippet ||
        (item as any).summary ||
        "";

      let plainContent = rawContent;
      try {
        const root = parseHtml(rawContent);
        plainContent = root.text || rawContent;
      } catch {
        // keep rawContent if parse fails
      }

      // Resolve Google News redirect URLs to real article URLs.
      // Google News RSS items have links like:
      //   https://news.google.com/rss/articles/CBMi...
      // These are not fetchable — extract the real URL from the item's
      // <source> tag URL or from the description HTML <a href> attributes.
      let sourceUrl = item.link || feedUrl;
      if (sourceUrl.includes("news.google.com")) {
        // Try to extract real URL from description HTML
        const descHtml: string = (item as any)["content:encoded"] || item.content || item.contentSnippet || "";
        const hrefMatch = descHtml.match(/href="(https?:\/\/(?!news\.google\.com)[^"]+)"/);
        if (hrefMatch) {
          sourceUrl = hrefMatch[1];
        } else {
          // Try the source element URL (publisher's homepage — not ideal but better than Google redirect)
          const sourceUrl2 = (item as any).source?.url;
          if (sourceUrl2 && !sourceUrl2.includes("google.com")) sourceUrl = sourceUrl2;
        }
      }

      results.push({
        title: (item.title || "Untitled").trim(),
        sourceUrl,
        sourceName: feed.title || sourceName,
        content: plainContent.replace(/\s+/g, " ").trim().slice(0, 4000),
        publishedAt: pubDate,
      });
    }
    return results;
  } catch (err) {
    console.error(`[RSS] Failed to fetch ${feedUrl}:`, err);
    return [];
  }
}

/**
 * Fetch a single article URL and extract its main text content.
 * Used for manual URL paste ingestion.
 */
export async function fetchArticleContent(url: string): Promise<{
  title: string;
  content: string;
  publishedAt: Date | null;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const root = parseHtml(html);

    // Remove script, style, nav, footer, header elements
    root.querySelectorAll("script, style, nav, footer, header, aside, .ad, .advertisement").forEach(el => el.remove());

    // Extract title
    const title =
      root.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
      root.querySelector("title")?.text ||
      root.querySelector("h1")?.text ||
      "Untitled";

    // Try to extract main article content
    const articleSelectors = [
      "article",
      '[class*="article-body"]',
      '[class*="article-content"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[class*="story-body"]',
      '[class*="content-body"]',
      "main",
    ];

    let content = "";
    for (const selector of articleSelectors) {
      const el = root.querySelector(selector);
      if (el && el.text.trim().length > 200) {
        content = el.text.replace(/\s+/g, " ").trim();
        break;
      }
    }

    if (!content) {
      const paragraphs = root.querySelectorAll("p");
      content = paragraphs
        .map((p) => p.text.trim())
        .filter((t) => t.length > 40)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Try to extract published date
    let publishedAt: Date | null = null;
    const dateSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="pubdate"]',
      'time[datetime]',
    ];
    for (const sel of dateSelectors) {
      const el = root.querySelector(sel);
      const dt = el?.getAttribute("content") || el?.getAttribute("datetime");
      if (dt) {
        const parsed = new Date(dt);
        if (!isNaN(parsed.getTime())) {
          publishedAt = parsed;
          break;
        }
      }
    }

    return {
      title: title.trim().slice(0, 500),
      content: content.slice(0, 6000),
      publishedAt,
    };
  } catch (err) {
    console.error(`[Fetch] Failed to fetch article ${url}:`, err);
    throw new Error(`Could not fetch article: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Key aviation entities — if two titles share the same aircraft type + incident keyword,
// they are almost certainly covering the same story even with different wording.
const INCIDENT_KEYWORDS = [
  "crash", "emergency", "divert", "diverted", "diversion",
  "fire", "smoke", "engine", "failure", "incident", "accident", "collision",
  "strike", "birdstrike", "delay", "cancel", "grounded", "evacuate", "evacuation",
  "hijack", "bomb", "threat", "arrest", "fight", "brawl",
  "prototype", "maiden", "first flight", "delivery",
];
const AIRCRAFT_ENTITY_KEYWORDS = [
  "737", "747", "757", "767", "777", "787", "a220", "a320", "a321", "a330", "a350", "a380",
  "b-21", "b-2", "b-52", "f-35", "f-22", "c-17", "c-130", "kc-46",
  "gulfstream", "bombardier", "embraer", "cessna", "pilatus",
  "ryanair", "easyjet", "emirates", "lufthansa", "british airways", "delta", "united",
  "american", "southwest", "qantas", "singapore", "cathay", "turkish", "air india",
  "raider", "raptor", "lightning", "globemaster", "hercules",
];

/**
 * Duplicate detection: checks if a new title is too similar to existing titles.
 * Uses two strategies:
 * 1. Word-overlap Jaccard similarity (threshold 0.45 — catches same story from different outlets)
 * 2. Key-phrase dedup: same aircraft entity + same incident keyword = same story
 */
export function isSimilarTitle(newTitle: string, existingTitles: string[]): boolean {
  const normalise = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3);

  const newWordsArr = normalise(newTitle);
  const newWords = new Set(newWordsArr);
  if (newWords.size === 0) return false;

  // Extract key-phrase fingerprint from this title
  const newLc = newTitle.toLowerCase();
  const newAircraft = AIRCRAFT_ENTITY_KEYWORDS.filter(k => newLc.includes(k));
  const newIncident = INCIDENT_KEYWORDS.filter(k => newLc.includes(k));

  for (const existing of existingTitles) {
    const existingWordsArr = normalise(existing);
    const existingWords = new Set(existingWordsArr);
    const intersection = newWordsArr.filter((w) => existingWords.has(w));
    const unionSize = new Set(newWordsArr.concat(existingWordsArr)).size;
    // Lowered from 0.65 → 0.45: catches same-incident stories from different outlets
    const similarity = intersection.length / unionSize;
    if (similarity > 0.45) return true;

    // Key-phrase dedup: same aircraft entity AND same incident type = same story
    // e.g. "Ryanair 737 diverted" and "Boeing 737 diversion forces Ryanair flight down" both match
    if (newAircraft.length > 0 && newIncident.length > 0) {
      const existingLc = existing.toLowerCase();
      const sharesAircraft = newAircraft.some(k => existingLc.includes(k));
      const sharesIncident = newIncident.some(k => existingLc.includes(k));
      if (sharesAircraft && sharesIncident) return true;
    }
  }

  return false;
}
