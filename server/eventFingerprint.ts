/**
 * Event Fingerprint — structural deduplication for aviation stories.
 *
 * The core problem with headline-only dedup is that two different outlets
 * covering the same crash/incident will write completely different headlines.
 * Jaccard similarity on words will miss them. The LLM dedup only fires for
 * location+incident title matches — it never sees stories that share no
 * headline words at all.
 *
 * This module solves it by extracting a canonical "event identity" from the
 * title + content using fast regex/keyword extraction (no LLM, no latency):
 *
 *   eventFingerprint = airline|flightno|aircraft|location|incidentType|dateYYYYMMDD
 *
 * Two stories with the same fingerprint are the same real-world event.
 * A null fingerprint means the story lacks enough structured data to fingerprint
 * reliably — those stories still go through the existing title/LLM dedup.
 *
 * Also exports buildContentHash() — a SHA-256 of normalised title+content
 * that catches verbatim reposts with different URLs (wire service syndication).
 */

import { createHash } from "crypto";

// ── Airline name → canonical short code ──────────────────────────────────────
// Covers the most common airlines in aviation news. Unrecognised airlines
// fall through to a normalised lowercase slug.
const AIRLINE_MAP: Record<string, string> = {
  "ryanair": "ryanair", "ryan air": "ryanair",
  "easyjet": "easyjet", "easy jet": "easyjet",
  "emirates": "emirates",
  "lufthansa": "lufthansa",
  "british airways": "ba", "ba ": "ba",
  "delta": "delta", "delta air lines": "delta",
  "united airlines": "united", "united ": "united",
  "american airlines": "american", "american ": "american",
  "southwest": "southwest", "southwest airlines": "southwest",
  "qantas": "qantas",
  "singapore airlines": "singapore", "singapore air": "singapore",
  "cathay pacific": "cathay", "cathay ": "cathay",
  "turkish airlines": "turkish", "turkish air": "turkish",
  "air india": "airindia",
  "wizz air": "wizz", "wizzair": "wizz",
  "jetblue": "jetblue", "jet blue": "jetblue",
  "alaska airlines": "alaska", "alaska air": "alaska",
  "frontier airlines": "frontier",
  "spirit airlines": "spirit",
  "indigo": "indigo", "indiGo": "indigo",
  "flydubai": "flydubai", "fly dubai": "flydubai",
  "air france": "airfrance",
  "klm": "klm",
  "iberia": "iberia",
  "finnair": "finnair",
  "tap air portugal": "tap", "tap portugal": "tap",
  "aer lingus": "aerlingus",
  "norwegian": "norwegian", "norwegian air": "norwegian",
  "air canada": "aircanada",
  "westjet": "westjet",
  "air new zealand": "airnz",
  "malaysia airlines": "malaysia",
  "thai airways": "thai",
  "china eastern": "chinaeastern",
  "china southern": "chinasouthern",
  "air china": "airchina",
  "korean air": "korean",
  "japan airlines": "jal", "jal ": "jal",
  "all nippon": "ana", "ana ": "ana",
  "etihad": "etihad",
  "qatar airways": "qatar",
  "saudia": "saudia", "saudi arabian airlines": "saudia",
  "ethiopian airlines": "ethiopian",
  "kenya airways": "kenya",
  "egyptair": "egyptair",
  "royal air maroc": "royalairmaroc",
  "aeromexico": "aeromexico",
  "avianca": "avianca",
  "latam": "latam",
  "copa airlines": "copa",
  "air europa": "aireuropa",
  "vueling": "vueling",
  "transavia": "transavia",
  "sunexpress": "sunexpress",
  "pegasus": "pegasus",
  "flybe": "flybe",
  "loganair": "loganair",
  "air asia": "airasia", "airasia": "airasia",
  "lion air": "lionair", "lionair": "lionair",
  "batik air": "batik",
  "citilink": "citilink",
  "garuda": "garuda",
  "vietjet": "vietjet",
  "bamboo": "bamboo",
  "cebu pacific": "cebu",
  "philippine airlines": "pal",
  "air arabia": "airarabia",
  "jazeera": "jazeera",
  "flyadeal": "flyadeal",
  "air transat": "transat",
  "sunwing": "sunwing",
  "flair airlines": "flair",
  "swoop": "swoop",
  "porter airlines": "porter",
  "breeze airways": "breeze",
  "sun country": "suncountry",
  "allegiant": "allegiant",
  "volaris": "volaris",
  "interjet": "interjet",
  "vivaaerobus": "vivaaerobus",
  "fedex": "fedex", "fedex express": "fedex",
  "ups airlines": "ups",
  "dhl aviation": "dhl",
  "atlas air": "atlas",
  "kalitta air": "kalitta",
  "air cargo germany": "acg",
  "cargolux": "cargolux",
  "air bridge cargo": "abc",
};

// ── Aircraft type → canonical short code ─────────────────────────────────────
const AIRCRAFT_MAP: Record<string, string> = {
  "737 max": "737max", "737max": "737max",
  "737-800": "737800", "737 800": "737800",
  "737-900": "737900", "737 900": "737900",
  "737-700": "737700", "737 700": "737700",
  "737": "737",
  "747-8": "7478", "747 8": "7478",
  "747-400": "747400", "747 400": "747400",
  "747": "747",
  "757": "757",
  "767": "767",
  "777x": "777x",
  "777-300": "777300", "777 300": "777300",
  "777-200": "777200", "777 200": "777200",
  "777": "777",
  "787-10": "78710", "787 10": "78710",
  "787-9": "7879", "787 9": "7879",
  "787-8": "7878", "787 8": "7878",
  "787": "787", "dreamliner": "787",
  "a220": "a220",
  "a318": "a318",
  "a319": "a319",
  "a320neo": "a320neo", "a320 neo": "a320neo",
  "a320": "a320",
  "a321neo": "a321neo", "a321 neo": "a321neo",
  "a321xlr": "a321xlr",
  "a321": "a321",
  "a330-900": "a330900",
  "a330-800": "a330800",
  "a330": "a330",
  "a340": "a340",
  "a350-1000": "a3501000",
  "a350-900": "a350900",
  "a350": "a350",
  "a380": "a380",
  "e175": "e175", "e-175": "e175",
  "e190": "e190", "e-190": "e190",
  "e195": "e195", "e-195": "e195",
  "crj": "crj",
  "atr 72": "atr72", "atr-72": "atr72",
  "atr 42": "atr42", "atr-42": "atr42",
  "dash 8": "dash8", "q400": "dash8",
  "superjet": "superjet",
  "mc-21": "mc21",
  "c919": "c919",
};

// ── Incident type → canonical category ───────────────────────────────────────
const INCIDENT_MAP: Record<string, string> = {
  "crash": "crash", "crashed": "crash",
  "fatal": "crash", "fatality": "crash", "fatalities": "crash",
  "killed": "crash", "dead": "crash", "deaths": "crash",
  "emergency landing": "emergency", "emergency declared": "emergency",
  "mayday": "emergency",
  "engine failure": "engine", "engine fire": "engine", "engine out": "engine",
  "fire on board": "fire", "cabin fire": "fire", "wheel fire": "fire",
  "smoke in cabin": "smoke", "smoke in cockpit": "smoke",
  "evacuation": "evacuation", "evacuated": "evacuation",
  "divert": "diversion", "diverted": "diversion", "diversion": "diversion",
  "bird strike": "birdstrike", "birdstrike": "birdstrike",
  "turbulence": "turbulence",
  "depressurisation": "depressurisation", "decompression": "depressurisation",
  "near miss": "nearmiss", "near-miss": "nearmiss", "close call": "nearmiss",
  "runway incursion": "runwayincursion",
  "belly landing": "bellylanding", "gear collapse": "bellylanding",
  "overrun": "overrun", "runway overrun": "overrun",
  "hijack": "hijack", "hijacking": "hijack",
  "bomb threat": "bombthreat", "bomb scare": "bombthreat",
  "grounded": "grounded", "groundstop": "grounded",
  "cancel": "cancellation", "cancelled": "cancellation",
  "delay": "delay", "delayed": "delay",
  "mid-air": "midair", "mid air": "midair",
  "ditching": "ditching", "ditched": "ditching",
  "missing": "missing",
  "collision": "collision",
  "strike": "strike", "walkout": "strike",
  "bankruptcy": "bankruptcy", "bankrupt": "bankruptcy",
  "fine": "regulatory", "fined": "regulatory", "ban": "regulatory",
  "investigation": "investigation", "probe": "investigation",
  "first flight": "milestone", "maiden flight": "milestone",
  "delivery": "delivery",
  "retirement": "retirement", "retired": "retirement",
  "order": "order", "orders": "order",
};

// ── Location extraction ───────────────────────────────────────────────────────
// Covers the most common aviation locations. We normalise to IATA city codes
// where possible so "New York" and "JFK" both map to "nyc".
const LOCATION_MAP: Record<string, string> = {
  "heathrow": "lhr", "london heathrow": "lhr", "lhr": "lhr",
  "gatwick": "lgw", "london gatwick": "lgw",
  "stansted": "stn",
  "london city": "lcy",
  "london": "london",
  "manchester": "man",
  "birmingham": "bhx",
  "edinburgh": "edi",
  "glasgow": "gla",
  "dublin": "dub",
  "paris cdg": "cdg", "charles de gaulle": "cdg", "cdg": "cdg",
  "paris orly": "ory",
  "paris": "paris",
  "amsterdam": "ams", "schiphol": "ams",
  "frankfurt": "fra",
  "munich": "muc",
  "berlin": "ber",
  "rome": "fco", "fiumicino": "fco",
  "milan": "mxp",
  "madrid": "mad", "barajas": "mad",
  "barcelona": "bcn",
  "lisbon": "lis",
  "zurich": "zrh",
  "geneva": "gva",
  "vienna": "vie",
  "brussels": "bru",
  "copenhagen": "cph",
  "stockholm": "arn",
  "oslo": "osl",
  "helsinki": "hel",
  "warsaw": "waw",
  "prague": "prg",
  "budapest": "bud",
  "athens": "ath",
  "istanbul": "ist",
  "dubai": "dxb",
  "abu dhabi": "auh",
  "doha": "doh",
  "riyadh": "ruh",
  "jeddah": "jed",
  "cairo": "cai",
  "nairobi": "nbo",
  "johannesburg": "jnb",
  "lagos": "los",
  "addis ababa": "add",
  "casablanca": "cmn",
  "new york": "nyc", "jfk": "nyc", "laguardia": "nyc", "newark": "nyc",
  "los angeles": "lax", "lax": "lax",
  "chicago": "chi", "o'hare": "chi", "ohare": "chi", "midway": "chi",
  "dallas": "dfw", "dfw": "dfw",
  "miami": "mia",
  "houston": "hou",
  "atlanta": "atl",
  "seattle": "sea",
  "denver": "den",
  "boston": "bos",
  "washington": "was", "dulles": "was", "reagan": "was",
  "san francisco": "sfo", "sfo": "sfo",
  "las vegas": "las",
  "phoenix": "phx",
  "orlando": "mco",
  "toronto": "yyz",
  "montreal": "yul",
  "vancouver": "yvr",
  "mexico city": "mex",
  "bogota": "bog",
  "lima": "lim",
  "santiago": "scl",
  "sao paulo": "gru",
  "buenos aires": "eze",
  "delhi": "del",
  "mumbai": "bom",
  "bangalore": "blr",
  "karachi": "khi",
  "lahore": "lhe",
  "dhaka": "dac",
  "kathmandu": "ktm",
  "colombo": "cmb",
  "singapore": "sin",
  "kuala lumpur": "kul",
  "jakarta": "cgk",
  "bangkok": "bkk",
  "manila": "mnl",
  "hong kong": "hkg",
  "beijing": "pek",
  "shanghai": "pvg",
  "guangzhou": "can",
  "chengdu": "ctu",
  "tokyo": "tyo", "narita": "nrt", "haneda": "hnd",
  "osaka": "kix",
  "seoul": "icn", "incheon": "icn",
  "sydney": "syd",
  "melbourne": "mel",
  "brisbane": "bne",
  "auckland": "akl",
  "moscow": "svo",
  "kyiv": "iev", "kiev": "iev",
  "tehran": "thr",
  "baghdad": "bgw",
  "kabul": "kbl",
  "nepal": "ktm",
  "ethiopia": "add",
  "kenya": "nbo",
  "nigeria": "los",
};

/**
 * Extract a canonical event fingerprint from a story's title + content.
 *
 * Returns a string like "delta|dl123|737|atl|emergency|20260615"
 * or null if there is not enough structured data to fingerprint reliably.
 *
 * The fingerprint is intentionally coarse — it only needs to be specific
 * enough to identify the same real-world event, not the same article.
 */
export function buildEventFingerprint(
  title: string,
  content: string,
  publishedAt: Date | null
): string | null {
  const text = `${title} ${content}`.toLowerCase();

  // ── 1. Extract airline ────────────────────────────────────────────────────
  let airline = "";
  for (const [pattern, code] of Object.entries(AIRLINE_MAP)) {
    if (text.includes(pattern.toLowerCase())) {
      airline = code;
      break;
    }
  }

  // ── 2. Extract flight number ──────────────────────────────────────────────
  // Matches: AA123, DL 456, BA2490, UA 1234, EK 007
  const flightNoMatch = text.match(/\b([a-z]{2,3})\s?(\d{1,4})\b/);
  let flightNo = "";
  if (flightNoMatch) {
    // Only accept if the prefix looks like an airline code (2-3 letters)
    const prefix = flightNoMatch[1].toUpperCase();
    const num = flightNoMatch[2];
    // Filter out common false positives (aircraft types, years, etc.)
    const EXCLUDED_PREFIXES = new Set(["MAX", "NEO", "XLR", "ER", "LR", "ULR", "NG"]);
    if (!EXCLUDED_PREFIXES.has(prefix) && parseInt(num) < 9999) {
      flightNo = `${prefix}${num}`;
    }
  }

  // ── 3. Extract aircraft type ──────────────────────────────────────────────
  let aircraft = "";
  for (const [pattern, code] of Object.entries(AIRCRAFT_MAP)) {
    if (text.includes(pattern.toLowerCase())) {
      aircraft = code;
      break;
    }
  }

  // ── 4. Extract location ───────────────────────────────────────────────────
  let location = "";
  for (const [pattern, code] of Object.entries(LOCATION_MAP)) {
    if (text.includes(pattern.toLowerCase())) {
      location = code;
      break;
    }
  }

  // ── 5. Extract incident type ──────────────────────────────────────────────
  let incident = "";
  for (const [pattern, code] of Object.entries(INCIDENT_MAP)) {
    if (text.includes(pattern.toLowerCase())) {
      incident = code;
      break;
    }
  }

  // ── 6. Extract date ───────────────────────────────────────────────────────
  // Try to find a date in the text first (more accurate than publishedAt)
  // Patterns: "June 15", "15 June", "June 15, 2025", "2025-06-15"
  let dateStr = "";
  const MONTHS: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };

  // ISO date: 2025-06-15
  const isoMatch = text.match(/\b(202[0-9])-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    dateStr = `${isoMatch[1]}${isoMatch[2]}${isoMatch[3]}`;
  } else {
    // "June 15, 2025" or "15 June 2025"
    const monthNames = Object.keys(MONTHS).join("|");
    const longDateMatch = text.match(
      new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:,?\\s+(202[0-9]))?\\b`, "i")
    ) || text.match(
      new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})(?:,?\\s+(202[0-9]))?\\b`, "i")
    );
    if (longDateMatch) {
      const monthStr = longDateMatch[1].toLowerCase();
      const dayStr = longDateMatch[2].padStart(2, "0");
      const yearStr = longDateMatch[3] ?? (publishedAt ? publishedAt.getFullYear().toString() : new Date().getFullYear().toString());
      const monthCode = MONTHS[monthStr] ?? MONTHS[Object.keys(MONTHS).find(k => monthStr.startsWith(k)) ?? ""] ?? "";
      if (monthCode) dateStr = `${yearStr}${monthCode}${dayStr}`;
    }
  }

  // Fall back to publishedAt date (truncated to day — ignore time)
  if (!dateStr && publishedAt) {
    const y = publishedAt.getFullYear();
    const m = String(publishedAt.getMonth() + 1).padStart(2, "0");
    const d = String(publishedAt.getDate()).padStart(2, "0");
    dateStr = `${y}${m}${d}`;
  }

  // ── 7. Decide if we have enough to fingerprint ───────────────────────────
  // We need at minimum: (airline OR flight number) AND incident type
  // Without those two anchors the fingerprint would be too vague.
  const hasAnchor = (airline !== "" || flightNo !== "");
  const hasEvent = incident !== "";

  if (!hasAnchor || !hasEvent) {
    return null; // not enough structured data — fall through to title/LLM dedup
  }

  // Build the fingerprint — use pipe-separated fields, empty string for unknowns
  const parts = [
    airline,
    flightNo,
    aircraft,
    location,
    incident,
    dateStr,
  ];

  return parts.join("|");
}

/**
 * Build a SHA-256 content hash from a normalised version of title + content.
 * Catches verbatim reposts (wire service syndication) with different URLs.
 *
 * Normalisation: lowercase, collapse whitespace, strip punctuation.
 * Only the first 2000 chars of content are used (intro is most distinctive).
 */
export function buildContentHash(title: string, content: string): string {
  const normalised = `${title} ${content.slice(0, 2000)}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalised).digest("hex");
}
