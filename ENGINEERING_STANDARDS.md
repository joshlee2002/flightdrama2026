# FlightDrama2026 — Engineering Standards

> These rules apply to **every change** made to this codebase, by any engineer or AI agent.
> No exceptions. Read this before touching any file.

---

## Core Rules

1. **NEVER replace working systems.**
   If something works, improve it — do not rewrite it.

2. **ALWAYS inspect the existing implementation before making changes.**
   Read the relevant files first. Never assume what the code does.

3. **NEVER create duplicate logic.**
   If a function already does something similar, extend or refactor it.

4. **If a function already exists, improve it instead of creating a new one.**
   New modules and new files require explicit justification.

5. **Before every change, explain:**
   - What currently happens
   - Why it happens
   - Whether it is actually a bug or simply expected behaviour
   - The safest fix

6. **Preserve backwards compatibility.**
   Changes must not break existing data, existing API contracts, or existing UI behaviour.

7. **Prefer refactoring over rewriting.**
   A targeted edit to an existing function is always preferred over extracting a new module.

8. **If a proposed change could affect rankings, duplicates, or learning, explain the risk before changing anything.**
   These three systems are interconnected. A change to one can silently break another.

---

## Required Analysis Format

For every non-trivial change, produce this analysis **before writing any code**:

```
CURRENT BEHAVIOUR
  What does the code do right now?

ROOT CAUSE
  Why does it behave this way? (design decision, bug, stale code, etc.)

IMPACT
  What breaks or degrades if this is left unfixed?
  What is the risk of fixing it?

BEST FIX
  The safest, most targeted change that resolves the issue.
  Prefer a 5-line edit over a 50-line rewrite.

FILES TO CHANGE
  List every file that will be modified. If more than 3 files need changing,
  reconsider whether the approach is too broad.

EXPECTED SIDE EFFECTS
  What else might change as a result? Rankings? Dedup? Learning? DB state?

TESTS TO RUN
  What should be manually verified after the change is deployed?
```

Only after this analysis is written should any code be modified.

---

## Database Safety Rules

These rules apply specifically to any script or migration that touches production data.

1. **All data-modifying scripts must have a dry-run mode.**
   The dry-run must print exactly what would be changed before anything is written.
   The dry-run output must be reviewed and confirmed before the real run executes.

2. **Retroactive cleanup scripts must show a sample of affected records.**
   Before marking, deleting, or updating rows in bulk, print at least 20 examples
   of what will be affected so false positives can be caught.

3. **Never run a destructive migration without a rollback path.**
   Every bulk update must be reversible. Document the rollback SQL before running.

4. **Schema migrations must be additive where possible.**
   Add new columns rather than modifying existing ones.
   Never rename or drop a column without a deprecation period.

---

## Specific System Rules

### Deduplication
- The dedup pipeline has 6 layers (URL → content hash → event fingerprint → title similarity → LLM → within-batch).
- Changes to any layer must be tested against known duplicate pairs before deployment.
- The event fingerprint requires **3 or more specific fields** to match before grouping stories.
  Do not lower this threshold — it causes false positives.
- Never run a retroactive dedup without dry-run review first.

### Scoring & Labels
- `labelFromScore()` in `shared/const.ts` is the **single source of truth** for score → bucket mapping.
- Do not add inline ternaries for label derivation anywhere in the codebase.
- AI scores are hard-capped at 95. Only manual editor override can set 96–100.
- Rule-based scorer caps at 90. Stat adjustment caps at 95.

### Learning System
- Every override (approve, reject, dismiss, score override) must call `clearStatAdjustCache()` immediately.
- The stat rerank after an override must be synchronous and fast (no LLM calls).
- LLM deep learning only runs on a schedule — never inline during a user action.

### Cost Control
- `buildImageQueries` and `classifyStoryType` use the 8B model. Do not upgrade them to 70B.
- Deep research results are cached for 6 hours per URL. Do not remove this cache.
- The LLM learner is capped at 50 examples. The stat learner handles the full history for free.
- Pipeline context (feedback/voice/style/perf) is cached for 5 minutes per run.
- Editor rewrite threshold is 6/10. Do not lower it below 6.

---

## What Good Looks Like

A good change in this codebase:
- Touches 1–3 files
- Has a clear, single purpose
- Does not change any behaviour that was already working
- Includes a one-line comment explaining *why* the change was made
- Can be described in a single sentence in the commit message

A bad change:
- Rewrites a working module "for clarity"
- Creates a new abstraction layer without a concrete problem to solve
- Changes scoring, dedup, or learning without a written risk assessment
- Runs against production data without a dry-run

---

*Last updated: 2026-06-27*
