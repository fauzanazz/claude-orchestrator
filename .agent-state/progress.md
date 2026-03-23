# Progress: Security Database Log Retention & Cleanup (FAU-26)

## Status: Complete

All 10 features implemented, tested, and committed.

## What was accomplished

1. **Config** (`config.ts`): Added `logRetentionDays` (default 30), `runRetentionDays` (default 90), `cleanupIntervalMs` (default 24h) using existing `parseIntEnv` pattern
2. **Cleanup functions** (`db.ts`):
   - `deleteOldLogs(retentionDays)` — deletes logs older than N days
   - `deleteOldRuns(retentionDays)` — deletes completed (success/failed) runs older than N days, with cascading log deletion; never touches running/queued runs
   - `deleteOldProcessedReviews(retentionDays)` — cleans old review dedup records
   - `deleteOldNotifiedPRs(retentionDays)` — cleans old notification dedup records
   - `vacuumDatabase()` — reclaims disk space after deletions
   - `getDatabaseSize()` — reports current DB size via pragma queries
3. **Scheduler** (`runner.ts`): Added `runCleanup()` function integrated into `startRunner()` via `setInterval` (configurable) with initial 30s delayed first run; logs deletion counts and space savings
4. **Env** (`.env.example`): Added commented-out retention config vars
5. **Tests** (`db.test.ts`): 11 unit tests covering all cleanup functions — old data deleted, recent data preserved, running/queued runs never deleted, cascading log deletion verified, getDatabaseSize returns positive

## What's left to do

Nothing — all features from the design doc are implemented.

## Decisions made

- Used raw SQL inserts in tests (via `db.prepare`) for flexibility in setting arbitrary `created_at`/`completed_at` timestamps, rather than `insertRun` which uses SQLite defaults
- Cleanup runs synchronously (not async) since all operations are local SQLite queries
- 4 pre-existing failures in `rate-limit.test.ts` are unrelated to this change

## Tests

- All 11 new tests pass (`bun test src/db.test.ts`)
- 74/78 total tests pass; 4 failures are pre-existing in `rate-limit.test.ts`
- TypeScript errors are all pre-existing (Bun types not recognized by vanilla `tsc`)
