export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

// ── Scoring labels ──────────────────────────────────────────────────────────
// Single source of truth for score → bucket label mapping.
// Used in: ingest, rerank, override save, dashboard grouping.
// Never let the LLM, frontend, or a stale DB label decide the bucket.
export type StatusLabel = "must_post" | "strong_candidate" | "maybe" | "reject";

export function labelFromScore(score: number): StatusLabel {
  if (score >= 88) return "must_post";
  if (score >= 70) return "strong_candidate";
  if (score >= 55) return "maybe";
  return "reject";
}

export function effectiveScore(story: { viralScore: number; overrideScore?: number | null }): number {
  return story.overrideScore ?? story.viralScore;
}

export function effectiveLabel(story: {
  viralScore: number;
  overrideScore?: number | null;
  overrideLabel?: string | null;
}): StatusLabel {
  // Manual override label always wins — editor has final say
  if (story.overrideLabel) return story.overrideLabel as StatusLabel;
  // Otherwise derive from the effective score — never trust the stored statusLabel
  return labelFromScore(effectiveScore(story));
}
// ────────────────────────────────────────────────────────────────────────────
