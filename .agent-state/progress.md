# Progress: Auto-retry Failed Runs (FAU-18)

## Status: Complete

All 10 features implemented and committed.

## What was accomplished

1. **Database**: Added `retry_attempt` column migration to `db.ts`, updated `insertRun` prepared statement to include the new field
2. **Types**: Added `retry_attempt: number` to `Run` interface in `types.ts`
3. **Config**: Added `maxRunRetries` (default 3) and `runRetryDelayMs` (default 30s) to `config.ts`
4. **Core logic** (`runner.ts`):
   - Added `enqueueRetry()` function that creates a new queued run with incremented `retry_attempt`
   - Replaced `executeRun` catch block with retry-aware logic:
     - Non-fix runs: schedule retry via `setTimeout` if attempts remain, else mark Linear "Failed"
     - Fix runs: unchanged (use existing `fix_tracking` system)
     - Linear status stays "In Progress" during retries
   - Added `retry_attempt: 0` to all run creation sites: initial runs, `enqueueRevision`, `enqueueFix`
5. **Server**: Manual retry endpoint resets `retry_attempt: 0`; `/health` exposes `maxRunRetries` and `maxFixRetries`
6. **Dashboard**: `runTypeBadge()` shows "Retry N/M" in yellow for retry runs; `fetchConfig()` loads retry limits from `/health` at init

## What's left to do

Nothing — all features from the design doc are implemented.

## Decisions made

- Used `setTimeout` for retry delay (matches design doc — no exponential backoff)
- The `documentRun` call in the design doc's catch block was omitted because no such function exists in the codebase
- `.agent-state/` is in `.gitignore`, so it needs `git add -f` to track

## Tests

- All 17 existing tests pass
- TypeScript errors are all pre-existing (Bun types not recognized by vanilla `tsc`)
