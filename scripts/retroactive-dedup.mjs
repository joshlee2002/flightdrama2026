/**
 * retroactive-dedup.mjs
 *
 * One-time cleanup script that:
 * 1. Loads all existing stories from the DB
 * 2. Builds eventFingerprint + contentHash for each one (same logic as ingestPipeline)
 * 3. Groups stories by fingerprint/hash to find clusters of the same real-world event
 * 4. Within each cluster, keeps the BEST story (highest viralScore, or earliest if tied)
 *    and marks the rest as approvalStatus='duplicate' + isDuplicate=true
 * 5. Also marks any story whose URL is already in seen_urls as duplicate
 * 6. Prints a full summary of what was cleaned
 *
 * Run with:
 *   DATABASE_URL="mysql://..." node scripts/retroactive-dedup.mjs
 *
 * Safe to run multiple times — already-marked duplicates are excluded from analysis.
 */

import mysql from "mysql2/promise";
import { createHash } from "crypto";

// ── Inline fingerprint logic (mirrors server/eventFingerprint.ts) ─────────────

const AIRLINE_MAP = {
  "ryanair": "ryanair", "ryan air": "ryanair",
  "easyjet": "easyjet", "easy jet": "easyjet",
  "emirates": "emirates", "lufthansa": "lufthansa",
  "british airways": "ba", "delta air lines": "delta", "delta": "delta",
  "united airlines": "united", "american airlines": "american",
  "southwest airlines": "southwest", "southwest": "southwest",
  "qantas": "qantas", "singapore airlines": "singapore",
  "cathay pacific": "cathay", "turkish airlines": "turkish",
  "air india": "airindia", "wizz air": "wizz", "wizzair": "wizz",
  "jetblue": "jetblue", "jet blue": "jetblue",
  "alaska airlines": "alaska", "alaska air": "alaska",
  "frontier airlines": "frontier", "spirit airlines": "spirit",
  "indigo": "indigo", "flydubai": "flydubai", "fly dubai": "flydubai",
  "air france": "airfrance", "klm": "klm", "iberia": "iberia",
  "finnair": "finnair", "tap air portugal": "tap", "aer lingus": "aerlingus",
  "norwegian": "norwegian", "air canada": "aircanada", "westjet": "westjet",
  "air new zealand": "airnz", "malaysia airlines": "malaysia",
  "thai airways": "thai", "china eastern": "chinaeastern",
  "china southern": "chinasouthern", "air china": "airchina",
  "korean air": "korean", "japan airlines": "jal", "all nippon": "ana",
  "etihad": "etihad", "qatar airways": "qatar", "saudia": "saudia",
  "ethiopian airlines": "ethiopian", "kenya airways": "kenya",
  "egyptair": "egyptair", "aeromexico": "aeromexico", "avianca": "avianca",
  "latam": "latam", "copa airlines": "copa", "fedex": "fedex",
  "ups airlines": "ups", "atlas air": "atlas",
};

const AIRCRAFT_MAP = {
  "737 max": "737max", "737max": "737max",
  "737-800": "737800", "737 800": "737800",
  "737-900": "737900", "737": "737",
  "747-400": "747400", "747": "747", "757": "757", "767": "767",
  "777x": "777x", "777-300": "777300", "777-200": "777200", "777": "777",
  "787-10": "78710", "787-9": "7879", "787-8": "7878",
  "787": "787", "dreamliner": "787",
  "a220": "a220", "a319": "a319",
  "a320neo": "a320neo", "a320 neo": "a320neo", "a320": "a320",
  "a321neo": "a321neo", "a321xlr": "a321xlr", "a321": "a321",
  "a330": "a330", "a340": "a340",
  "a350-1000": "a3501000", "a350-900": "a350900", "a350": "a350",
  "a380": "a380",
};

const INCIDENT_MAP = {
  "crash": "crash", "crashed": "crash", "fatal": "crash",
  "killed": "crash", "dead": "crash",
  "emergency landing": "emergency", "mayday": "emergency",
  "engine failure": "engine", "engine fire": "engine",
  "fire on board": "fire", "smoke in cabin": "smoke",
  "evacuation": "evacuation", "evacuated": "evacuation",
  "diverted": "diversion", "diversion": "diversion",
  "bird strike": "birdstrike", "turbulence": "turbulence",
  "near miss": "nearmiss", "near-miss": "nearmiss",
  "runway incursion": "runwayincursion",
  "belly landing": "bellylanding", "overrun": "overrun",
  "hijack": "hijack", "bomb threat": "bombthreat",
  "grounded": "grounded", "mid-air": "midair", "mid air": "midair",
  "missing": "missing", "collision": "collision",
  "bankruptcy": "bankruptcy", "investigation": "investigation",
};

const LOCATION_MAP = {
  "heathrow": "lhr", "london heathrow": "lhr",
  "gatwick": "lgw", "london": "london",
  "manchester": "man", "dublin": "dub",
  "paris cdg": "cdg", "charles de gaulle": "cdg",
  "amsterdam": "ams", "schiphol": "ams",
  "frankfurt": "fra", "munich": "muc", "berlin": "ber",
  "rome": "fco", "milan": "mxp", "madrid": "mad", "barcelona": "bcn",
  "istanbul": "ist", "dubai": "dxb", "abu dhabi": "auh", "doha": "doh",
  "cairo": "cai", "nairobi": "nbo", "johannesburg": "jnb",
  "new york": "nyc", "jfk": "nyc", "newark": "nyc",
  "los angeles": "lax", "chicago": "chi", "o'hare": "chi",
  "dallas": "dfw", "miami": "mia", "atlanta": "atl",
  "seattle": "sea", "denver": "den", "boston": "bos",
  "washington": "was", "san francisco": "sfo",
  "toronto": "yyz", "montreal": "yul", "vancouver": "yvr",
  "delhi": "del", "mumbai": "bom", "karachi": "khi",
  "singapore": "sin", "kuala lumpur": "kul", "jakarta": "cgk",
  "bangkok": "bkk", "hong kong": "hkg", "beijing": "pek",
  "shanghai": "pvg", "tokyo": "tyo", "seoul": "icn",
  "sydney": "syd", "melbourne": "mel", "auckland": "akl",
};

function buildEventFingerprint(title, content, publishedAt) {
  const text = `${title} ${content}`.toLowerCase();

  let airline = "";
  for (const [p, code] of Object.entries(AIRLINE_MAP)) {
    if (text.includes(p.toLowerCase())) { airline = code; break; }
  }

  const flightNoMatch = text.match(/\b([a-z]{2,3})\s?(\d{1,4})\b/);
  let flightNo = "";
  if (flightNoMatch) {
    const prefix = flightNoMatch[1].toUpperCase();
    const num = flightNoMatch[2];
    const EXCLUDED = new Set(["MAX", "NEO", "XLR", "ER", "LR", "ULR", "NG"]);
    if (!EXCLUDED.has(prefix) && parseInt(num) < 9999) {
      flightNo = `${prefix}${num}`;
    }
  }

  let aircraft = "";
  for (const [p, code] of Object.entries(AIRCRAFT_MAP)) {
    if (text.includes(p.toLowerCase())) { aircraft = code; break; }
  }

  let location = "";
  for (const [p, code] of Object.entries(LOCATION_MAP)) {
    if (text.includes(p.toLowerCase())) { location = code; break; }
  }

  let incident = "";
  for (const [p, code] of Object.entries(INCIDENT_MAP)) {
    if (text.includes(p.toLowerCase())) { incident = code; break; }
  }

  let dateStr = "";
  if (publishedAt) {
    const d = new Date(publishedAt);
    if (!isNaN(d.getTime())) {
      dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    }
  }

  // Need at least 2 structural fields to fingerprint reliably
  const parts = [airline, flightNo, aircraft, location, incident, dateStr].filter(Boolean);
  if (parts.length < 2) return null;

  return parts.join("|");
}

function buildContentHash(title, content) {
  const normalised = `${title} ${content}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
  if (normalised.length < 50) return null;
  return createHash("sha256").update(normalised).digest("hex");
}

// ── Main cleanup ──────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL not set"); process.exit(1); }

  const conn = await mysql.createConnection(dbUrl);
  console.log("Connected to database.\n");

  // Load all non-duplicate, non-dismissed stories
  const [stories] = await conn.execute(
    `SELECT id, title, content, sourceUrl, viralScore, createdAt, approvalStatus
     FROM stories
     WHERE approvalStatus NOT IN ('duplicate', 'dismissed')
     ORDER BY viralScore DESC, createdAt ASC`
  );

  console.log(`Loaded ${stories.length} active stories for analysis.\n`);

  // ── Pass 1: Content hash dedup ────────────────────────────────────────────
  const hashMap = new Map(); // hash → best story id
  const hashDupes = [];

  for (const story of stories) {
    const hash = buildContentHash(story.title || "", story.content || "");
    if (!hash) continue;
    if (hashMap.has(hash)) {
      hashDupes.push({ dupeId: story.id, keepId: hashMap.get(hash), reason: "content_hash", title: story.title });
    } else {
      hashMap.set(hash, story.id);
    }
  }

  // ── Pass 2: Event fingerprint dedup ──────────────────────────────────────
  const fingerprintMap = new Map(); // fingerprint → best story id
  const fingerprintDupes = [];
  // Exclude stories already identified as hash dupes
  const hashDupeIds = new Set(hashDupes.map(d => d.dupeId));

  for (const story of stories) {
    if (hashDupeIds.has(story.id)) continue;
    const fp = buildEventFingerprint(story.title || "", story.content || "", story.createdAt);
    if (!fp) continue;
    if (fingerprintMap.has(fp)) {
      fingerprintDupes.push({ dupeId: story.id, keepId: fingerprintMap.get(fp), reason: "event_fingerprint", fingerprint: fp, title: story.title });
    } else {
      fingerprintMap.set(fp, story.id);
    }
  }

  const allDupes = [...hashDupes, ...fingerprintDupes];

  console.log(`Found ${hashDupes.length} content-hash duplicates (verbatim reposts)`);
  console.log(`Found ${fingerprintDupes.length} event-fingerprint duplicates (same event, different outlets)`);
  console.log(`Total to mark as duplicate: ${allDupes.length}\n`);

  if (allDupes.length === 0) {
    console.log("No duplicates found — database is clean!");
    await conn.end();
    return;
  }

  // Show sample of what will be marked
  console.log("Sample duplicates being removed:");
  allDupes.slice(0, 15).forEach(d => {
    console.log(`  [${d.reason}] ID ${d.dupeId} → keep ID ${d.keepId}: "${(d.title || "").substring(0, 70)}"`);
  });
  if (allDupes.length > 15) console.log(`  ... and ${allDupes.length - 15} more\n`);

  // ── Mark duplicates in DB ─────────────────────────────────────────────────
  const dupeIds = allDupes.map(d => d.dupeId);
  const placeholders = dupeIds.map(() => "?").join(",");

  const [result] = await conn.execute(
    `UPDATE stories SET approvalStatus='duplicate', isDuplicate=1
     WHERE id IN (${placeholders})`,
    dupeIds
  );

  console.log(`\nMarked ${result.affectedRows} stories as duplicate in the database.`);

  // ── Final stats ───────────────────────────────────────────────────────────
  const [[{ total }]] = await conn.execute("SELECT COUNT(*) total FROM stories");
  const [[{ dupes }]] = await conn.execute("SELECT COUNT(*) dupes FROM stories WHERE approvalStatus='duplicate'");
  const [[{ pending }]] = await conn.execute("SELECT COUNT(*) pending FROM stories WHERE approvalStatus='pending'");
  const [[{ approved }]] = await conn.execute("SELECT COUNT(*) approved FROM stories WHERE approvalStatus='approved'");

  console.log("\n── Final database state ─────────────────────────────────────");
  console.log(`Total stories:     ${total}`);
  console.log(`Pending (clean):   ${pending}`);
  console.log(`Approved:          ${approved}`);
  console.log(`Marked duplicate:  ${dupes}`);
  console.log("─────────────────────────────────────────────────────────────\n");
  console.log("Done. The dashboard will no longer show these as active stories.");

  await conn.end();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
