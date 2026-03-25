# Progress: FAU-55 — Project Intelligence Profiles

## Accomplished

All features implemented and tested in a single session:

1. **project-intelligence.ts** — New module with:
   - SQLite `project_intelligence` table (project+metric composite PK)
   - `computeRunStats()` — avg duration, avg sessions, success rate from last 90 days
   - `getCommonFailures()` — deduplicated failure patterns from last 30 days
   - `extractInsights()` — Gemini Flash 2 qualitative analysis with 6-hour staleness cache
   - `upsertMetric()`/`getMetric()`/`getMetricAge()` — persistence layer
   - `updateProjectIntelligence()` — public API called after each run
   - `buildIntelligenceSection()` — formats metrics for prompt injection (requires 3+ runs)

2. **runner.ts integration**:
   - Added `projectKey` to `buildAgentPrompt` opts
   - Intelligence section injected on first session only (after codebase summary)
   - `updateProjectIntelligence()` called fire-and-forget after both success and failure

3. **Tests** (7 passing):
   - Null return with no/insufficient data
   - Stats computation from run history
   - Common failure pattern extraction
   - Duration formatting
   - Fix runs excluded from stats
   - Metric persistence roundtrip

## What's Left

Nothing — all 8 features complete. Full test suite (200 tests) passes, type-check clean.

## Decisions

- Added `projectKey` to `buildAgentPrompt` opts rather than requiring it as a separate param (backwards compatible)
- Intelligence only injected on first session to avoid token waste on continuations
- Minimum 3 runs required before showing intelligence (avoid misleading data)
- Fix runs excluded from all metrics (they'd skew duration/success stats)
