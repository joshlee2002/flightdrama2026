/**
 * imageSearch.ts
 * Multi-source licence-free image search for Soyunci.
 *
 * Sources (in priority order):
 *  1. Wikimedia Commons — no API key required, excellent aircraft coverage
 *  2. Pexels           — requires PEXELS_API_KEY env var (free tier: 200 req/hr)
 *  3. Unsplash         — requires UNSPLASH_ACCESS_KEY env var (free tier: 50 req/hr)
 *
 * All image URLs are routed through /api/image-proxy to avoid browser CORS/hotlink issues.
 * When no real image is found, a plain-text recommendation is returned instead.
 */

import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";

const WIKIMEDIA_UA = "Soyunci/1.0 (aviation-content-tool)";

// In-memory cache to avoid hammering Wikimedia with repeated identical queries
// (rate limiting is the #1 cause of empty results)
const wikiCache = new Map<string, { results: FoundImage[]; ts: number }>();
const WIKI_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Wrap an external image URL through the server-side proxy */
function proxyUrl(url: string): string {
  if (!url) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

export interface FoundImage {
  url: string;          // Proxied full-resolution URL
  thumbUrl: string;     // Proxied thumbnail URL (≤800px wide)
  title: string;        // Descriptive title
  source: "wikimedia" | "pexels" | "unsplash";
  licence: string;      // e.g. "CC BY-SA 4.0", "Pexels License"
  attribution: string;  // Photographer / author credit string
  pageUrl: string;      // Link to the original page (for attribution)
  description: string;  // Short description of the image
  mimeType?: string;    // e.g. "image/jpeg", "image/png" (populated for Wikimedia results)
  rawUrl?: string;      // Original (unproxied) URL — used as reference image for AI generation
}

// ── Wikimedia Commons ─────────────────────────────────────────────────────────

// File extensions that are actual photographs (skip SVG diagrams, PDFs, etc.)
const PHOTO_EXTS = /\.(jpe?g|png|webp|tiff?)$/i;

export async function searchWikimedia(query: string, limit = 6, offset = 0): Promise<FoundImage[]> {
  // Return cached results if fresh — avoids rate limiting when same query is repeated
  const cacheKey = `${query.toLowerCase().trim()}:${limit}:${offset}`;
  const cached = wikiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WIKI_CACHE_TTL) {
    return cached.results;
  }

  try {
    // Step 1: Search for file titles.
    // Use srlimit=200 to get plenty of candidates before filtering.
    // sroffset allows pagination — skip past already-seen results.
    const srlimit = Math.min(Math.max(limit * 3, 100), 200);
    const searchBody = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srnamespace: "6",
      srlimit: String(srlimit),
      sroffset: String(offset),
      format: "json",
    });
    const searchRes = await fetch("https://commons.wikimedia.org/w/api.php", {
      method: "POST",
      headers: { "User-Agent": WIKIMEDIA_UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: searchBody.toString(),
    });
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json() as any;
    const allFiles: string[] = (searchData.query?.search ?? []).map((r: any) => r.title as string);
    // Pre-filter: only keep titles that look like photos (jpg/png/webp/tiff)
    const photoFiles = allFiles.filter(t => PHOTO_EXTS.test(t));
    if (photoFiles.length === 0) return [];

    // Step 2: Fetch image info in TWO batch calls of 50 each (Wikimedia max per call).
    // We need 100 candidates to reliably fill 40 results after filtering out
    // TIFFs, non-photo mimes, missing thumbnails, and charts.
    const batch1 = photoFiles.slice(0, 50);
    const batch2 = photoFiles.slice(50, 100);

    const fetchBatch = async (titles: string[]): Promise<any[]> => {
      if (titles.length === 0) return [];
      const body = new URLSearchParams({
        action: "query",
        titles: titles.join("|"),
        prop: "imageinfo",
        iiprop: "url|extmetadata|mime",
        iiurlwidth: "320",  // API returns 330px URLs which are on Wikimedia's allowed-sizes list (400px is NOT allowed and returns HTTP 400)
        format: "json",
      });
      const res = await fetch("https://commons.wikimedia.org/w/api.php", {
        method: "POST",
        headers: { "User-Agent": WIKIMEDIA_UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return Object.values(data.query?.pages ?? {}) as any[];
    };

    // Fetch both batches in parallel — same IP, same session, Wikimedia allows this
    const [pages1, pages2] = await Promise.all([fetchBatch(batch1), fetchBatch(batch2)]);
    const allPages: any[] = [...pages1, ...pages2];



    const results: FoundImage[] = [];
    for (const page of allPages) {
      if (results.length >= limit) break;
      const ii = page.imageinfo?.[0];
      if (!ii?.url) continue;
      // Skip non-photo mime types — Wikimedia returns mime as imageinfo field
      // Fall back to extension check if mime is missing
      const mime = (ii.mime ?? ii.mediatype ?? "").toLowerCase();
      const titleLower = (page.title ?? "").toLowerCase();
      const hasPhotoExt = PHOTO_EXTS.test(titleLower);
      // Skip TIFFs entirely — they're huge (often 50MB+) and time out in the proxy
      if (mime.startsWith("image/tiff") || /\.tiff?$/i.test(titleLower)) continue;
      if (mime && mime !== "" && !mime.startsWith("image/jpeg") && !mime.startsWith("image/png") && !mime.startsWith("image/webp")) {
        if (!hasPhotoExt) continue; // Only skip if extension also doesn't look like a photo
      }
      // Skip if Wikimedia didn't generate a thumbnail (thumburl absent) — means the image is too
      // large or in an unsupported format; using the raw URL would time out the proxy
      if (!ii.thumburl) continue;
      // Reject charts, graphs, diagrams, financial documents, maps, and logos
      // These are not useful editorial photos for aviation stories
      // Only reject files that are clearly non-photographic (charts, diagrams, SVG vectors, etc.)
      // Keep it narrow — broad words like 'flag', 'figure', 'map', 'drawing' appear in real aircraft photo filenames
      const REJECT_TITLE = /\bchart\b|\bgraph\b|\bdiagram\b|\binfographic\b|\bschematic\b|\bblueprint\b|\bcartoon\b|\bclipart\b|\.svg\b|\bvector\b|\bbudget\b|\bbalance sheet\b|\bspreadsheet\b|\bsatellite image\b|\blandsat\b|\baerial view of river\b|\bdelta river\b|\briver delta\b|\btopograph/i;
      if (REJECT_TITLE.test(titleLower)) continue;

      const meta = ii.extmetadata ?? {};
      const stripHtml = (s: string) => (s ?? "").replace(/<[^>]+>/g, "").trim();
      const licence = meta.LicenseShortName?.value ?? "CC BY-SA";
      // Skip clearly non-free licences
      // Only skip licences that explicitly forbid reuse — CC licences often contain '©' so don't block on that
      if (/all rights reserved|no deriv|non-commercial/i.test(licence)) continue;

      const rawUrl: string = ii.url;
      const rawThumb: string = ii.thumburl ?? ii.url;
      // Normalise MIME type — Wikimedia returns e.g. "image/jpeg", "image/png"
      const normMime = mime.startsWith("image/") ? mime : "image/jpeg";

      results.push({
        url: proxyUrl(rawUrl),
        thumbUrl: rawThumb,  // Wikimedia CDN loads fine directly in browser — no proxy needed for thumbnails
        title: page.title?.replace(/^File:/, "").replace(/\.[^.]+$/, "") ?? query,
        source: "wikimedia",
        licence,
        attribution: stripHtml(meta.Artist?.value ?? meta.Credit?.value ?? "Wikimedia Commons"),
        pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title ?? "")}`,
        description: stripHtml(meta.ImageDescription?.value ?? "").slice(0, 200),
        mimeType: normMime,
        rawUrl,  // Unproxied URL — passed directly to AI image generation as reference
      });
    }
    // Store in cache
    wikiCache.set(cacheKey, { results, ts: Date.now() });
    return results;
  } catch (err) {
    console.error("[ImageSearch] Wikimedia error:", err);
    return [];
  }
}

// ── Pexels ────────────────────────────────────────────────────────────────────

export async function searchPexels(query: string, limit = 5): Promise<FoundImage[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${limit}&orientation=landscape`,
      { headers: { Authorization: key } }
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.photos ?? []).map((p: any): FoundImage => ({
      url: proxyUrl(p.src?.original ?? p.src?.large2x ?? p.src?.large),
      thumbUrl: proxyUrl(p.src?.medium ?? p.src?.small),
      title: p.alt ?? query,
      source: "pexels",
      licence: "Pexels License (free for commercial use)",
      attribution: `Photo by ${p.photographer} on Pexels`,
      pageUrl: p.url,
      description: p.alt ?? "",
    }));
  } catch (err) {
    console.error("[ImageSearch] Pexels error:", err);
    return [];
  }
}

// ── Unsplash ──────────────────────────────────────────────────────────────────

async function searchUnsplash(query: string, limit = 5): Promise<FoundImage[]> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${limit}&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${key}` } }
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.results ?? []).map((p: any): FoundImage => ({
      url: proxyUrl(p.urls?.full ?? p.urls?.regular),
      thumbUrl: proxyUrl(p.urls?.small ?? p.urls?.thumb),
      title: p.description ?? p.alt_description ?? query,
      source: "unsplash",
      licence: "Unsplash License (free for commercial use)",
      attribution: `Photo by ${p.user?.name} on Unsplash`,
      pageUrl: p.links?.html,
      description: (p.description ?? p.alt_description ?? "").slice(0, 200),
    }));
  } catch (err) {
    console.error("[ImageSearch] Unsplash error:", err);
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search for images across all available sources.
 * Returns up to `totalLimit` results, prioritising Wikimedia for aircraft-specific
 * queries and filling remaining slots from Pexels/Unsplash.
 */
/**
 * Score each candidate image for relevance to the story using keyword matching.
 * Free — no LLM call. Returns candidates sorted by relevance score (descending),
 * with clearly irrelevant images removed.
 */
function filterByRelevance(
  candidates: FoundImage[],
  storyTitle: string,
  searchQuery: string,
): Promise<FoundImage[]> {
  if (candidates.length === 0) return Promise.resolve(candidates);

  // Build a set of meaningful keywords from the story title and search query
  const stopWords = new Set(["the","a","an","and","or","of","in","on","at","to","for","with","is","was","are","were","has","had","its","after","over","from","that","this","as","by"]);
  const keywords = `${storyTitle} ${searchQuery}`
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .map(w => w.replace(/[^a-z0-9]/g, ""))
    .filter(w => w.length > 2 && !stopWords.has(w));

  const scored = candidates.map((img) => {
    const haystack = `${img.title} ${img.description}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) score += kw.length > 5 ? 3 : 1; // longer keywords = stronger signal
    }
    // Boost Wikimedia results slightly — they tend to be more specific aviation photos
    if (img.source === "wikimedia") score += 1;
    return { img, score };
  });

  // Sort by score descending; keep everything with score >= 1 (at least one keyword match)
  // If nothing matches at all, return original order as fallback
  const filtered = scored.filter(s => s.score >= 1).sort((a, b) => b.score - a.score);
  const result = filtered.length > 0 ? filtered.map(s => s.img) : candidates;
  return Promise.resolve(result);
}

/**
 * Generate fallback queries when the primary Wikimedia search returns too few results.
 * Progressively strips the query to its most essential parts.
 */
function buildFallbackQueries(query: string): string[] {
  const words = query.trim().split(/\s+/);
  const fallbacks: string[] = [];
  // Try progressively shorter versions of the query
  for (let len = words.length - 1; len >= 1; len--) {
    fallbacks.push(words.slice(0, len).join(" "));
  }
  // Also try last N words (e.g. just the aircraft type without the airline)
  if (words.length > 2) {
    fallbacks.push(words.slice(1).join(" "));
    fallbacks.push(words.slice(-2).join(" "));
  }
  // Deduplicate
  return Array.from(new Set(fallbacks)).filter(q => q.length > 2);
}

/**
 * Determine if a query is people/scene-oriented (Pexels first) vs hardware/aircraft (Wikimedia first).
 * Used by the smart combined search to route appropriately.
 */
export function isPeopleOrSceneQuery(query: string): boolean {
  const lc = query.toLowerCase();
  return /pilot|crew|passenger|flight attendant|steward|cabin|cockpit|uniform|person|people|worker|staff|officer|soldier|military person|airport lounge|departure|arrival|terminal|gate|security|boarding|lounge/.test(lc)
    && !/boeing|airbus|737|747|787|a320|a380|f-35|b-21|fighter jet|aircraft exterior|livery|airline paint|tail fin/.test(lc);
}

/**
 * Smart combined search: routes Pexels vs Wikimedia based on query type.
 * People/scene queries → Pexels first (better lifestyle shots).
 * Aircraft/hardware queries → Wikimedia first (better specific aviation photos).
 * Returns up to `totalLimit` merged results.
 */
export async function smartImageSearch(
  query: string,
  totalLimit = 8,
  storyTitle?: string,
  preferWikimedia?: boolean,
): Promise<FoundImage[]> {
  // preferWikimedia overrides the auto-detect when caller knows the slot type
  const isPeople = preferWikimedia !== undefined ? !preferWikimedia : isPeopleOrSceneQuery(query);
  const perSource = Math.ceil(totalLimit / 2) + 2;
  const wikiQuery = query.replace(/\s+(aircraft|photo|image|picture)\s*$/i, "").trim();

  const [pexels, wiki] = await Promise.all([
    searchPexels(query, perSource + 2),
    searchWikimedia(wikiQuery, perSource + 2),
  ]);

  // Interleave: preferred source first
  const primary = isPeople ? pexels : wiki;
  const secondary = isPeople ? wiki : pexels;
  const combined: FoundImage[] = [];
  const maxLen = Math.max(primary.length, secondary.length);
  for (let i = 0; i < maxLen && combined.length < totalLimit + 4; i++) {
    if (primary[i]) combined.push(primary[i]);
    if (combined.length < totalLimit + 4 && secondary[i]) combined.push(secondary[i]);
  }

  const filtered = storyTitle ? await filterByRelevance(combined, storyTitle, query) : combined;
  return filtered.slice(0, totalLimit);
}

export async function searchImages(
  query: string,
  totalLimit = 6,
  isAircraftSearch = false,
  storyTitle?: string,
): Promise<FoundImage[]> {
  // For aircraft searches, strip any trailing 'aircraft' or 'photo' noise the LLM might have added
  const wikiQuery = query.replace(/\s+(aircraft|photo|image|picture)\s*$/i, "").trim();
  // Fetch more candidates than needed so the relevance filter has enough to work with
  const perSource = Math.ceil(totalLimit / 2) + 2;

  // Try primary Wikimedia query first
  let wiki = await searchWikimedia(wikiQuery, perSource + 2);

  // If Wikimedia returns fewer than 2 results, try fallback queries
  // This handles cases where the combined query is too specific (e.g. rare airline+aircraft combo)
  if (wiki.length < 2 && isAircraftSearch) {
    const fallbacks = buildFallbackQueries(wikiQuery);
    for (const fallbackQuery of fallbacks) {
      console.log(`[ImageSearch] Wikimedia fallback: "${wikiQuery}" → "${fallbackQuery}"`);
      const fallbackResults = await searchWikimedia(fallbackQuery, perSource + 2);
      if (fallbackResults.length >= 2) {
        wiki = fallbackResults;
        break;
      }
      if (fallbackResults.length > wiki.length) {
        wiki = fallbackResults; // Take the best we have so far
      }
    }
  }

  const [pexels, unsplash] = await Promise.all([
    searchPexels(query, perSource),
    searchUnsplash(query, perSource),
  ]);

  // Pexels first (reliable, no IP restrictions), then Wikimedia, then Unsplash
  const combined: FoundImage[] = [];
  const maxLen = Math.max(wiki.length, pexels.length, unsplash.length);
  for (let i = 0; i < maxLen && combined.length < totalLimit + 4; i++) {
    if (pexels[i]) combined.push(pexels[i]);
    if (combined.length < totalLimit + 4 && wiki[i]) combined.push(wiki[i]);
    if (combined.length < totalLimit + 4 && unsplash[i]) combined.push(unsplash[i]);
  }

  // Apply LLM relevance filter when we have a story title to compare against
  const filtered = storyTitle
    ? await filterByRelevance(combined, storyTitle, query)
    : combined;

  return filtered.slice(0, totalLimit);
}

/**
 * Build two targeted Wikimedia Commons search queries for a story.
 *
 * Query 1 (aircraft): AIRLINE + AIRCRAFT TYPE — e.g. "Air Canada Boeing 787"
 *   This matches real Wikimedia filenames like:
 *   "Air Canada Boeing 787-9 Dreamliner C-FVND approaching EWR Airport.jpg"
 *
 * Query 2 (context): ROUTE/AIRPORT or CABIN/COCKPIT — e.g. "Vancouver International Airport terminal"
 *   Gives the destination/route atmosphere to complement the hero shot.
 *
 * Both queries are validated: if Wikimedia returns < 2 results for the primary
 * query, a fallback query is tried (just aircraft type, or just airline).
 */
export async function buildImageQueries(
  title: string,
  article: string,
  viralAngle: string
): Promise<{ aircraftQuery: string; contextQuery: string; aircraftAltQueries: string[]; contextAltQueries: string[] }> {
  // Use title + first 800 chars of article for context — enough to understand the story
  const snippet = article.slice(0, 800);
  console.log("[ImageSearch] Using LLM to generate precise image search queries");

  try {
    const response = await invokeLLM({
      model: undefined, // use default fast model
      messages: [
        {
          role: "system",
          content: `You are an image researcher for an aviation news publication. Given a story title and snippet, output exactly 4 image search queries that will find great, relevant editorial photos on Wikimedia Commons and Pexels.

Query 1 (hero): The PRIMARY visual subject. Think: what would you photograph to illustrate this story?
- Salary/pay/career story about military pilots → show the aircraft or branch (e.g. "US Air Force F-16 fighter jet", "US Navy F/A-18 Hornet")
- Airline incident/news → show the aircraft (e.g. "Boeing 737 MAX cockpit", "United Airlines 787 Dreamliner")
- Airport/travel story → show the location (e.g. "Heathrow airport terminal interior")
- Safety/accident story → show the aircraft type involved

Query 2 (context): A SUPPORTING human or scene element.
- Military story → "US Air Force pilot flight gear" or "military pilot cockpit"
- Airline story → "flight attendant cabin service" or "pilot pre-flight check"
- Career/salary story → "pilot in uniform" or "flight training simulator"

Query 3: Alternative for query 1 (same subject, different angle)
Query 4: Alternative for query 2 (same theme, different setting)

STRICT RULES:
- Keep each query under 7 words
- Use REAL aircraft types, airline names, military branch names
- NEVER include comparison words: "vs", "compared", "versus", "difference"
- NEVER include financial/abstract words: "salary", "pay", "bonus", "cost", "price", "budget", "revenue"
- NEVER use vague words alone: "aviation", "airplane", "flight" (always add specifics)
- Output ONLY valid JSON: {"q1":"...","q2":"...","q3":"...","q4":"..."}`,
        },
        {
          role: "user",
          content: `Title: ${title}\n\nSnippet: ${snippet}`,
        },
      ],
      response_format: { type: "json_object" } as any,
    });

    const raw = response?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    const q1 = (parsed.q1 ?? "").trim();
    const q2 = (parsed.q2 ?? "").trim();
    const q3 = (parsed.q3 ?? "").trim();
    const q4 = (parsed.q4 ?? "").trim();

    if (q1 && q2) {
      console.log(`[ImageSearch] LLM queries — hero: "${q1}" | context: "${q2}"`);
      return {
        aircraftQuery: q1.slice(0, 100),
        contextQuery: q2.slice(0, 100),
        aircraftAltQueries: [q3, q1.split(" ").slice(0, 3).join(" ")].filter(Boolean).slice(0, 3),
        contextAltQueries: [q4, q2.split(" ").slice(0, 3).join(" ")].filter(Boolean).slice(0, 3),
      };
    }
  } catch (err) {
    console.warn("[ImageSearch] LLM query generation failed, falling back to rule-based:", err);
  }

  // ── Fallback: rule-based extraction (used only if LLM call fails) ──
  const combined = `${title} ${article.slice(0, 2000)}`;
  console.log("[ImageSearch] Falling back to rule-based query extraction");

  // ── Step 1: Extract capitalised noun phrases from the article text ──
  // These are the actual words in the article — no pre-built list needed.
  // A noun phrase is 1-4 consecutive words where the first word starts with a capital letter
  // and subsequent words are either capitalised or known aviation connectors (of, the, Air, etc.)

  // Words that are too generic to be useful on their own
  const NOISE = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "up", "about", "into", "through", "during", "before", "after",
    "above", "below", "between", "out", "off", "over", "under", "again", "further",
    "then", "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
    "only", "own", "same", "so", "than", "too", "very", "just", "because", "as",
    "until", "while", "although", "though", "since", "unless", "however", "therefore",
    "said", "told", "according", "also", "its", "their", "his", "her", "our", "your",
    "this", "that", "these", "those", "which", "who", "whom", "whose", "what",
    "he", "she", "it", "they", "we", "i", "you", "me", "him", "us", "them",
    "was", "were", "is", "are", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "shall", "can", "must", "need", "dare", "ought", "used",
    "flight", "flights", "plane", "planes", "aircraft", "airline", "airlines",
    "airport", "airports", "passenger", "passengers", "crew", "pilot", "pilots",
  ]);

  // Aviation-relevant keywords that boost a phrase's score
  const AVIATION_BOOST = new Set([
    "boeing", "airbus", "embraer", "bombardier", "gulfstream", "dassault", "cessna",
    "pilatus", "atr", "havilland", "hondajet", "learjet", "challenger", "global",
    "falcon", "citation", "phenom", "praetor", "legacy",
    "737", "747", "757", "767", "777", "787", "a220", "a320", "a321", "a330", "a350", "a380",
    "max", "neo", "xlr",
    "airways", "air", "jet", "express", "cargo",
    "airport", "terminal", "runway", "cockpit", "cabin",
    "ryanair", "easyjet", "emirates", "lufthansa", "british", "delta", "united",
    "american", "southwest", "qantas", "singapore", "cathay", "turkish",
  ]);

  // Military / special aircraft designations — letter-number codes like B-21, F-35, C-17, KC-46
  // These must beat location names in scoring, so we detect and boost them heavily
  const MILITARY_AIRCRAFT_RE = /^[A-Z]{1,2}-\d{1,3}[A-Z]?$/;

  // Extract all capitalised noun phrases (1-4 words) from the combined text
  // Split on sentence boundaries and punctuation, then scan for capitalised runs
  const words = combined.replace(/[\r\n]+/g, " ").split(/\s+/);
  const phrases: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^a-zA-Z0-9-]/g, "");
    if (!w || w.length < 2) continue;
    // Must start with uppercase (proper noun)
    if (!/^[A-Z]/.test(w)) continue;
    // Skip pure noise words
    if (NOISE.has(w.toLowerCase())) continue;

    // Try to extend into a multi-word phrase (up to 4 words)
    let phrase = w;
    for (let j = i + 1; j < Math.min(i + 4, words.length); j++) {
      const next = words[j].replace(/[^a-zA-Z0-9-]/g, "");
      if (!next || next.length < 2) break;
      // Continue phrase if next word is capitalised OR is a known connector
      const isCapitalised = /^[A-Z]/.test(next);
      const isConnector = /^(of|the|de|du|van|von|al|el|and|&)$/i.test(next);
      const isModel = /^[A-Z0-9-]{2,}$/.test(next); // e.g. 737, MAX, G650, A320neo
      if (isCapitalised || isConnector || isModel) {
        phrase += " " + next;
      } else {
        break;
      }
    }

    // Score the phrase by aviation relevance
    const phraseLower = phrase.toLowerCase();
    let score = phrase.split(" ").length; // longer phrases score higher
    const AVIATION_BOOST_ARR = Array.from(AVIATION_BOOST);
    if (AVIATION_BOOST_ARR.some(boost => phraseLower.includes(boost))) score += 3;
    // Military aircraft codes (B-21, F-35, C-17) get a massive boost so they always beat location names
    if (MILITARY_AIRCRAFT_RE.test(phrase.split(" ")[0])) score += 8;
    // Penalise very short single words that aren't model numbers
    if (phrase.split(" ").length === 1 && phrase.length < 5 && !/^[A-Z0-9-]+$/.test(phrase)) score -= 2;

    phrases.push(phrase);
  }

  // Deduplicate and sort by score (longest/most aviation-relevant first)
  const seen = new Set<string>();
  const AVIATION_BOOST_ARR2 = Array.from(AVIATION_BOOST);
  const scored = phrases
    .filter(p => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(p => {
      const pl = p.toLowerCase();
      let score = p.split(" ").length;
      if (AVIATION_BOOST_ARR2.some(boost => pl.includes(boost))) score += 3;
      // Military aircraft codes (B-21, F-35, C-17) get a massive boost so they always beat location names
      if (MILITARY_AIRCRAFT_RE.test(p.split(" ")[0])) score += 8;
      if (p.split(" ").length === 1 && p.length < 5) score -= 2;
      return { phrase: p, score };
    })
    .sort((a, b) => b.score - a.score);

  // ── Step 2: Identify the aircraft phrase and context phrase ──

  // Aircraft phrase: highest-scoring phrase that contains an aircraft manufacturer or model code
  // Also includes military designations: B-21 Raider, F-35 Lightning, C-17 Globemaster, etc.
  const AIRCRAFT_MARKERS = /boeing|airbus|embraer|bombardier|gulfstream|dassault|cessna|pilatus|atr|havilland|hondajet|learjet|challenger|global|falcon|citation|phenom|praetor|legacy|737|747|757|767|777|787|a220|a3[0-9][0-9]|a380|max|neo|xlr|\b[a-z]-\d{1,3}\b|raider|raptor|spirit|warthog|hercules|globemaster|osprey|reaper|predator|sentry|poseidon|stratofortress|lancer|nighthawk|thunderbolt|lightning|tomcat|growler|hawkeye/i;
  const AIRLINE_MARKERS = /air|airways|airlines|jet|express|cargo|ryanair|easyjet|emirates|lufthansa|british|delta|united|american|southwest|qantas|singapore|cathay|turkish|iberia|klm|tap|sas|norwegian|finnair|alitalia|ita|austrian|swiss|brussels|lot|aegean|aeroflot|indigo|thai|vietnam|garuda|lion|malaysia|airasia|srilankan|pakistan|ethiopian|kenya|rwandair|latam|avianca|copa|fedex|ups|dhl|atlas|cargolux/i;
  const AIRPORT_MARKERS = /airport|air force base|naval air station|airfield|heathrow|gatwick|stansted|luton|manchester|birmingham|glasgow|edinburgh|bristol|belfast|newcastle|liverpool|jfk|lax|sfo|ord|atl|mia|dfw|bos|den|las|schiphol|charles de gaulle|frankfurt|munich|zurich|vienna|brussels|copenhagen|dubai|abu dhabi|doha|changi|narita|haneda|incheon|sydney|melbourne|auckland|edwards|ellsworth|langley|nellis|eglin|tinker|travis|mcconnell|barksdale|whiteman|dyess|minot|moody|seymour|shaw|luke|davis-monthan|holloman|cannon|kirtland|offutt|peterson|buckley|schriever|creech|beale|mccord|mcchord|fairchild|elmendorf|eielson|hickam|pearl harbor/i;

  let aircraftPhrase = scored.find(s => AIRCRAFT_MARKERS.test(s.phrase))?.phrase ?? "";
  let airlinePhrase = scored.find(s => AIRLINE_MARKERS.test(s.phrase) && !AIRCRAFT_MARKERS.test(s.phrase))?.phrase ?? "";
  let airportPhrase = scored.find(s => AIRPORT_MARKERS.test(s.phrase))?.phrase ?? "";

  // If we found both an airline and an aircraft model, combine them
  let aircraftQuery: string;
  if (aircraftPhrase && airlinePhrase) {
    // Avoid duplicating words (e.g. "Ryanair" + "Ryanair 737" -> just use aircraftPhrase)
    if (aircraftPhrase.toLowerCase().includes(airlinePhrase.toLowerCase())) {
      aircraftQuery = aircraftPhrase;
    } else {
      aircraftQuery = `${airlinePhrase} ${aircraftPhrase}`;
    }
  } else if (aircraftPhrase) {
    aircraftQuery = aircraftPhrase;
  } else if (airlinePhrase) {
    aircraftQuery = airlinePhrase;
  } else {
    // Fallback: top 2 scored phrases from the article
    aircraftQuery = scored.slice(0, 2).map(s => s.phrase).join(" ");
  }

  // Context phrase: airport name if found, otherwise infer scene from article keywords
  const lc = combined.toLowerCase();
  let scene = "";
  if (/angry|furious|rage|brawl|fight|altercation|argument|confrontation|screaming|yelling|unruly|disruptive|drunk|intoxicated|abusive|assault|attack|violent|kicked off|removed from|escorted off/.test(lc))
    scene = "angry passenger airport";
  else if (/delay|delayed|cancell|cancelled|stranded|stuck|waiting|queue|long wait|hours wait/.test(lc))
    scene = "airport departure delay queue";
  else if (/divert|diverted|diversion|emergency landing|forced landing|precautionary/.test(lc))
    scene = "emergency landing runway";
  else if (/strike|walkout|industrial action|protest|picket/.test(lc))
    scene = "airport strike protest";
  else if (/cockpit|pilot|captain|first officer|flight deck/.test(lc))
    scene = "cockpit";
  else if (/flight attendant|cabin crew|steward|stewardess/.test(lc))
    scene = "cabin crew aircraft";
  else if (/cabin|passenger|seat|aisle|overhead bin/.test(lc))
    scene = "aircraft cabin passengers";
  else if (/runway|takeoff|take-off|landing|touchdown|taxiway/.test(lc))
    scene = "runway aircraft";
  else if (/terminal|gate|boarding|departure|arrival|lounge/.test(lc))
    scene = "airport terminal";
  else if (/engine|thrust|turbine|fan blade/.test(lc))
    scene = "jet engine closeup";
  else if (/baggage|luggage|bag|suitcase/.test(lc))
    scene = "airport baggage claim";
  else if (/security|screening|checkpoint|tsa|customs/.test(lc))
    scene = "airport security screening";
  else if (/food|meal|snack|drink|catering/.test(lc))
    scene = "airline meal tray";
  else
    scene = "airport terminal";

  const SCENE_STANDALONE = /angry|delay|queue|strike|protest|brawl|fight|security|baggage|meal|entertainment/;
  let contextQuery: string;
  // Slot 2 must be DIFFERENT from slot 1 — if we have an airport/base phrase, always use it for slot 2
  // This gives: slot 1 = "B-21 Raider", slot 2 = "Edwards Air Force Base"
  if (airportPhrase && airportPhrase.toLowerCase() !== aircraftQuery.toLowerCase()) {
    contextQuery = airportPhrase;
  } else if (scene && SCENE_STANDALONE.test(scene)) {
    contextQuery = scene;
  } else if (airlinePhrase && scene && airlinePhrase.toLowerCase() !== aircraftQuery.toLowerCase()) {
    contextQuery = `${airlinePhrase} ${scene}`;
  } else if (scene) {
    contextQuery = scene;
  } else {
    // Last resort: pick the next best scored phrase that isn't the aircraft query
    const fallback = scored.find(s => s.phrase.toLowerCase() !== aircraftQuery.toLowerCase());
    contextQuery = fallback?.phrase || "airport terminal";
  }

  // ── Step 3: Build alt query suggestions from the top extracted phrases ──
  const topPhrases = scored.slice(0, 6).map(s => s.phrase);
  const aircraftAltQueries: string[] = [];
  const contextAltQueries: string[] = [];

  // Alt aircraft: airline alone, aircraft model alone, airline+airport
  if (airlinePhrase) aircraftAltQueries.push(airlinePhrase);
  if (aircraftPhrase && aircraftPhrase !== aircraftQuery) aircraftAltQueries.push(aircraftPhrase);
  if (airportPhrase && airlinePhrase) aircraftAltQueries.push(`${airlinePhrase} ${airportPhrase}`);
  else if (airlinePhrase) aircraftAltQueries.push(`${airlinePhrase} aircraft`);
  // Fill from top phrases if still short
  for (const p of topPhrases) {
    if (aircraftAltQueries.length >= 3) break;
    if (!aircraftAltQueries.includes(p) && p !== aircraftQuery) aircraftAltQueries.push(p);
  }

  // Alt context: airport terminal, airline+scene, scene alone
  if (airportPhrase) contextAltQueries.push(`${airportPhrase} terminal`);
  if (airlinePhrase && scene) contextAltQueries.push(`${airlinePhrase} ${scene}`);
  contextAltQueries.push(scene || "airport terminal");
  for (const p of topPhrases) {
    if (contextAltQueries.length >= 3) break;
    if (!contextAltQueries.includes(p) && AIRPORT_MARKERS.test(p)) contextAltQueries.push(p);
  }

  console.log(`[ImageSearch] Noun-phrase queries — aircraft: "${aircraftQuery}" | context: "${contextQuery}"`);
  console.log(`[ImageSearch] Top phrases: ${scored.slice(0, 5).map(s => `"${s.phrase}"(${s.score})`).join(", ")}`);
  return {
    aircraftQuery: aircraftQuery.slice(0, 100),
    contextQuery: contextQuery.slice(0, 100),
    aircraftAltQueries: aircraftAltQueries.slice(0, 3).map(q => q.slice(0, 80)),
    contextAltQueries: contextAltQueries.slice(0, 3).map(q => q.slice(0, 80)),
  };
}

/**
 * Generate a plain-text image recommendation when no real photo is found.
 * Built from extracted entities — no LLM call, zero cost.
 */
export function generateTextImageRec(
  title: string,
  viralAngle: string,
  aircraftQuery: string,
  slot: "aircraft" | "context"
): Promise<string> {
  const rec = slot === "aircraft"
    ? `Search Wikimedia Commons for: ${aircraftQuery}`
    : `Search for aviation photo: ${viralAngle || aircraftQuery} — cabin interior, cockpit, or airport terminal`;
  return Promise.resolve(rec);
}
