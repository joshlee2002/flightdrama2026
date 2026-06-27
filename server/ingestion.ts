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

// ── All confirmed source URLs — comprehensive aviation + viral coverage ──────
// Last expanded: 2026-06-12. Sources are grouped by tier:
//   "aviation"  — dedicated aviation publications, pass ALL stories through
//   "regulator" — official safety/regulatory bodies, pass ALL stories through
//   "viral"     — general/mainstream media, strict aviation keyword gate applied
//   "google"    — Google News topic searches, strict keyword gate applied
export const DEFAULT_RSS_SOURCES = [

  // ── TIER 1: CORE AVIATION NEWS ────────────────────────────────────────────
  // High-volume, high-quality aviation-native publications. Every story is relevant.
  { name: "Simple Flying", url: "https://simpleflying.com/feed/", category: "aviation" as const },
  { name: "Simple Flying Aviation News", url: "https://simpleflying.com/feed/category/aviation-news/", category: "aviation" as const },
  { name: "AeroTime", url: "https://www.aerotime.aero/feed", category: "aviation" as const },
  { name: "AeroTime RSS", url: "https://www.aerotime.aero/rss", category: "aviation" as const },
  { name: "AIRLIVE.net", url: "https://www.airlive.net/feed/", category: "aviation" as const },
  { name: "Aviation A2Z", url: "https://aviationa2z.com/index.php/feed/", category: "aviation" as const },
  { name: "The Aviationist", url: "https://theaviationist.com/feed/", category: "aviation" as const },
  { name: "The Aviation Geek Club", url: "https://theaviationgeekclub.com/feed/", category: "aviation" as const },
  { name: "AeroTelegraph", url: "https://www.aerotelegraph.com/feed", category: "aviation" as const },
  { name: "AviationSource News", url: "https://aviationsourcenews.com/feed/", category: "aviation" as const },
  { name: "AOPA General Aviation News", url: "https://www.aopa.org/rss", category: "aviation" as const },
  { name: "Aviation Humor", url: "https://aviationhumor.net/feed/", category: "aviation" as const },
  { name: "Airlines Aviation Economic Times", url: "https://economictimes.indiatimes.com/rssfeeds/13354027.cms", category: "aviation" as const },

  // ── TIER 2: NEW AVIATION SOURCES (verified working 2026-06-12) ────────────
  // Fills major gaps: AirlineGeeks, AVweb, FlightGlobal, ch-aviation, Flightradar24 blog
  { name: "AirlineGeeks", url: "https://airlinegeeks.com/feed/", category: "aviation" as const },
  { name: "AVweb", url: "https://www.avweb.com/feed/", category: "aviation" as const },
  { name: "FlightGlobal", url: "https://www.flightglobal.com/feed", category: "aviation" as const },
  { name: "ch-aviation Blog", url: "https://about.ch-aviation.com/feed/", category: "aviation" as const },
  { name: "Flightradar24 Blog", url: "https://www.flightradar24.com/blog/feed/", category: "aviation" as const },
  { name: "Flying Magazine", url: "https://www.flyingmag.com/feed/", category: "aviation" as const },
  { name: "AirlineReporter", url: "https://www.airlinereporter.com/feed/", category: "aviation" as const },
  { name: "Cranky Flier", url: "https://crankyflier.com/feed/", category: "aviation" as const },
  { name: "Fear of Landing", url: "https://fearoflanding.com/feed/", category: "aviation" as const },
  { name: "Airinsight", url: "https://airinsight.com/feed/", category: "aviation" as const },
  { name: "Paddle Your Own Kanoo", url: "https://paddleyourownkanoo.com/feed/", category: "aviation" as const },

  // ── TIER 3: PASSENGER / CONSUMER AVIATION ────────────────────────────────
  // Travel-focused but aviation-heavy — good for passenger chaos and airline drama
  { name: "One Mile at a Time", url: "https://onemileatatime.com/feed/", category: "aviation" as const },
  { name: "View from the Wing", url: "http://boardingarea.com/blogs/viewfromthewing/feed/", category: "aviation" as const },
  { name: "Live and Lets Fly", url: "https://liveandletsfly.com/feed/", category: "aviation" as const },
  { name: "Head for Points", url: "https://headforpoints.com/feed/", category: "aviation" as const },
  { name: "The Points Guy", url: "https://thepointsguy.com/feed/", category: "aviation" as const },
  { name: "Boarding Area", url: "https://boardingarea.com/feed/", category: "aviation" as const },
  { name: "Business Traveller", url: "https://www.businesstraveller.com/feed/", category: "aviation" as const },
  { name: "Condé Nast Traveler", url: "https://www.cntraveler.com/feed/rss", category: "aviation" as const },

  // ── TIER 4: REGULATOR & SAFETY SOURCES ───────────────────────────────────
  // Official bodies — every story is aviation-relevant by definition
  // These are the sources that break real incidents before anyone else
  { name: "EASA Newsroom", url: "https://www.easa.europa.eu/en/newsroom-and-events/news/rss.xml", category: "regulator" as const },

  // ── TIER 5: GOOGLE NEWS TOPIC FEEDS ──────────────────────────────────────
  // Targeted searches that catch stories missed by all other feeds.
  // These use the strict aviation keyword gate (category="google").
  // They are invaluable for catching breaking incidents from any global outlet.
  { name: "GNews: Aviation Accident", url: "https://news.google.com/rss/search?q=aviation+accident&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: Plane Crash", url: "https://news.google.com/rss/search?q=plane+crash&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: Airline Incident", url: "https://news.google.com/rss/search?q=airline+incident&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: Flight Emergency", url: "https://news.google.com/news/rss/search?q=flight%20emergency&hl=en", category: "viral" as const },
  { name: "GNews: Boeing", url: "https://news.google.com/rss/search?q=Boeing+aviation&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: Airbus", url: "https://news.google.com/rss/search?q=Airbus+aviation&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: Pilot Strike", url: "https://news.google.com/rss/search?q=pilot+strike+airline&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: Airport Chaos", url: "https://news.google.com/rss/search?q=airport+chaos+flight+cancelled&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: NTSB", url: "https://news.google.com/rss/search?q=NTSB+aviation&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },
  { name: "GNews: FAA Safety", url: "https://news.google.com/rss/search?q=FAA+aviation+safety&hl=en-US&gl=US&ceid=US:en", category: "viral" as const },

  // ── TIER 6: MAINSTREAM VIRAL SOURCES ─────────────────────────────────────
  // General news — strict aviation keyword gate applied.
  // Catches viral passenger stories, celebrity jet drama, airline controversies.
  { name: "TIME", url: "https://time.com/feed/", category: "viral" as const },
  { name: "The Guardian World", url: "https://feeds.guardian.co.uk/theguardian/world/rss", category: "viral" as const },
  { name: "WSJ World News", url: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews", category: "viral" as const },
  { name: "Independent", url: "https://www.independent.co.uk/rss", category: "viral" as const },
  { name: "New York Post", url: "https://nypost.com/feed/", category: "viral" as const },
  { name: "New York Post News", url: "http://www.nypost.com/rss/news.xml", category: "viral" as const },
  { name: "ABC News Top Stories", url: "https://feeds.abcnews.com/abcnews/topstories", category: "viral" as const },
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml", category: "viral" as const },
  { name: "Mail Online Home", url: "https://www.dailymail.co.uk/home/index.rss", category: "viral" as const },
  { name: "Mail Online News", url: "https://www.dailymail.co.uk/news/index.rss", category: "viral" as const },
  { name: "LADbible", url: "https://www.ladbible.com/index.rss", category: "viral" as const },
  { name: "Washington Post World", url: "https://feeds.washingtonpost.com/rss/world", category: "viral" as const },
  { name: "NBC News", url: "https://feeds.nbcnews.com/nbcnews/public/news", category: "viral" as const },
  { name: "Skift", url: "https://skift.com/feed/", category: "viral" as const },
  { name: "Reddit r/aviation", url: "https://www.reddit.com/r/aviation/.rss", category: "viral" as const },

  // ── TIER 7: YOUTUBE CHANNELS ──────────────────────────────────────────────
  // Video-first sources — good for catching viral aviation clips and breaking news
  { name: "The Sun YouTube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCIzXayRP7-P0ANpq-nD-h5g", category: "viral" as const },
  { name: "CNN YouTube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCupvZG-5ko_eiXAupbDfxWw", category: "viral" as const },
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
  // Core aviation terms
  "flight", "airline", "airlines", "airport", "airports", "aircraft", "plane", "planes",
  "pilot", "pilots", "co-pilot", "copilot", "aviation", "aviator", "airfare", "airfares",
  "fly ", "flying ", "flew ", "flyer", "frequent flyer",
  // Manufacturers & models
  "boeing", "airbus", "embraer", "bombardier", "cessna", "gulfstream", "dassault", "saab",
  "lockheed", "mcdonnell douglas", "de havilland", "atr ", "fokker",
  "a380", "a350", "a330", "a320", "a321", "a319", "a318", "a220", "a310", "a300",
  "747", "737", "777", "787", "767", "757", "727", "717", "707",
  "dreamliner", "concorde", "supersonic jet", "max 8", "max 9", "737 max",
  // Infrastructure
  "runway", "taxiway", "tarmac", "hangar", "terminal ", "departure gate", "boarding gate",
  "cockpit", "flight deck", "flight attendant", "cabin crew", "air hostess", "stewardess",
  "air traffic control", "air traffic controller", "atc ",
  // Regulators & bodies
  "faa ", "ntsb", "easa", "icao", "iata", "caa ", "dgca",
  // Incidents & safety
  "plane crash", "aircraft crash", "mid-air collision", "runway collision", "runway incursion",
  "aviation incident", "aviation accident", "flight emergency", "in-flight emergency", "mayday",
  "emergency landing", "belly landing", "bird strike", "engine failure", "engine fire",
  "flight diverted", "plane diverted", "plane grounded", "aircraft grounded",
  "turbulence", "severe turbulence", "depressurisation", "decompression",
  "near miss", "near-miss", "close call", "runway excursion", "overrun",
  "ditching", "ditched", "crash landing", "hard landing",
  // Passenger experience
  "passenger chaos", "passengers stranded", "flight cancelled", "flight delayed",
  "flight cancellation", "mass cancellation", "stranded passengers",
  "checked baggage", "carry-on", "overhead bin", "hand luggage",
  "first class", "business class", "economy class", "premium economy",
  "airport lounge", "flight lounge", "boarding pass", "check-in",
  "seat upgrade", "bumped from flight", "overbooking", "overbooked",
  "lost luggage", "delayed baggage", "baggage claim",
  "airline staff", "airline crew", "unruly passenger", "disruptive passenger",
  "passenger removed", "passenger arrested", "passenger banned",
  "mile high", "miles high",
  // Aircraft types
  "helicopter", "private jet", "cargo plane", "cargo aircraft", "cargo flight",
  "low-cost carrier", "budget airline", "charter flight", "charter plane",
  "military aircraft", "fighter jet", "drone strike", "unmanned aircraft",
  // Loyalty & points
  "frequent flyer", "air miles", "airmiles", "airline miles", "avios", "skywards",
  "mileage plus", "advantage miles", "rapidrewards", "trueblue",
  // Airlines — full names and common short forms
  "united airlines", "american airlines", "delta air", "southwest airlines", "spirit airlines",
  "ryanair", "easyjet", "wizz air", "british airways", "virgin atlantic", "virgin australia",
  "lufthansa", "air france", "klm", "emirates", "etihad", "qatar airways",
  "singapore airlines", "cathay pacific", "qantas", "air canada",
  "turkish airlines", "aeromexico", "frontier airlines", "allegiant", "jetblue",
  "alaska airlines", "hawaiian airlines", "indigo airlines", "air india",
  "flydubai", "flyadeal", "wizz", "vueling", "transavia", "norwegian air",
  "sun country", "breeze airways", "avelo airlines", "riyadh air",
  "air arabia", "flyone", "corendon", "tui airways", "jet2", "loganair",
  "aer lingus", "iberia", "tap air", "finnair", "sas ", "scandinavian airlines",
  "swiss air", "swiss international", "austrian airlines", "brussels airlines",
  "air europa", "volotea", "wizz", "pegasus airlines", "sunexpress",
  "air new zealand", "air pacific", "fiji airways", "royal brunei",
  "malaysia airlines", "garuda", "thai airways", "vietnam airlines",
  "china eastern", "china southern", "air china", "hainan airlines",
  "korean air", "asiana", "japan airlines", "ana ", "all nippon",
  "indigo ", "spicejet", "vistara", "go first", "akasa air",
  "flydubai", "air arabia", "oman air", "gulf air", "kuwait airways",
  "saudia", "flynas", "egyptair", "ethiopian airlines", "kenya airways",
  "south african airways", "rwandair", "air mauritius",
  "aerolíneas argentinas", "latam", "avianca", "copa airlines", "sky airline",
  "westjet", "air transat", "porter airlines",
  // Airports — major ones by name
  "heathrow", "gatwick", "stansted", "luton airport", "manchester airport",
  "edinburgh airport", "glasgow airport", "birmingham airport",
  "jfk airport", "lax airport", "o'hare", "ohare airport", "laguardia",
  "schiphol", "charles de gaulle", "orly airport",
  "frankfurt airport", "munich airport", "berlin airport",
  "dubai airport", "abu dhabi airport", "doha airport",
  "changi airport", "hong kong airport", "narita", "haneda",
  "incheon airport", "beijing airport", "shanghai airport",
  "sydney airport", "melbourne airport",
  "toronto pearson", "vancouver airport",
  "madrid airport", "barcelona airport", "rome airport", "milan airport",
  "istanbul airport", "athens airport", "amsterdam airport",
];

export function isAviationRelevant(title: string, content: string, category: string): boolean {
  // Aviation-native sources: trust the source, pass everything through.
  // These are dedicated aviation publications — every story is relevant by definition.
  if (category === "aviation") {
    return true;
  }

  // Regulator sources (EASA, NTSB, FAA, ICAO): always pass through.
  // Every story from an official safety body is relevant to aviation by definition.
  if (category === "regulator") {
    return true;
  }

  // Viral/mainstream sources: check the TITLE ONLY against strict aviation keywords.
  // We check title only (not content) to avoid false positives from buried mentions
  // like "cabin" in "Cabinet reshuffle" or "lax" in "relaxed attitude".
  const titleLower = title.toLowerCase();
  return VIRAL_SOURCE_AVIATION_KEYWORDS.some((kw) => titleLower.includes(kw));
}

/** How far back (in days) to accept articles from RSS feeds. */
const RSS_LOOKBACK_DAYS = 2;

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
  "dead", "killed", "death", "fatal", "fatality", "injured", "injuries",
  "missing", "overrun", "excursion", "depressurisation", "decompression",
  "turbulence", "mayday", "ditching", "ditched", "belly landing", "hard landing",
  "near miss", "close call", "runway incursion", "mid-air",
];
const AIRCRAFT_ENTITY_KEYWORDS = [
  "737", "747", "757", "767", "777", "787", "a220", "a320", "a321", "a330", "a350", "a380",
  "b-21", "b-2", "b-52", "f-35", "f-22", "c-17", "c-130", "kc-46",
  "gulfstream", "bombardier", "embraer", "cessna", "pilatus",
  "ryanair", "easyjet", "emirates", "lufthansa", "british airways", "delta", "united",
  "american", "southwest", "qantas", "singapore", "cathay", "turkish", "air india",
  "raider", "raptor", "lightning", "globemaster", "hercules",
  // Additional airlines frequently in the news
  "wizz", "jetblue", "alaska airlines", "frontier", "spirit", "indigo", "flydubai",
  "air france", "klm", "iberia", "finnair", "tap air", "aer lingus", "norwegian",
  "air canada", "westjet", "air new zealand", "malaysia airlines", "thai airways",
  "china eastern", "china southern", "air china", "korean air", "japan airlines",
  "etihad", "qatar airways", "saudia", "ethiopian airlines",
  // Additional aircraft types
  "a319", "a318", "a310", "a300", "717", "727", "707", "max 8", "max 9",
  "dreamliner", "concorde", "superjet", "crj", "atr", "dash 8",
];

// Stop-words to strip before Jaccard — these words are so common in aviation
// headlines that they inflate similarity between unrelated stories.
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "after",
  "over", "into", "onto", "upon", "about", "been", "were", "will", "when",
  "what", "which", "their", "they", "them", "then", "than", "more", "also",
  "says", "said", "amid", "small", "least", "local", "govt", "person",
  "flight", "plane", "aircraft", "airline", "airlines", "airport",
  "pilot", "pilots", "aviation", "flying", "flies", "flew",
]);

// Location keywords — city/country/region names that appear in aviation incident titles.
// Used for event-fingerprint dedup: same location + same incident type = same story.
const LOCATION_KEYWORDS = [
  // Cities
  "beijing", "shanghai", "tokyo", "seoul", "dubai", "london", "paris", "berlin",
  "amsterdam", "frankfurt", "madrid", "rome", "istanbul", "moscow", "delhi",
  "mumbai", "singapore", "bangkok", "jakarta", "sydney", "melbourne", "auckland",
  "toronto", "montreal", "vancouver", "new york", "chicago", "los angeles",
  "miami", "houston", "dallas", "seattle", "denver", "atlanta", "boston",
  "washington", "san francisco", "las vegas", "phoenix", "orlando",
  "mexico city", "bogota", "lima", "santiago", "sao paulo", "buenos aires",
  "cairo", "nairobi", "lagos", "johannesburg", "casablanca", "addis ababa",
  "karachi", "lahore", "dhaka", "kathmandu", "colombo", "kabul", "tehran",
  "baghdad", "riyadh", "jeddah", "doha", "abu dhabi", "muscat", "kuwait",
  "tel aviv", "beirut", "amman", "ankara", "athens", "budapest", "warsaw",
  "prague", "vienna", "brussels", "zurich", "geneva", "lisbon", "stockholm",
  "oslo", "copenhagen", "helsinki", "riga", "tallinn", "vilnius",
  // Countries (short forms used in headlines)
  "china", "japan", "india", "russia", "ukraine", "iran", "iraq", "pakistan",
  "nepal", "indonesia", "philippines", "vietnam", "thailand", "malaysia",
  "australia", "brazil", "colombia", "peru", "chile", "argentina", "mexico",
  "canada", "france", "germany", "spain", "italy", "turkey", "egypt",
  "nigeria", "kenya", "ethiopia", "south africa", "israel", "saudi arabia",
  // Airports (IATA codes and common names)
  "heathrow", "gatwick", "stansted", "schiphol", "charles de gaulle",
  "jfk", "lax", "ohare", "dulles", "miami airport", "newark",
  "changi", "narita", "haneda", "incheon",
];

// Airline-specific keywords — used for airline+incident dedup
const AIRLINE_KEYWORDS = [
  "ryanair", "easyjet", "emirates", "lufthansa", "british airways", "delta", "united",
  "american", "southwest", "qantas", "singapore", "cathay", "turkish", "air india",
  "wizz", "jetblue", "alaska airlines", "frontier", "spirit", "indigo", "flydubai",
  "air france", "klm", "iberia", "finnair", "tap air", "aer lingus", "norwegian",
  "air canada", "westjet", "air new zealand", "malaysia airlines", "thai airways",
  "china eastern", "china southern", "air china", "korean air", "japan airlines",
  "etihad", "qatar airways", "saudia", "ethiopian airlines",
];

/**
 * Duplicate detection: checks if a new title is too similar to existing titles.
 * Uses four strategies:
 * 1. Word-overlap Jaccard similarity (threshold 0.35)
 * 2. Aircraft/airline entity + incident keyword = same story
 * 3. Airline-only + incident keyword = same story
 * 4. Location + incident keyword = same story (catches "Beijing crash" from 5 outlets)
 */
export function isSimilarTitle(newTitle: string, existingTitles: string[]): boolean {
  const normalise = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  const newWordsArr = normalise(newTitle);
  const newWords = new Set(newWordsArr);
  if (newWords.size === 0) return false;

  // Extract fingerprint components from the new title
  const newLc = newTitle.toLowerCase();
  const newAircraft = AIRCRAFT_ENTITY_KEYWORDS.filter(k => newLc.includes(k));
  const newIncident = INCIDENT_KEYWORDS.filter(k => newLc.includes(k));
  const newAirlines = AIRLINE_KEYWORDS.filter(k => newLc.includes(k));
  const newLocations = LOCATION_KEYWORDS.filter(k => newLc.includes(k));

  for (const existing of existingTitles) {
    const existingWordsArr = normalise(existing);
    const existingWords = new Set(existingWordsArr);
    const intersection = newWordsArr.filter((w) => existingWords.has(w));
    const unionSize = new Set(newWordsArr.concat(existingWordsArr)).size;
    const similarity = unionSize > 0 ? intersection.length / unionSize : 0;
    if (similarity > 0.35) return true;

    const existingLc = existing.toLowerCase();

    // Strategy 2: same aircraft entity + same incident type
    if (newAircraft.length > 0 && newIncident.length > 0) {
      const sharesAircraft = newAircraft.some(k => existingLc.includes(k));
      const sharesIncident = newIncident.some(k => existingLc.includes(k));
      if (sharesAircraft && sharesIncident) return true;
    }

    // Strategy 3: same airline + same incident keyword
    if (newAirlines.length > 0 && newIncident.length > 0) {
      const sharesAirline = newAirlines.some(k => existingLc.includes(k));
      const sharesIncident = newIncident.some(k => existingLc.includes(k));
      if (sharesAirline && sharesIncident) return true;
    }

    // Strategy 4: same location + same incident keyword = same event from different outlet
    // This is the key fix for "Beijing plane crash" appearing from 5 sources.
    // Guard: only fire when BOTH titles have a location match AND an incident match,
    // to avoid false positives on e.g. "London Heathrow delays" vs "London Gatwick fire".
    if (newLocations.length > 0 && newIncident.length > 0) {
      const existingLocations = LOCATION_KEYWORDS.filter(k => existingLc.includes(k));
      const existingIncident = INCIDENT_KEYWORDS.filter(k => existingLc.includes(k));
      const sharesLocation = newLocations.some(k => existingLocations.includes(k));
      const sharesIncident = newIncident.some(k => existingIncident.includes(k));
      if (sharesLocation && sharesIncident) return true;
    }
  }

  return false;
}
