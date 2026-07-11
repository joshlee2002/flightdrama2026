/**
 * FlightDrama Viral Scoring Engine — v2
 * Calibrated against 100+ real FlightDrama posts with measured engagement data.
 *
 * Category ranking by average engagement (from data analysis):
 * 1. Boeing Safety + Rivalry         avg 3,777
 * 2. Money Shock (exact figures)     avg 3,513
 * 3. Weird Human Moments             avg 3,508
 * 4. Celebrity + Political           avg 2,642
 * 5. Passenger Outrage               avg 2,583
 * 6. Safety + Accountability + Death avg 1,706
 * 7. Pilot + Crew Pay                avg 1,378
 * 8. Superlatives (first/last/only)  avg 1,270
 * 9. Nostalgia + Old Aircraft        avg   638
 * 10. Route launches (weak)          avg    12  ← 314x lower than top
 */

export type { StatusLabel } from "../shared/const";
import { labelFromScore, type StatusLabel } from "../shared/const";
export { labelFromScore };

export interface ScoringResult {
  score: number;
  statusLabel: StatusLabel;
  category: string;
  viralReason: string;
  triggers: string[];
  /** Human-readable 1-2 sentence explanation of why this story scored the way it did. */
  viralExplanation: string;
  /** The raw rule-based score before any LLM or stat adjustment — kept for debugging. */
  ruleScore?: number;
  /** How confident the apprentice was based on example coverage: High / Medium / Low */
  apprenticeConfidence?: string;
  /** Plain-English explanation of how past corrections influenced this score. */
  apprenticeReasoning?: string;
  /** Titles of the override examples used as few-shot context for this score. */
  similarExamplesUsed?: string[];
}

// ── Stat-performance score adjustment (free, no LLM) ─────────────────────────
// Applied on top of the rule-based score using learned data from historical posts.
// Loaded once per process and refreshed every 10 minutes to avoid DB hammering.

let _statAdjustCache: {
  catBoosts: Record<string, number>;        // category name → score delta (from perf + overrides)
  highKws: Map<string, number>;             // word → boost weight (from perf + override learner)
  lowKws: Map<string, number>;              // word → penalty weight (from perf + override learner)
  overrideCatBoosts: Record<string, number>; // category boosts from editor overrides specifically
  loadedAt: number;
} | null = null;

// ── Distribution normalisation cache ─────────────────────────────────────────
// Stores Joshua's real score distribution computed from override history.
// Used to map raw LLM scores (which cluster at 95) to Joshua's actual scale.
let _distNormCache: {
  sortedScores: number[];   // all override scores, sorted ascending
  loadedAt: number;
} | null = null;
const DIST_NORM_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Loads Joshua's real score distribution from override history.
 * Cached for 5 minutes — same TTL as stat adjustments.
 */
async function loadDistributionNorm(): Promise<number[] | null> {
  if (_distNormCache && Date.now() - _distNormCache.loadedAt < DIST_NORM_CACHE_TTL_MS) {
    return _distNormCache.sortedScores;
  }
  try {
    const { getOverrideExamplesFromDb } = await import('./db');
    const examples = await getOverrideExamplesFromDb(500);
    const scores = examples
      .map(e => e.overrideScore)
      .filter((s): s is number => typeof s === 'number' && s >= 0 && s <= 100);
    if (scores.length < 10) return null; // not enough data yet
    const sorted = [...scores].sort((a, b) => a - b);
    _distNormCache = { sortedScores: sorted, loadedAt: Date.now() };
    return sorted;
  } catch {
    return null;
  }
}

/**
 * Clears the distribution normalisation cache.
 * Call this after every override (alongside clearStatAdjustCache).
 */
export function clearDistNormCache(): void {
  _distNormCache = null;
}

/**
 * Maps a raw LLM score to Joshua's actual score distribution using percentile normalisation.
 *
 * The LLM clusters scores at the top of its allowed range (e.g. 95 for anything "good").
 * This function treats the LLM score as a percentile signal and maps it to the
 * corresponding percentile in Joshua's real override distribution.
 *
 * Example: if the LLM gives 95 to 40% of stories, but Joshua only scores above 85
 * for 5% of stories, then a raw LLM score of 95 maps to Joshua's 95th percentile
 * score — which might be 82 in his actual distribution.
 *
 * The mapping is intentionally conservative: the LLM percentile is blended 50/50
 * with the raw score to avoid over-correcting when Joshua's override sample is small.
 * As more overrides accumulate, the distribution correction becomes stronger.
 *
 * Returns the raw score unchanged if there is not enough override data (< 10 examples).
 */
export async function normaliseToEditorDistribution(rawLlmScore: number): Promise<number> {
  const sortedScores = await loadDistributionNorm();
  if (!sortedScores || sortedScores.length < 10) return rawLlmScore;

  const n = sortedScores.length;

  // Treat the raw LLM score as a percentile: score 95 → top 5%, score 50 → median, etc.
  // We use a simple linear mapping: score 0 → 0th percentile, score 100 → 100th percentile.
  const llmPercentile = rawLlmScore / 100;

  // Find the score at that percentile in Joshua's real distribution
  const targetIdx = Math.min(n - 1, Math.max(0, Math.round(llmPercentile * (n - 1))));
  const editorScore = sortedScores[targetIdx];

  // Blend: 60% editor distribution, 40% raw LLM score.
  // This ensures the correction is meaningful but not jarring when the sample is small.
  // Blend weight increases with sample size: at 10 examples → 50/50, at 100+ → 70/30.
  const blendWeight = Math.min(0.70, 0.50 + (n / 1000));
  const normalised = Math.round(blendWeight * editorScore + (1 - blendWeight) * rawLlmScore);

  // Hard floor: never normalise below 5 (reserved for title-gate rejects)
  // Hard ceiling: 95 (manual override territory above this)
  const clamped = Math.max(5, Math.min(95, normalised));

  if (Math.abs(clamped - rawLlmScore) >= 5) {
    console.log(`[DistNorm] raw=${rawLlmScore} → editor_p${Math.round(llmPercentile * 100)}=${editorScore} → blended=${normalised} → final=${clamped} (n=${n})`);
  }
  return clamped;
}

const STAT_CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 minutes (was 10)

/**
 * Parses the stat_category_weights string produced by learnFromOverridesStatistical.
 * Format: "Aviation Accident: +8 pts avg (12 overrides); Boeing Safety: -5 pts avg (3 overrides)"
 */
function parseOverrideCatWeights(raw: string): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || raw === "Not enough data per category yet.") return result;
  for (const entry of raw.split(";")) {
    const m = entry.match(/^([^:]+):\s*([+-]?\d+)\s*pts/);
    if (m) {
      const cat = m[1].trim().toLowerCase();
      const pts = parseInt(m[2], 10);
      if (!isNaN(pts)) result[cat] = pts;
    }
  }
  return result;
}

/**
 * Parses the stat_keyword_boosts/penalties string produced by learnFromOverridesStatistical.
 * Format: "\"boeing\" (×5), \"crash\" (×4), \"fatal\" (×3)"
 * Returns a Map of word → weight (higher count = stronger signal).
 */
function parseOverrideKeywords(raw: string): Map<string, number> {
  const result = new Map<string, number>();
  if (!raw || raw === "none yet") return result;
  for (const entry of raw.split(",")) {
    const m = entry.match(/"([^"]+)"\s*\(×(\d+)\)/);
    if (m) {
      const word = m[1].trim().toLowerCase();
      const count = parseInt(m[2], 10);
      if (word && !isNaN(count)) result.set(word, count);
    }
  }
  return result;
}

async function loadStatAdjustments() {
  if (_statAdjustCache && Date.now() - _statAdjustCache.loadedAt < STAT_CACHE_TTL_MS) {
    return _statAdjustCache;
  }
  try {
    const { getAllScoringConfig } = await import("./db");
    const config = await getAllScoringConfig();

    // ── 1. Category boosts from Instagram performance data ────────────────
    const catBoosts: Record<string, number> = {};
    const catRaw = config["stat_perf_top_categories"];
    if (catRaw) {
      try {
        const cats: Array<{ category: string; avgEngagement: number }> = JSON.parse(catRaw);
        const avgEng = parseInt(config["stat_perf_avg_engagement"] ?? "0", 10);
        if (avgEng > 0) {
          for (const c of cats) {
            const ratio = c.avgEngagement / avgEng;
            // Scale: 2× avg → +12 pts, 0.5× avg → -10 pts
            const delta = Math.max(-15, Math.min(15, Math.round((ratio - 1) * 14)));
            if (Math.abs(delta) >= 2) catBoosts[c.category.toLowerCase()] = delta;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // ── 2. Category boosts from editor overrides (the critical missing piece) ─
    const overrideCatBoosts = parseOverrideCatWeights(config["stat_category_weights"] ?? "");
    // Merge: override signal adds on top of performance signal
    for (const [cat, pts] of Object.entries(overrideCatBoosts)) {
      catBoosts[cat] = (catBoosts[cat] ?? 0) + pts;
    }

    // ── 3. Keyword signals from Instagram performance ─────────────────────
    const highKws = new Map<string, number>();
    const lowKws = new Map<string, number>();
    for (const kw of (config["stat_perf_high_keywords"] ?? "").split(", ").filter(Boolean)) {
      highKws.set(kw, 3); // performance signal: weight 3
    }
    for (const kw of (config["stat_perf_low_keywords"] ?? "").split(", ").filter(Boolean)) {
      lowKws.set(kw, 3);
    }

    // ── 4. Keyword signals from editor overrides (the critical missing piece) ─
    const overrideBoostKws = parseOverrideKeywords(config["stat_keyword_boosts"] ?? "");
    const overridePenaltyKws = parseOverrideKeywords(config["stat_keyword_penalties"] ?? "");
    for (const [kw, cnt] of overrideBoostKws) {
      // Override signal weight scales with how many times you've boosted it
      // cnt=2 → weight 2, cnt=5 → weight 4, cnt=10 → weight 6 (log-scaled)
      const weight = Math.min(6, Math.max(2, Math.round(Math.log2(cnt) * 2)));
      highKws.set(kw, Math.max(highKws.get(kw) ?? 0, weight));
    }
    for (const [kw, cnt] of overridePenaltyKws) {
      const weight = Math.min(6, Math.max(2, Math.round(Math.log2(cnt) * 2)));
      lowKws.set(kw, Math.max(lowKws.get(kw) ?? 0, weight));
    }

    _statAdjustCache = { catBoosts, highKws, lowKws, overrideCatBoosts, loadedAt: Date.now() };
    return _statAdjustCache;
  } catch {
    return {
      catBoosts: {},
      highKws: new Map<string, number>(),
      lowKws: new Map<string, number>(),
      overrideCatBoosts: {},
      loadedAt: Date.now(),
    };
  }
}

/**
 * Applies learned statistical adjustments to a rule-based score.
 *
 * Sources of adjustment (all free, no LLM):
 * - Instagram performance data: which categories/keywords drive real engagement
 * - Editor override history: which categories/keywords you consistently score higher/lower
 *
 * Cap raised to ±35 so override signals can actually move stories across tier boundaries
 * (e.g. a rule-scored 50 that you always push to 90 can now reach 85).
 */
export async function applyStatAdjustments(
  score: number,
  category: string,
  title: string
): Promise<number> {
  try {
    const adj = await loadStatAdjustments();
    let delta = 0;
    const catKey = category.toLowerCase();

    // ── 1. Instagram performance category signal ──────────────────────────
    // catBoosts already merges Instagram perf + override signals in loadStatAdjustments.
    // We apply it here as the combined category signal.
    for (const [cat, boost] of Object.entries(adj.catBoosts)) {
      if (catKey.includes(cat) || cat.includes(catKey)) {
        delta += boost;
        break;
      }
    }

    // ── 2. Editor override category signal (was missing — now applied) ─────
    // overrideCatBoosts is the editor-specific signal from learnFromOverridesStatistical.
    // If you consistently push Boeing Safety from 60 to 90, this adds +15 to that
    // category. Previously this was loaded but never applied — fixed here.
    // We apply it as an ADDITIONAL delta (not merged with catBoosts) so the
    // editor's direct signal is always visible and not diluted by Instagram data.
    for (const [cat, boost] of Object.entries(adj.overrideCatBoosts)) {
      if (catKey.includes(cat) || cat.includes(catKey)) {
        // Override signal is authoritative — weight it 1.5× relative to Instagram signal
        delta += Math.round(boost * 1.5);
        break;
      }
    }

    // ── 3. Keyword boost/penalty from headline ────────────────────────────
    const titleLower = title.toLowerCase();
    const words = titleLower.match(/\b[a-z][a-z-]{2,}\b/g) ?? [];
    // Also check bigrams (2-word phrases) since override learner extracts them
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(`${words[i]} ${words[i + 1]}`);
    }
    const allTokens = [...words, ...bigrams];
    for (const token of allTokens) {
      if (adj.highKws.has(token)) delta += adj.highKws.get(token)!;
      if (adj.lowKws.has(token)) delta -= adj.lowKws.get(token)!;
    }

    // ── Cap: ±15 — distribution normalisation now handles the bulk of the correction.
    // Stat adjustments are a fine-tuning layer only: they nudge scores based on
    // category drift and keyword signals, but should not override the normalised
    // distribution. ±15 is enough to move a story across one tier boundary.
    delta = Math.max(-15, Math.min(15, delta));
    const finalScore = Math.max(0, Math.min(95, score + delta)); // Stat cap: 95 — only manual editor override reaches 96-100
    if (Math.abs(delta) >= 5) {
      console.log(`[StatAdj] "${title.slice(0, 55)}" base=${score} delta=${delta > 0 ? '+' : ''}${delta} final=${finalScore} cat=${category}`);
    }
    return finalScore;
  } catch {
    return score; // safe fallback
  }
}

/**
 * Immediately invalidates the stat-adjustment cache.
 * Call this after every override so the next scoring call picks up fresh weights
 * without waiting for the 5-minute TTL to expire.
 */
export function clearStatAdjustCache(): void {
  _statAdjustCache = null;
}

// ─── Tier 1: Highest-impact triggers (proven 1M+ view potential) ─────────────

/** Boeing safety failures, 737 MAX, 777X problems, FAA confrontations */
const BOEING_SAFETY_KEYWORDS = [
  "boeing 737 max", "737 max", "boeing grounded", "boeing faa", "boeing crash",
  "boeing fault", "boeing flaw", "boeing whistleblower", "boeing investigation",
  "boeing certification", "777x problem", "777x delay", "boeing safety",
  "boeing unresolved", "boeing defect", "boeing penalty", "boeing lawsuit",
  "boeing settlement", "boeing recall", "boeing probe",
  "boeing asks faa", "boeing requests faa", "boeing waiver", "boeing exemption",
  "boeing emissions", "boeing rules", "boeing regulations", "boeing compliance",
  "boeing faces", "boeing under fire", "boeing blamed", "boeing at fault",
  "boeing faces", "boeing pushes back", "boeing challenges",
];

/** Boeing + FAA combined — any story with both Boeing and FAA is high-value */
const BOEING_FAA_COMBINED_PATTERN = /boeing.{0,100}faa|faa.{0,100}boeing/i;

/** Airbus vs Boeing rivalry — proven debate driver */
const BOEING_AIRBUS_RIVALRY_KEYWORDS = [
  // Airbus safety/defect stories (Emirates A350 defective = 150k)
  "airbus defect", "airbus fault", "airbus flaw", "airbus problem",
  "airbus grounded", "airbus investigation", "airbus probe",
  "airbus safety", "airbus recall", "airbus penalty",
  "a350 defective", "a350 fault", "a350 problem", "a350 grounded",
  "a380 defective", "a380 fault", "a380 problem",
  "a320 defective", "a320 fault", "a320 problem",
  "engine defective", "engine called defective", "called defective",
  "engine problem", "engine issue", "engine fault",
  "airbus faces", "airbus under fire", "airbus blamed",
  "airbus vs boeing", "boeing vs airbus", "airbus beats boeing", "boeing loses",
  "airbus wins", "dumps boeing", "ditches boeing", "cancels boeing",
  "switches to airbus", "switches to boeing", "airbus order", "boeing order cancelled",
  "boeing loses contract", "airbus extends lead", "737 max vs a320",
  "777x vs a350", "a350 killer", "777-9 killer",
];

/** Exact death/fatality counts — highest single engagement driver */
const FATAL_DEATH_KEYWORDS = [
  // Pilot/crew safety under threat
  "airstrikes", "war zone", "conflict zone", "combat zone", "military zone",
  "near airstrikes", "fly near", "flew near", "flying near",
  "quarantine", "quarantined", "detained", "arrested", "jailed",
  "suspended", "grounded pilots", "pilots suspended",
  "audited", "audit", "investigation", "probe",
  // Passenger died / medical
  "died while", "died on", "died after", "died during",
  "died disembarking", "died boarding", "died on board",
  "collapsed", "heart attack", "medical emergency",
  "survived but", "survived the flight",
  // Structural/safety failure
  "defective", "defect", "faulty", "fault",
  "engine defective", "engine faulty", "engine fault",
  "grounded aircraft", "grounded planes", "grounded jets",
  "airworthiness", "unairworthy", "not airworthy",
  "damaged", "too damaged", "structurally",
  "parts could separate", "parts may separate", "parts separating",
  "separation", "detach", "detached", "detaching",
  "cracks", "cracked", "cracking", "fracture", "fractured",
  "metal debris", "debris found", "foreign object",
  "hit the runway", "overran", "overrun", "runway excursion",
  "clipped", "struck", "hit another", "collided with",
  "diverted", "diversion", "emergency diversion",
  "threw", "thrown", "flung", "hurled",
  "turbulence", "severe turbulence", "extreme turbulence",
  "injured", "injuries", "hurt", "hospitalised", "hospitalized",
  "five people", "seven people", "ten people", "multiple people",
  "without touching", "wake turbulence",
  // Scandal / accountability
  "fired", "dismissed", "terminated", "sacked",
  "viral video", "cockpit video", "leaked video",
  "whistleblower", "retaliation", "cover-up", "coverup",
  "not guilty", "acquitted", "cleared",
  "found guilty", "convicted", "sentenced",
  "years after", "decade after", "anniversary",
  "still no answer", "still no explanation", "unanswered",
  "deadliest", "deadliest crash", "deadliest in",
  "killed", "dead", "deaths", "fatalities", "fatal crash", "fatal flight",
  "passengers died", "crew died", "pilot died", "people died",
  "perished", "lost their lives", "body found", "bodies found",
  "never found", "disappeared after", "dies mid-flight",
  "crash", "crashed", "collision", "collided", "wreckage",
  "no survivors", "all aboard", "death toll", "casualty", "casualties",
  "victim", "victims", "tragedy", "tragic", "catastrophe",
  "not qualified", "unqualified pilot", "pilot error", "crew error",
  "not properly qualified", "improperly qualified", "lacked qualifications",
  "fatal", "fatally", "ntsb says", "ntsb finds", "ntsb report",
  "investigation finds", "investigation reveals", "probe finds",
  "neither pilot", "both pilots", "crew not", "pilot not",
];

/** Death count patterns — "67 dead", "260 deaths", "all 4 aboard", "after X deaths" */
const DEATH_COUNT_PATTERN = /\b(\d+)\s*(dead|killed|deaths|fatalities|victims|aboard|on board)\b|\ball\s+(\d+)\s+(aboard|on board|killed|dead)\b/i;

// ─── Tier 2: Strong consistent performers ────────────────────────────────────

/** Pilot and crew pay — consistently 1k+ reactions, 500+ comments */
const PILOT_PAY_KEYWORDS = [
  "pilot pay", "pilot salary", "pilot earn", "captain pay", "captain salary",
  "captain earn", "first officer pay", "pilot wage", "pilot income",
  "flight attendant pay", "flight attendant salary", "cabin crew pay",
  "crew pay", "crew salary", "crew earn", "crew wage",
  "pilots make", "captains make", "pilots earn", "captains earn",
  "per hour", "an hour", "a year", "annually",
  "paycheck", "pay check", "pay rise", "pay cut", "pay raise",
  "how much", "what pilots", "what captains", "what flight attendant",
  "reveal", "revealed", "shows paycheck", "shows pay",
];

/** Passenger outrage and unfair policy */
const PASSENGER_OUTRAGE_KEYWORDS = [
  // Left behind / abandoned passengers
  "took off without", "left behind", "left passengers behind", "abandoned passengers",
  "passengers left", "passengers stranded", "stranded passengers",
  "without passengers", "without boarding", "boarded without",
  // Paid premium, got nothing
  "paid for business class", "paid for first class", "paid for premium",
  "business class", "first class", "premium cabin", "premium seat",
  "stuck sitting", "stuck flat", "stuck in", "couldn't sit", "couldn't recline",
  "seat broken", "broken seat", "seat wouldn't", "seat didn't",
  "spent hours", "14 hours", "12 hours", "10 hours", "8 hours",
  // Fake boarding pass / security breach
  "fake boarding pass", "fake ticket", "forged boarding",
  "boarded without", "got on without", "snuck on",
  "security breach", "security failure", "bypassed security",
  // Cancelled routes / flights
  "cancelled flights", "cancelled all flights", "cancelled routes",
  "cancelled for the entire", "cancelled for summer", "cancelled for winter",
  "entire summer", "entire winter", "entire season",
  "suspended flights", "suspended routes", "suspended service",
  "grounded by", "grounded due",
  // Existing keywords
  "duct-taped", "duct taped", "duct tape", "taped to seat", "tied to seat",
  "bed bugs", "no window", "window seat no window", "window seat without a window",
  "child goes hungry", "child went hungry", "baby goes hungry", "child starved",
  "plus-size", "plus size", "second seat", "pay for second seat", "buy second seat",
  "refused refund", "denied boarding", "kicked off", "removed from flight", "thrown off",
  "dragged", "humiliated", "stranded for days", "stuck on tarmac", "left stranded",
  "wheelchair abuse", "wheelchair fraud", "boarding abuse", "wheelchair requests",
  "wheelchair-first", "wheelchair boarding", "wheelchair policy", "wheelchair ends",
  "wheelchair ban", "wheelchair rule", "wheelchair scam", "wheelchair cheating",
  "no pay until doors close", "unpaid boarding",
  "passenger duct", "passenger taped", "passenger restrained", "passenger tied",
  "furious", "outraged", "disgusted", "appalled", "shocking treatment",
  "no food", "denied food", "refused food", "hungry passenger", "starving passenger",
  "lost luggage", "luggage destroyed", "bag destroyed", "bag lost",
  "overbooked", "bumped from flight", "involuntary denied",
  "seat sold twice", "double booked", "wrong seat",
  "window seat", "no window seat",
];

/** Policy controversy — unfair or shocking rules */
const POLICY_CONTROVERSY_KEYWORDS = [
  "banned for life", "banned him", "banned her", "banned passenger",
  "policy change", "new rule", "new policy", "ends free", "removes free",
  "now charges", "will charge", "must pay", "required to pay",
  "no longer free", "cuts free", "scraps free",
  "whistleblower", "retaliation", "fired for reporting",
];

/** Money shock — exact large figures drive engagement */
const MONEY_EXACT_KEYWORDS = [
  "billion", "million", "\\$[0-9]", "£[0-9]", "€[0-9]",
  "revenue", "profit", "net income", "loss", "losses",
  "compensation", "settlement", "lawsuit", "suing for",
  "pays out", "awarded", "fine", "penalty",
  // Value-collapse / contradiction money signals
  "break even", "break-even", "couldn't profit", "never profitable",
  "barely profited", "still losing", "still in the red",
  "cost overrun", "over budget", "billions over",
];

/** Exact money pattern — "$54.6 billion", "€338,282", "$200,000" */
const MONEY_AMOUNT_PATTERN = /[\$£€]\s*[\d,]+(\.\d+)?\s*(billion|million|thousand|k\b)?/i;

/**
 * Airline M&A / takeover / acquisition — proven high-engagement category
 * easyJet takeover battle, Castlelake/Apollo bidding war, airline mergers
 * These stories drive massive engagement because they affect passengers directly.
 */
const AIRLINE_MA_KEYWORDS = [
  // Takeover / acquisition language
  "takeover", "takeover bid", "takeover battle", "takeover offer", "takeover deal",
  "acquisition", "acquired", "acquires", "acquiring",
  "buyout", "buy out", "bought out", "buying out",
  "merger", "merging", "merged", "merge with",
  "bid for", "bidding for", "bidding war", "rival bid", "counter bid", "competing bid",
  "offer for", "offer to buy", "offer to acquire",
  "private equity", "castlelake", "blackstone", "carlyle", "kkr",
  // Airline-specific M&A signals
  "easyjet takeover", "ryanair bid", "british airways owner", "iag bid",
  "airline deal", "airline merger", "airline acquisition", "airline buyout",
  "stake in", "majority stake", "minority stake", "controlling stake",
  "shareholders approve", "shareholders vote", "board approves", "board rejects",
  "agreed in principle", "agreed to sell", "agreed to buy", "agreed to merge",
  "per share", "share price", "stock deal", "all-cash deal", "cash offer",
  "hostile takeover", "friendly takeover", "unsolicited bid",
  "outbid", "topped the bid", "raised its offer", "upped its offer",
];

// ─── Tier 3: Reliable mid-range performers ───────────────────────────────────

/** NTSB, FAA, court, official accountability */
const AUTHORITY_KEYWORDS = [
  "ntsb", "faa", "easa", "caa", "dot ", "department of transport",
  "court filing", "lawsuit", "sued", "suing", "legal action",
  "investigation", "probe", "inquiry", "ruling", "verdict",
  "grounded by", "banned by", "fined by", "penalised",
  "official report", "safety board", "air accident",
];

/** Celebrity or famous person involvement */
const CELEBRITY_KEYWORDS = [
  "gayle king", "elon musk", "trump", "taylor swift", "king charles",
  "prince", "princess", "president", "prime minister", "billionaire",
  "celebrity", "famous", "star passenger", "footballer", "striker",
  "athlete", "actor", "politician", "royal family",
];

/** Superlatives — first, last, only, biggest, fastest, longest */
const SUPERLATIVE_KEYWORDS = [
  "first time", "first ever", "first u.s.", "first american", "first airline",
  "last flight", "final flight", "last ever", "last remaining", "final ever",
  "only airline", "only jet", "only aircraft", "only operator",
  "biggest", "largest", "fastest", "longest", "highest", "oldest",
  "never before", "record-breaking", "world record", "history made",
  "milestone", "first in history", "last in history",
  // Route superlatives — first transatlantic, world's longest, etc.
  "first transatlantic", "first transpacific", "first nonstop", "first direct",
  "world's longest", "world's first", "longest nonstop", "longest flight",
  // Network/carrier milestones — "longest flight in its network history", "longest domestic route"
  "network history", "in its history", "in the airline's history", "in carrier history",
  "longest domestic", "longest ever", "longest route ever",
];

/** Old aircraft, nostalgia, finality — also catches "last" in title */
const NOSTALGIA_KEYWORDS = [
  "a380", "747", "747-400", "747-8", "747-100", "jumbo jet",
  "a340", "md-11", "dc-10", "dc-8", "dc-9", "727", "707",
  "concorde", "l-1011", "tristar", "lockheed",
  "still flying", "oldest jet", "oldest aircraft", "built in 19",
  "final flight", "last flight", "farewell flight", "retirement",
  "retires", "retired", "heading to the desert", "scrapped",
  "museum", "preserved", "classic jet", "vintage aircraft",
  "dc-3", "dc-4", "dc-6", "dc-7", "dc-8", "dc-9", "dc-10", "md-11", "md-80", "md-90",
  "l-1011", "tristar", "concorde", "tu-144", "comet",
  "vintage aircraft", "vintage plane", "vintage jet", "vintage airliner",
  "warbird", "classic airliner", "historic aircraft", "historic plane",
  // A380 / programme-level nostalgia: '251 deliveries later', 'couldn't break even'
  "deliveries later", "couldn't break even", "still couldn't", "never broke even",
  "the last ", "its final", "her final", "his final",
  "last flight", "final landing", "farewell flight", "retirement flight",
  "oldest aircraft", "oldest plane", "oldest jet", "oldest airline",
  "built in 19", "built in 20", "years old aircraft", "year old aircraft",
];

/** Weird human moments — unpredictable but can hit 5M+ */
const WEIRD_HUMAN_KEYWORDS = [
  "eats passport", "ate passport", "eating passport", "eating his passport", "eating her passport",
  "eating his own passport", "eating her own passport", "eats his passport", "eats her passport",
  "man eats", "woman eats", "passenger eats", "man ate", "woman ate", "passenger ate",
  "eating own passport", "ate his passport", "ate her passport",
  "farting", "fart", "flatulence", "smells", "body odour", "body odor",
  "baby born", "born on board", "born mid-flight", "gives birth", "gave birth", "born during",
  "puppy", "dog on flight", "animal on board", "cat on board", "pet on flight",
  "cannabis", "cannabis sweets", "drugs on board", "cocaine", "heroin", "smuggling drugs",
  "drunk passenger", "intoxicated passenger", "drunk pilot", "drunk crew",
  "naked", "streaker", "stowaway", "stowaways",
  "snakes", "live snakes", "smuggled", "live animals", "live reptiles",
  "captain faints", "pilot faints", "pilot loses consciousness", "pilot unconscious",
  "copilot loses consciousness", "copilot unconscious",
  "atc meltdown", "atc audio", "live atc", "air traffic control meltdown",
  "bizarre", "strange passenger", "unusual passenger", "odd passenger",
  "fight on board", "brawl on board", "passenger fight", "passenger brawl",
  "passenger arrested", "passenger handcuffed", "passenger detained",
  "opens emergency exit", "opened emergency door", "opened exit door",
  "slides deployed", "evacuation slide",
  "passenger strips", "passenger undresses",
  // Instructor / pilot incapacitation — student alone
  "instructor jumps", "instructor jumped", "instructor leapt", "instructor fell",
  "student pilot alone", "student pilot forced", "student pilot had to",
  "student lands alone", "student landed alone", "student pilot lands",
  "forced to land alone", "had to land alone", "landed alone",
  "solo landing", "first solo", "unexpected solo",
  "pilot jumps", "pilot jumped", "pilot fell out", "pilot fell from",
  "pilot ejected", "co-pilot jumps", "copilot jumps",
  "instructor dies", "instructor died", "instructor unconscious", "instructor incapacitated",
  "instructor suicide", "jumped to his death", "jumped to her death",
  "jumped from the plane", "fell from the plane", "fell out of the plane",
  "fell out of the aircraft", "fell out of the cockpit",
  "sucked out", "sucked through", "pulled through window", "pulled out window",
  "nearly sucked", "partially sucked", "blown out", "blown through",
];

/** Safety incidents — emergency, mayday, engine failure */
const SAFETY_INCIDENT_KEYWORDS = [
  "mayday", "emergency declared", "engine failure", "engine fire",
  "engine shut down", "engine flame", "engine detached",
  "cockpit window crack", "windshield crack", "windshield shatter",
  "oxygen masks deploy", "oxygen masks dropped", "decompression",
  "runway incursion", "wrong runway", "taxiway takeoff", "took off from taxiway",
  "near miss", "near collision", "close call",
  "bird strike", "hydraulic failure", "landing gear failure",
  "smoke in cabin", "fire on board", "diverted after",
  "emergency landing", "forced landing",
  "maintenance issues", "unresolved maintenance", "maintenance problems",
  "attacking crew", "attacked crew", "assaulted crew", "assault on crew",
  "crew assault", "passenger attack", "passenger attacks",
];

/** Child or family involved — emotional multiplier */
const CHILD_FAMILY_KEYWORDS = [
  "child", "children", "baby", "infant", "toddler",
  "family", "mother", "father", "parent", "parents",
  "goes hungry", "went hungry", "denied food", "no food",
  "43 children", "kids", "young passenger",
];

/** Mystery, unsolved tragedy, historical drama */
const MYSTERY_TRAGEDY_KEYWORDS = [
  "mh370", "malaysia airlines 370", "missing plane", "disappeared",
  "never found", "unsolved", "mystery", "still searching",
  "hijacked", "hijacking", "voicemail", "final call",
  "last words", "last message", "9/11", "world trade center",
  "lockerbie", "tenerife", "disaster",
];

/**
 * "I didn't know that" aviation facts — evergreen, highly shareable
 * These work when the fact is simple, visual, and surprising.
 * Examples: "The oxygen masks are not meant to keep you alive for long"
 *           "The 777's engines are massive because two had to do the job of four"
 */
const AVIATION_FACT_KEYWORDS = [
  "why ", "how ", "the reason", "the truth about", "you didn't know",
  "most people don't know", "here's why", "this is why", "that's why",
  "not meant to", "not designed to", "not actually", "never actually",
  "the real reason", "the secret", "the hidden", "the surprising",
  "did you know", "fact:", "myth:", "explained",
  "how pilots", "what pilots", "why pilots", "how airlines", "what airlines",
  "how planes", "what planes", "why planes", "how aircraft",
  "oxygen mask", "oxygen masks", "black box", "flight recorder",
  "autopilot", "turbulence", "contrails", "chemtrails",
  "brace position", "emergency exit", "life vest",
  "cockpit", "flight deck", "altimeter", "transponder",
  "etops", "twin engine", "four engine", "quadjet",
  "thrust", "lift", "drag", "stall speed",
  // Explanatory connectors — only specific compound phrases, not bare 'because'
  // Bare 'because' caused false boosts on weak stories like 'JetBlue adds route because demand is high'
  "the reason why", "here is why", "this is how",
  "massive because", "huge because", "enormous because", "wide because",
  "never worked", "doesn't work", "can't work", "won't work",
  "almost gone", "nearly gone", "disappearing", "dying out",
  // NOTE: 'still flying' removed here — it is already in NOSTALGIA_KEYWORDS
  // Adding it here caused double-counting on nostalgia stories
];

/** Contradiction / value-collapse patterns — "made billions but barely profited", "sold window seat with no window" */
const CONTRADICTION_PATTERN = /(once|was|were|used\s+to\s+be|originally|formerly|new|brand.?new)\s.{0,60}(now|today|currently|but\s+now|but\s+today)|(\$[\d,.]+[mb]?|[\d,.]+\s*(million|billion)).{0,80}(\$[\d,.]+[mb]?|[\d,.]+\s*(million|billion))|(safest|best|top|world.?class|award.?winning).{0,60}(worst|failed|banned|grounded|crashed|sued|scandal)|(sold|bought|purchased|listed).{0,40}(million|billion|thousand).{0,40}(million|billion|thousand)/i;

/**
 * Industry-scale crisis / systemic failure — "900 planes grounded", "global engine crisis"
 * These score high because the scale is shocking and affects everyone.
 */
const INDUSTRY_CRISIS_KEYWORDS = [
  "global engine crisis", "engine crisis", "engine shortage",
  "grounded fleet", "entire fleet grounded", "mass grounding", "widespread grounding",
  "hundreds of aircraft", "hundreds of planes", "hundreds of jets",
  "sitting idle", "parked", "stored in desert", "mothballed",
  "supply chain crisis", "parts shortage", "maintenance backlog",
  "pilot shortage", "crew shortage", "staffing crisis",
  "air traffic control failure", "atc outage", "radar failure",
  "system failure", "system outage", "it outage", "it failure",
  "cancelled flights", "mass cancellations", "thousands of flights",
];

/**
 * Irony / contradiction punchline — "finally did X, but Y", "promised X, delivered Y"
 * Pattern: "ADDED X, BUT CANT Y", "LAUNCHED X, THEN Y", "X, BUT PASSENGERS STILL CANT"
 * These drive debate and sharing because they feel unfair or absurd.
 */
const IRONY_PUNCHLINE_PATTERN = /\b(finally|at last|after\s+\d+\s+years?|after\s+years?).{0,80}(but|however|yet|still|except|only to|turns out)/i;
const IRONY_TITLE_PATTERN = /,\s*(but|however|yet|still|except|turns out|only to)\b|\bbut.{0,50}(still|never|cant|cannot|wont|refused|failed|collapsed|turned around|went wrong)/i;

/**
 * Salary / pay controversy — cabin crew, pilot pay debates
 * "Emirates cabin crew salaries have gone viral" = 108k views
 * "Delta reopened applications for most competitive job" = 310k views
 */
const SALARY_DEBATE_KEYWORDS = [
  "salary", "salaries", "gone viral", "people can't agree", "people cant agree",
  "debate", "arguing", "divided", "sparked debate", "sparked outrage",
  "most competitive", "competitive job", "coveted job", "dream job",
  "applications open", "hiring again", "applications reopened",
  "cabin crew salary", "cabin crew pay", "flight attendant salary",
  "pilot applications", "pilot hiring", "pilot recruitment",
  // Career-ending / viral pilot story
  "cost him his career", "cost her his career", "ended his career", "ended her career",
  "fired after viral", "fired over viral", "fired for viral", "fired following viral",
  "may have cost", "could have cost", "ruined his career", "ruined her career",
];

/**
 * Systemic failure / scandal — airline caught doing something wrong at scale
 * "SWISS breaking up jets", "777X flying but no passengers", "A350 looks fine but damaged"
 */
const SYSTEMIC_FAILURE_KEYWORDS = [
  "breaking up", "cannibalising", "cannibalizing", "stripping for parts",
  "grounded indefinitely", "still grounded", "never flew", "never entered service",
  "looks fine", "appears fine", "looks normal", "appears normal",
  "hidden damage", "invisible damage", "undetectable", "can't be seen",
  "still no passengers", "no passengers yet", "passengers still can't",
  "still hasn't", "still can't", "still won't", "still not",
  "seven years", "five years", "years of delays", "years of problems",
  "most tested", "most scrutinised", "most delayed",
  // Pre-service order irony — "ordered more before it even entered service"
  "before the aircraft even", "before it even enters", "before entering service",
  "before a single passenger", "before carrying a single",
];

/**
 * Comeback / return story — airline returns after years, route revived
 * "SAS returned to India after 17 years" = 70k views
 * "Delta returning to Hong Kong after 7 years" = 21k
 * "Delta returning to LA-Vancouver after 7 years" = 16.7k
 * High when combined with drama (first flight turned around)
 */
const COMEBACK_KEYWORDS = [
  "after \\d+ years", "returns after", "returned after", "back after",
  "first time since", "first flight since", "resumes", "resumed",
  "comeback", "returning to", "returns to", "back to",
];

/**
 * Viral debate / opinion story — "should X be allowed", "people are arguing"
 * "Should airline pilots be allowed to fly until 67?" = 55k views
 * "Paul Rudd says airplane mode is nonsense" = 22k
 */
const VIRAL_DEBATE_KEYWORDS = [
  "should ", "is it right", "is it fair", "people are arguing", "fans are arguing",
  "divided opinion", "sparks debate", "sparked debate", "controversial",
  "people disagree", "people cant agree", "people can't agree",
  "do you think", "would you", "what do you think",
];

/** Weak story patterns — route launches, generic corporate */
const WEAK_STORY_KEYWORDS = [
  "new route", "route launch", "launches flights to", "adds flights to",
  "new service to", "begins service to", "starts flying to",
  "new nonstop", "adds nonstop", "new daily flight",
  "codeshare", "alliance", "partnership announced",
  "terminal opens", "terminal expansion", "airport expansion",
  "fleet order", "orders aircraft", "signs deal for",
  "quarterly results", "annual report", "earnings call",
  "ceo appointed", "new ceo", "leadership change",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

function getMatchedKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

function hasPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

// ─── Main scoring function ────────────────────────────────────────────────────

// ── Non-aviation content patterns — hard penalty ────────────────────────────
// These patterns identify content that is clearly NOT aviation-related.
// Stories matching these patterns get a hard -60 penalty, pushing them to Reject
// regardless of other signals. This catches lifestyle/wellness/travel content
// that slips through from feeds like Condé Nast Traveler, The Points Guy, etc.
const NON_AVIATION_PATTERNS = [
  // Wellness / health / biohacking
  /\b(wellness|biohacking|biohack|supplement|vitamin|meditation|yoga|mindfulness|gut\s+health|sleep\s+hack|longevity|anti.?aging|detox|cleanse|skincare|skin\s+care|beauty\s+routine|self.?care)\b/i,
  // Food / restaurants / hotels (when not aviation-related)
  /\b(restaurant|hotel\s+review|best\s+hotel|resort|spa\s+day|michelin\s+star|recipe|cookbook|chef|cuisine|foodie|wine\s+tasting|cocktail\s+bar)\b/i,
  // Travel guides / listicles (non-aviation)
  /\b(best\s+beaches|top\s+destinations|places\s+to\s+visit|travel\s+guide|bucket\s+list|hidden\s+gem|travel\s+tips|packing\s+tips|what\s+to\s+pack|travel\s+hack)\b/i,
  // Road trips / driving content (non-aviation)
  /\b(road\s+trip|road\s+trips|driving\s+route|scenic\s+drive|best\s+drives|cross.?country\s+drive|rv\s+trip|campervan|motorhome)\b/i,
  // Hotel / accommodation listicles (non-aviation)
  /\b(best\s+hotels?|hotel\s+deals?|luxury\s+hotels?|boutique\s+hotels?|airbnb|vacation\s+rental|best\s+resorts?|all.?inclusive|hotel\s+review|top\s+hotels?|hotels?\s+in\s+\w+|\d+\s+best\s+hotels?)\b/i,
  // General travel listicles (non-aviation)
  /\b(best\s+places|top\s+places|must.?see|must\s+visit|things\s+to\s+do|weekend\s+getaway|day\s+trip|staycation|city\s+guide|travel\s+itinerary|itinerary\s+for)\b/i,
  // Nature / wildlife (non-aviation)
  /\b(cactus|cacti|succulent|plant\s+collector|mushroom\s+foraging|forager|birdwatching|safari|whale\s+watching|coral\s+reef|national\s+park\s+guide)\b/i,
  // Celebrity gossip (non-aviation)
  /\b(royal\s+family|king\s+charles|prince\s+william|princess\s+kate|meghan|harry\s+and\s+meghan|sussex|archie\s+and\s+lilibet|kensington\s+palace)\b/i,
  // Celebrity gossip — pop culture (non-aviation)
  /\b(taylor\s+swift|beyonce|kardashian|kanye\s+west|drake|rihanna|celebrity\s+news|celebrity\s+gossip|red\s+carpet|grammy|oscar\s+winner|met\s+gala)\b/i,
  // Immigration / visa / politics (non-aviation)
  /\b(immigration\s+policy|visa\s+application|green\s+card|citizenship\s+test|border\s+wall|deportation\s+policy|asylum\s+seeker|refugee\s+crisis|migrant\s+caravan)\b/i,
];

// Aviation content signals — if ANY of these are present, the non-aviation penalty is NOT applied
const AVIATION_CONTENT_SIGNALS = [
  /\b(flight|airline|airlines|airport|aircraft|plane|planes|pilot|pilots|aviation|airfare|boeing|airbus|runway|cockpit|cabin\s+crew|flight\s+attendant|air\s+traffic|faa|ntsb|easa|turbulence|emergency\s+landing|plane\s+crash|helicopter|private\s+jet|private\s+jets|jet\s+plane|chartered\s+flight|charter\s+flight|air\s+travel|air\s+passenger|frequent\s+flyer|frequent\s+flier|miles\s+and\s+points|business\s+class|first\s+class\s+cabin|economy\s+class|seat\s+upgrade|seat\s+selection|boarding\s+pass|gate\s+agent|tsa|customs\s+and\s+immigration|baggage\s+claim|carry.?on|checked\s+bag)\b/i,
];

export function scoreStory(title: string, content: string): ScoringResult {
  const fullText = `${title} ${content}`;
  const titleLower = title.toLowerCase();
  const triggers: string[] = [];
  let score = 20; // baseline

  // ── Hard non-aviation penalty ──────────────────────────────────────────────────
  // Catches wellness, food, hotel, travel-guide, and celebrity gossip content
  // that slips through from lifestyle feeds. Only fires if there are NO aviation
  // signals in the story at all.
  const hasAviationSignal = AVIATION_CONTENT_SIGNALS.some(p => p.test(fullText));
  if (!hasAviationSignal) {
    const nonAviationMatch = NON_AVIATION_PATTERNS.find(p => p.test(fullText));
    if (nonAviationMatch) {
      score -= 60;
      triggers.push("Non-aviation content — lifestyle/wellness/travel guide penalty");
    }
  }

  // ── Tier 1: Boeing safety + rivalry (avg 3,777 engagement) ──────────────
  const boeingSafetyMatches = getMatchedKeywords(fullText, BOEING_SAFETY_KEYWORDS);
  const boeingRivalryMatches = getMatchedKeywords(fullText, BOEING_AIRBUS_RIVALRY_KEYWORDS);
  const hasBoeingFaaCombined = BOEING_FAA_COMBINED_PATTERN.test(fullText);

  if (boeingSafetyMatches.length >= 2 || hasBoeingFaaCombined) {
    score += 40;
    triggers.push(`Boeing safety crisis: ${boeingSafetyMatches.slice(0, 2).join(", ") || "Boeing + FAA confrontation"}`);
  } else if (boeingSafetyMatches.length === 1) {
    score += 28;
    triggers.push(`Boeing safety: ${boeingSafetyMatches[0]}`);
  }

  if (boeingRivalryMatches.length >= 1) {
    score += 22;
    triggers.push(`Boeing vs Airbus rivalry: ${boeingRivalryMatches[0]}`);
  }

  // ── Tier 1: Death count (proven 1M+ driver) ──────────────────────────────
  const fatalMatches = getMatchedKeywords(fullText, FATAL_DEATH_KEYWORDS);
  const hasDeathCount = hasPattern(fullText, DEATH_COUNT_PATTERN);

  if (hasDeathCount && fatalMatches.length >= 2) {
    score += 45;
    triggers.push("Specific death count + fatal crash — highest engagement driver");
  } else if (hasDeathCount) {
    score += 35;
    triggers.push("Specific death count mentioned");
  } else if (fatalMatches.length >= 3) {
    score += 30;
    triggers.push("Fatal crash or multiple death references");
  } else if (fatalMatches.length >= 2) {
    score += 22;
    triggers.push("Fatal crash or death references");
  } else if (fatalMatches.length === 1) {
    score += 14;
    triggers.push(`Death/fatality reference: ${fatalMatches[0]}`);
  }

  // ── Tier 2: Money shock with exact figure (avg 3,513 engagement) ─────────
  const hasExactMoney = hasPattern(fullText, MONEY_AMOUNT_PATTERN);
  const moneyMatches = getMatchedKeywords(fullText, MONEY_EXACT_KEYWORDS);

  if (hasExactMoney && moneyMatches.length >= 2) {
    score += 35;
    triggers.push("Exact money figure + financial context — strong engagement driver");
  } else if (hasExactMoney) {
    score += 25;
    triggers.push("Exact money figure in story");
  } else if (moneyMatches.length >= 2) {
    score += 15;
    triggers.push("Financial angle");
  } else if (moneyMatches.length === 1) {
    score += 8;
    triggers.push("Financial element");
  }

  // ── Tier 2: Weird human moments (avg 3,508 engagement, ceiling 5.5M) ─────
  const weirdMatches = getMatchedKeywords(fullText, WEIRD_HUMAN_KEYWORDS);
  if (weirdMatches.length >= 2) {
    score += 50;
    triggers.push(`Weird human moment: ${weirdMatches.slice(0, 2).join(", ")}`);
  } else if (weirdMatches.length === 1) {
    score += 40;
    triggers.push(`Weird human moment: ${weirdMatches[0]}`);
  }

  // ── Tier 2: Celebrity involvement (avg 2,642 engagement, ceiling 3M) ─────
  const celebMatches = getMatchedKeywords(fullText, CELEBRITY_KEYWORDS);
  if (celebMatches.length >= 1) {
    score += 28;
    triggers.push(`Celebrity/public figure: ${celebMatches[0]}`);
  }

  // ── Tier 2: Passenger outrage (avg 2,583 engagement) ─────────────────────
  const outrageMatches = getMatchedKeywords(fullText, PASSENGER_OUTRAGE_KEYWORDS);
  const policyMatches = getMatchedKeywords(fullText, POLICY_CONTROVERSY_KEYWORDS);

  const hasAbuseKeyword = /\b(abuse|abused|abusing|years of abuse|widespread abuse)\b/i.test(fullText);

  if (outrageMatches.length >= 2) {
    score += 42;
    triggers.push(`Strong passenger outrage: ${outrageMatches.slice(0, 2).join(", ")}`);
  } else if (outrageMatches.length === 1) {
    score += 30;
    triggers.push(`Passenger outrage: ${outrageMatches[0]}`);
  }

  if (policyMatches.length >= 1) {
    score += 22;
    triggers.push(`Policy controversy: ${policyMatches[0]}`);
  }

  // Abuse + policy combo — e.g. wheelchair abuse + ends policy = very high engagement
  if (hasAbuseKeyword && (outrageMatches.length >= 1 || policyMatches.length >= 1)) {
    score += 18;
    triggers.push("Abuse + policy change combo — proven high engagement");
  }

  // ── Tier 3: Safety + accountability (avg 1,706 engagement) ───────────────
  const authorityMatches = getMatchedKeywords(fullText, AUTHORITY_KEYWORDS);
  if (authorityMatches.length >= 2) {
    score += 22;
    triggers.push(`Official action: ${authorityMatches.slice(0, 2).join(", ")}`);
  } else if (authorityMatches.length === 1) {
    score += 14;
    triggers.push(`Official action: ${authorityMatches[0]}`);
  }

  const safetyMatches = getMatchedKeywords(fullText, SAFETY_INCIDENT_KEYWORDS);
  if (safetyMatches.length >= 3) {
    score += 20;
    triggers.push(`High-consequence safety incident: ${safetyMatches.slice(0, 2).join(", ")}`);
  } else if (safetyMatches.length >= 1) {
    score += 12;
    triggers.push(`Safety incident: ${safetyMatches[0]}`);
  }

  // ── Tier 3: Pilot/crew pay (avg 1,378 engagement) ────────────────────────
  const pilotPayMatches = getMatchedKeywords(fullText, PILOT_PAY_KEYWORDS);
  if (pilotPayMatches.length >= 3) {
    score += 30;
    triggers.push("Pilot/crew pay story with specific figures");
  } else if (pilotPayMatches.length >= 2) {
    score += 24;
    triggers.push("Pilot/crew pay story with figures");
  } else if (pilotPayMatches.length === 1) {
    score += 16;
    triggers.push("Pilot or crew pay story");
  }

  // ── Tier 3: Superlatives (avg 1,270 engagement) ──────────────────────────
  const superlativeMatches = getMatchedKeywords(fullText, SUPERLATIVE_KEYWORDS);
  if (superlativeMatches.length >= 2) {
    score += 20;
    triggers.push(`Strong superlative angle: ${superlativeMatches.slice(0, 2).join(", ")}`);
  } else if (superlativeMatches.length === 1) {
    score += 12;
    triggers.push(`Superlative: ${superlativeMatches[0]}`);
  }

  // ── Tier 4: Nostalgia + old aircraft (avg 638 engagement) ────────────────
  // Data calibration: Last DC-8 = 413k views, Delta oldest jet = 330k,
  // Korean Air 747 return = 4.5k reactions, A380 break-even = 688k views.
  // Nostalgia is category 4 per FlightDrama formula — raised from under-weighted tier.
  const nostalgiaMatches = getMatchedKeywords(fullText, NOSTALGIA_KEYWORDS);
  if (nostalgiaMatches.length >= 3) {
    score += 32;
    triggers.push(`Strong nostalgia: ${nostalgiaMatches.slice(0, 3).join(", ")}`);
  } else if (nostalgiaMatches.length >= 2) {
    score += 26;
    triggers.push(`Nostalgia: ${nostalgiaMatches.slice(0, 2).join(", ")}`);
  } else if (nostalgiaMatches.length === 1) {
    score += 18;
    triggers.push(`Nostalgia: ${nostalgiaMatches[0]}`);
  }

  // ── Bonus: Nostalgia + crash combo (old aircraft crash = proven high engagement) ──
  const hasCrashOrFatal = fatalMatches.length >= 1 || hasDeathCount;
  if (nostalgiaMatches.length >= 1 && hasCrashOrFatal) {
    score += 8;
    triggers.push("Old aircraft crash — nostalgia + tragedy combo");
  }

  // ── Bonus: Child or family involved ──────────────────────────────────────
  const childMatches = getMatchedKeywords(fullText, CHILD_FAMILY_KEYWORDS);
  if (childMatches.length >= 2) {
    score += 12;
    triggers.push("Child or family involved — emotional multiplier");
  } else if (childMatches.length === 1) {
    score += 6;
    triggers.push("Family/child element");
  }

  // ── Bonus: Mystery or unsolved tragedy ───────────────────────────────────
  const mysteryMatches = getMatchedKeywords(fullText, MYSTERY_TRAGEDY_KEYWORDS);
  if (mysteryMatches.length >= 1) {
    score += 15;
    triggers.push(`Mystery/tragedy angle: ${mysteryMatches[0]}`);
  }

  // ── Bonus: "I didn't know that" aviation facts (evergreen, highly shareable) ────
  // Title must start with "Why", "How", "The reason", etc. AND mention a specific aircraft/system
  const factKeywordsInTitle = getMatchedKeywords(title, AVIATION_FACT_KEYWORDS);
  const hasNamedAircraftInTitle = /\b(777|787|747|a380|a350|a321|737|a320|dc-8|dc-10|md-11|concorde|airbus|boeing)\b/i.test(title);
  if (factKeywordsInTitle.length >= 1 && hasNamedAircraftInTitle) {
    score += 38;
    triggers.push(`Aviation fact: ${factKeywordsInTitle[0]} + named aircraft`);
  } else if (factKeywordsInTitle.length >= 2) {
    // Strong explanatory headline even without named aircraft
    score += 35;
    triggers.push(`Aviation explainer: ${factKeywordsInTitle.slice(0, 2).join(", ")}`);
  } else if (factKeywordsInTitle.length >= 1) {
    // Single fact keyword in title — mild boost only
    score += 12;
    triggers.push(`Aviation explainer: ${factKeywordsInTitle[0]}`);
  }

  // ── Bonus: Contradiction / value-collapse ("once $400M, now $21M") ─────────────
  const hasContradiction = CONTRADICTION_PATTERN.test(fullText);
  if (hasContradiction && (nostalgiaMatches.length >= 1 || moneyMatches.length >= 1)) {
    score += 18;
    triggers.push("Contradiction/value-collapse angle — strong engagement driver");
  } else if (hasContradiction) {
    score += 10;
    triggers.push("Contradiction angle");
  }

  // ── Bonus: Named aircraft + safety failure combo (Air India 787 with faults) ────
  // Formula: death/injury + official failure + named aircraft + consequence
  const hasNamedAircraft = /\b(777|787|747|a380|a350|a321|a320|737|a340|a330|a220|dc-8|dc-10|md-11|concorde|dreamliner|jumbo)\b/i.test(fullText);
  if (hasNamedAircraft && safetyMatches.length >= 1 && authorityMatches.length >= 1) {
    score += 15;
    triggers.push("Named aircraft + safety failure + official action — proven formula");
  } else if (hasNamedAircraft && (safetyMatches.length >= 2 || (safetyMatches.length >= 1 && fatalMatches.length >= 1))) {
    score += 10;
    triggers.push("Named aircraft + safety incident");
  }

  // ── Bonus: Exact numbers in title (specificity = credibility = shares) ───
  const numberInTitle = /\b\d[\d,]*(\.\d+)?\s*(million|billion|thousand|k\b|%|mph|km|ft|hours?|minutes?|years?|days?|passengers?|jobs?|aircraft|jets?|planes?|seats?|routes?|flights?|pilots?|crew)?\b/i.test(title);
  if (numberInTitle) {
    score += 6;
    triggers.push("Specific number in headline");
  }

  // ── Bonus: Industry-scale crisis (900 planes grounded, global engine crisis) ──────
  const industryCrisisMatches = getMatchedKeywords(fullText, INDUSTRY_CRISIS_KEYWORDS);
  if (industryCrisisMatches.length >= 2) {
    score += 38;
    triggers.push(`Industry-scale crisis: ${industryCrisisMatches.slice(0, 2).join(", ")}`);
  } else if (industryCrisisMatches.length === 1) {
    score += 22;
    triggers.push(`Industry crisis: ${industryCrisisMatches[0]}`);
  }

  // ── Bonus: Irony / punchline contradiction ("finally added X, but can't use it") ──
  const hasIronyPunchline = IRONY_PUNCHLINE_PATTERN.test(fullText) || IRONY_TITLE_PATTERN.test(title);
  if (hasIronyPunchline) {
    score += 36;
    triggers.push("Irony/punchline structure — promised X, delivered Y");
  }

  // ── Bonus: Salary debate / viral pay story ────────────────────────────────────────
  const salaryDebateMatches = getMatchedKeywords(fullText, SALARY_DEBATE_KEYWORDS);
  if (salaryDebateMatches.length >= 2) {
    score += 40;
    triggers.push(`Viral salary/job debate: ${salaryDebateMatches.slice(0, 2).join(", ")}`);
  } else if (salaryDebateMatches.length === 1) {
    score += 24;
    triggers.push(`Salary/job story: ${salaryDebateMatches[0]}`);
  }

  // ── Bonus: Systemic failure / hidden damage / years of delays ────────────────────
  const systemicFailureMatches = getMatchedKeywords(fullText, SYSTEMIC_FAILURE_KEYWORDS);
  if (systemicFailureMatches.length >= 2) {
    score += 42;
    triggers.push(`Systemic failure: ${systemicFailureMatches.slice(0, 2).join(", ")}`);
  } else if (systemicFailureMatches.length === 1) {
    score += 26;
    triggers.push(`Systemic failure: ${systemicFailureMatches[0]}`);
  }

  // ── Bonus: Airline M&A / takeover / acquisition ─────────────────────────────────────
  // easyJet/Apollo/Castlelake bidding war, airline mergers — high engagement because
  // passengers care deeply about who owns their airline.
  const airlineMaMatches = getMatchedKeywords(fullText, AIRLINE_MA_KEYWORDS);
  if (airlineMaMatches.length >= 2) {
    score += 40;
    triggers.push(`Airline takeover/M&A: ${airlineMaMatches.slice(0, 2).join(", ")}`);
  } else if (airlineMaMatches.length === 1) {
    score += 28;
    triggers.push(`Airline M&A: ${airlineMaMatches[0]}`);
  }

  // ── Bonus: Comeback / return after years ─────────────────────────────────────────
  // "SAS returned to India after 17 years, first flight turned around" = 70k
  const comebackPattern = /\b(after\s+\d+\s+years?|returns?\s+after|returned\s+after|back\s+after|first\s+time\s+since|resumes?|resumed)\b/i;
  const hasComebackAngle = comebackPattern.test(fullText);
  if (hasComebackAngle) {
    score += 18;
    triggers.push("Comeback/return story — airline or route returns after years");
  }

  // ── Bonus: Viral debate / opinion angle ("should pilots fly until 67?") ──────────
  const viralDebateMatches = getMatchedKeywords(fullText, VIRAL_DEBATE_KEYWORDS);
  if (viralDebateMatches.length >= 2) {
    score += 25;
    triggers.push(`Viral debate angle: ${viralDebateMatches.slice(0, 2).join(", ")}`);
  } else if (viralDebateMatches.length === 1) {
    score += 14;
    triggers.push(`Debate/opinion angle: ${viralDebateMatches[0]}`);
  }

  // ── Penalty: Weak story types ─────────────────────────────────────────────
  // ── Bonus: Historic / huge / unusual route launch ─────────────────────────────────
  // FlightDrama formula rule 7: route launches work ONLY when historic, huge, or unusual.
  // Data: Emirates Denver (2.1k), Alaska transatlantic (1k), World's longest (2.8k),
  //       United SF-Tahiti (300k), Korean Air 747 return (4.5k), Iberia Madrid-Dallas (1.9k)
  // ── Bonus: "Loves to hate" / underdog / surprise ranking story ─────────────────────
  // "The airline everyone loves to hate now owns 620 Boeing 737s debt-free" = 280k
  // "The airport everyone complained about last year is now beating JFK" = 91k
  const lovesToHatePattern = /\b(everyone\s+(loves\s+to\s+hate|hates|complained\s+about|criticized|criticised)|most\s+(hated|complained|criticized)|airline\s+everyone|airport\s+everyone)\b/i;
  const surpriseRankingPattern = /\b(now\s+(beating|outperforming|ahead\s+of|surpassing|overtaking|overtaken|largest|biggest|first)|officially\s+(overtaken|surpassed|become|is\s+now)|has\s+(overtaken|surpassed|become\s+the\s+largest|become\s+the\s+biggest))\b/i;
  if (lovesToHatePattern.test(fullText) || surpriseRankingPattern.test(fullText)) {
    score += 32;
    triggers.push("Surprise ranking / underdog story — loves to hate or unexpected leader");
  }

  // ── Bonus: Fleet order irony — ordered more before first delivery ("Air China increased A350 order before it enters service") ──
  const fleetOrderIronyPattern = /\b(increased?|expanded?|doubled?|added\s+more|ordered\s+more|boosted?).{0,60}(order|orders|fleet).{0,60}(before|even\s+before|despite|without).{0,60}(enter|service|delivery|delivered|flies?|flying|passengers?)\b/i;
  const preServiceOrderPattern = /\b(before.{0,30}(enters?\s+service|first\s+delivery|even\s+enters|even\s+flies?|first\s+passenger)|increased?.{0,40}order.{0,40}before)\b/i;
  if (fleetOrderIronyPattern.test(fullText) || preServiceOrderPattern.test(fullText)) {
    score += 20;
    triggers.push("Fleet order irony — ordered more before first delivery/service");
  }

  // ── Bonus: Debt-free / ownership milestone ("owns 620 737s debt-free") ──────────────
  const ownershipMilestonePattern = /\b(debt.?free|owns\s+\d+|owns\s+over|owns\s+more\s+than|fleet\s+of\s+\d+|\d+\s+(aircraft|planes|jets|737s|a320s|airbus|boeing)\s+(debt.?free|outright|fully\s+owned))\b/i;
  if (ownershipMilestonePattern.test(fullText)) {
    score += 20;
    triggers.push("Ownership milestone — debt-free fleet or large ownership number");
  }

  const HISTORIC_ROUTE_SIGNALS = [
    "world's longest", "world's first", "longest flight", "longest nonstop",
    "first transatlantic", "first nonstop", "first direct", "first ever",
    "nonstop from", "nonstop to", "direct from", "direct to",
    "returns to", "brings back", "revives", "resumes",
    "dreamliner", "787", "a380", "747", "a350",
    // Big-name airlines to exotic/unusual destinations = notable
    "dubai", "tahiti", "north pole", "antarctica",
    "emirates", "qatar airways", "singapore airlines", "etihad",
    "overnight", "transatlantic", "transpacific", "ultra-long",
    // Plain 'nonstop' counts as a signal — 'nonstop Emirates flights' should qualify
    "nonstop",
  ];
  const historicRouteMatches = getMatchedKeywords(fullText, HISTORIC_ROUTE_SIGNALS);
  // Broad route launch detection: catches all patterns including 'launches new overnight flights',
  // 'could soon get nonstop', 'teases first transatlantic', 'brings back', 'returns on', etc.
  const isRouteLaunch = /\b(launch(?:es)?|debut(?:s)?|add(?:s)?|start(?:s)?|begin(?:s)?|open(?:s)?|introduce(?:s)?|unveil(?:s)?|tease(?:s)?|announce(?:s)?|confirm(?:s)?|reveal(?:s)?).{0,80}(route|flights?|service|nonstop|direct|transatlantic|transpacific)\b/i.test(fullText)
    || /\b(returns?|brings?\s+back|revives?|resumes?).{0,40}(route|flight|service|on\s+the)\b/i.test(fullText)
    || /\b(nonstop|direct).{0,40}(from|to|between|flights?|service)\b/i.test(fullText)
    || /\b(could\s+soon|will\s+soon|set\s+to).{0,40}(get|receive|have|launch|start).{0,40}(flight|route|nonstop|direct)\b/i.test(fullText)
    || /\b(world.?s\s+longest|first\s+transatlantic|first\s+nonstop|first\s+direct)\b/i.test(fullText);

  if (isRouteLaunch && historicRouteMatches.length >= 3) {
    score += 36;
    triggers.push(`Historic/unusual route launch: ${historicRouteMatches.slice(0, 2).join(", ")}`);
  } else if (isRouteLaunch && historicRouteMatches.length >= 2) {
    score += 22;
    triggers.push(`Notable route launch: ${historicRouteMatches.slice(0, 2).join(", ")}`);
  } else if (isRouteLaunch && historicRouteMatches.length >= 1) {
    score += 16;
    triggers.push(`Route launch with notable element: ${historicRouteMatches[0]}`);
  }

  // Extra milestone bonus: 'first transatlantic', 'world's longest', 'first nonstop' in title
  // These are genuine aviation milestones that always get traction regardless of other signals
  const hasMilestoneInTitle = /\b(first\s+transatlantic|first\s+transpacific|world.?s\s+longest|first\s+nonstop\s+to|first\s+direct\s+to)\b/i.test(title);
  if (hasMilestoneInTitle) {
    score += 14;
    triggers.push("Aviation milestone in headline — first/longest route");
  }

  const weakMatches = getMatchedKeywords(fullText, WEAK_STORY_KEYWORDS);
  const hasStrongTrigger = triggers.some(t =>
    t.includes("Boeing") || t.includes("death") || t.includes("fatal") ||
    t.includes("outrage") || t.includes("pay") || t.includes("weird") ||
    t.includes("celebrity") || t.includes("money") || t.includes("safety") ||
    t.includes("NTSB") || t.includes("FAA") || t.includes("lawsuit") ||
    t.includes("nostalgia") || t.includes("Nostalgia") || t.includes("route launch") ||
    t.includes("M&A") || t.includes("takeover") || t.includes("acquisition")
  );

  if (weakMatches.length >= 2 && !hasStrongTrigger) {
    score -= 25;
    triggers.push("Routine route/schedule/corporate story — penalised");
  } else if (weakMatches.length >= 1 && !hasStrongTrigger && triggers.length <= 1) {
    score -= 12;
    triggers.push("Weak story type — limited viral potential");
  }

  // ── Cap ───────────────────────────────────────────────────────────────────
  score = Math.min(90, Math.max(0, score)); // Rule cap: 90 — LLM/learning lifts to 95, editor-only reaches 96-100

  // ── Status label ──────────────────────────────────────────────────────────
  // Thresholds: must_post raised to 88 so it requires 2+ strong signals.
  // A single weird/outrage story alone should be strong_candidate, not must_post.
  const statusLabel: StatusLabel = labelFromScore(score);

  // ── Primary category ──────────────────────────────────────────────────────
  let category = "General Aviation";

  if (boeingSafetyMatches.length >= 1 && (fatalMatches.length >= 1 || authorityMatches.length >= 1)) {
    category = "Boeing Safety Crisis";
  } else if (boeingRivalryMatches.length >= 1) {
    category = "Boeing vs Airbus";
  } else if (hasDeathCount || (fatalMatches.length >= 2 && authorityMatches.length >= 1)) {
    category = "Safety Failure & Accountability";
  } else if (weirdMatches.length >= 1) {
    category = "Weird Human Moments";
  } else if (celebMatches.length >= 1) {
    category = "Celebrity Involvement";
  } else if (outrageMatches.length >= 1 || policyMatches.length >= 1) {
    category = "Passenger Outrage";
  } else if (pilotPayMatches.length >= 1 && hasExactMoney) {
    category = "Pilot & Crew Pay";
  } else if (hasExactMoney && moneyMatches.length >= 2) {
    category = "Money Shock";
  } else if (mysteryMatches.length >= 1) {
    category = "Mystery & Tragedy";
  } else if (authorityMatches.length >= 1 || safetyMatches.length >= 2) {
    category = "Safety & Accountability";
  } else if (superlativeMatches.length >= 1) {
    category = "First / Last / Only / Biggest";
  } else if (nostalgiaMatches.length >= 2) {
    category = "Nostalgia & Finality";
  } else if (airlineMaMatches.length >= 1) {
    category = "Airline Takeover & M&A";
  } else if (pilotPayMatches.length >= 1) {
    category = "Pilot & Crew Pay";
  }

  const viralReason =
    triggers.length > 0
      ? triggers.join(". ")
      : "No strong viral triggers detected.";

  // ── Human-readable explanation (shown on story cards) ─────────────────────
  const topTriggers = triggers.slice(0, 2);
  let viralExplanation: string;
  if (score >= 88) {
    viralExplanation = topTriggers.length >= 2
      ? `Scores high: ${topTriggers[0].toLowerCase()}. Also: ${topTriggers[1].toLowerCase()}.`
      : topTriggers.length === 1
      ? `Scores high: ${topTriggers[0].toLowerCase()}.`
      : "Multiple strong viral signals detected.";
  } else if (score >= 70) {
    viralExplanation = topTriggers.length >= 1
      ? `Strong candidate: ${topTriggers[0].toLowerCase()}${topTriggers[1] ? `. Also: ${topTriggers[1].toLowerCase()}` : ""}.`
      : "Good viral potential but no single dominant signal.";
  } else if (score >= 55) {
    viralExplanation = topTriggers.length >= 1
      ? `Possible post: ${topTriggers[0].toLowerCase()}. Lacks a second strong signal to push it higher.`
      : "Some aviation interest but limited viral hooks.";
  } else {
    viralExplanation = topTriggers.length >= 1
      ? `Low score: ${topTriggers[0].toLowerCase()}, but not enough to drive significant engagement.`
      : "No strong viral triggers — routine aviation news.";
  }

  return { score, statusLabel, category, viralReason, triggers, viralExplanation };
}

export function getStatusConfig(label: StatusLabel) {
  switch (label) {
    case "must_post":
      return { label: "Must Post", color: "emerald", range: "88–100" };
    case "strong_candidate":
      return { label: "Strong Candidate", color: "blue", range: "70–84" };
    case "maybe":
      return { label: "Maybe", color: "amber", range: "55–69" };
    case "reject":
      return { label: "Reject", color: "red", range: "Below 55" };
  }
}


/**
 * Calculates a blended score using the AI viral score, the editor's override,
 * and category performance history.
 * 
 * Weights:
 * - If no performance history: 100% override (or AI score if no override)
 * - If rich performance history: 60% override/AI, 40% historical performance
 */
export async function getBlendedScore(
  viralScore: number, 
  overrideScore: number | null, 
  category: string | null
): Promise<number> {
  const baseScore = overrideScore !== null ? overrideScore : viralScore;
  
  if (!category) return baseScore;

  try {
    const { getScoringConfig } = await import("./db");
    const catRaw = await getScoringConfig("stat_perf_top_categories");
    if (!catRaw) return baseScore;

    const cats: Array<{ category: string; avgEngagement: number; count?: number }> = JSON.parse(catRaw);
    const avgEng = parseInt(await getScoringConfig("stat_perf_avg_engagement") ?? "0", 10);
    
    if (avgEng === 0 || cats.length === 0) return baseScore;

    // Find the category
    const catData = cats.find(c => c.category.toLowerCase() === category.toLowerCase());
    if (!catData) return baseScore; // Category not found in history
    if ((catData.count ?? 0) < 3) return baseScore; // Need at least 3 posts for confidence

    // Calculate historical performance score (0-100)
    // If avg engagement is exactly average, score is 75.
    // If 2x average, score is 100. If 0.5x average, score is 50.
    const ratio = catData.avgEngagement / avgEng;
    let histScore = 75 + ((ratio - 1) * 25);
    histScore = Math.max(0, Math.min(95, histScore)); // Historical blend cap: 95

    // Blend: 60% base score, 40% historical performance
    const blended = (baseScore * 0.6) + (histScore * 0.4);
    return Math.round(blended);
  } catch (err) {
    return baseScore;
  }
}
