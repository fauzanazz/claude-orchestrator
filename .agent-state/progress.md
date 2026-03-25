# Token Cost Tracking — Progress

## Completed

All features from the design document have been implemented:

1. **TokenTracker module** (`orchestrator/src/token-tracker.ts`) — Parses stream-json result events, accumulates tokens across sessions, estimates cost using per-model pricing table.

2. **DB schema migration** — Added 5 columns to `runs` table: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`. Uses ALTER TABLE with catch for idempotent migration.

3. **DB functions** — `updateRunTokens()` persists token data per run. `getCostSummary(days)` returns aggregate stats with per-project breakdown.

4. **Type updates** — `Run` interface in `types.ts` includes all 5 token fields. All `insertRun` call sites updated (runner.ts x5, server.ts x1, db.test.ts x3).

5. **Runner integration** — `streamOutput` accepts optional `onRawLine` callback. `TokenTracker` is created per `executeRun`, fed raw lines from stdout, and records totals on success and failure paths. Model is set from project config.

6. **Cost API** — `GET /api/cost?days=30` returns aggregate cost summary. Token fields also appear automatically in `/api/runs` responses.

7. **Tests** — 12 unit tests for TokenTracker covering parsing, accumulation, cost estimation (sonnet/opus/unknown/cache), edge cases (invalid JSON, missing usage, missing fields).

## Test Results

- All 205 tests pass (including 12 new token-tracker tests)
- No new type errors introduced (all tsc errors are pre-existing bun/node type issues)

## Decisions

- Token recording happens in the success path (before `hasLocalCommits`) and also in the catch block (for failed runs that consumed tokens)
- Used `onRawLine` callback pattern on `streamOutput` rather than post-hoc log parsing — cleaner and doesn't require storing raw JSON
- Cost is rounded to 4 decimal places
- Default pricing uses Sonnet-level rates for unknown models
