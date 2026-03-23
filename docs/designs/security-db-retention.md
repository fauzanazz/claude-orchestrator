# Security: Database Log Retention & Cleanup

## Context

Security audit finding LOW-4. Logs and runs accumulate in the SQLite database indefinitely. No TTL, cleanup, or vacuuming. Over months, the database grows unboundedly — slow queries, disk exhaustion, and bloated backups.

## Requirements

- Periodically delete logs older than a configurable retention period
- Optionally archive or delete completed runs beyond retention
- Run SQLite `VACUUM` periodically to reclaim space
- All thresholds configurable via environment variables
- Cleanup runs in the background without blocking the main loop

## Implementation

### 1. Add config values in `orchestrator/src/config.ts`

Add after existing config entries (around line 44):

```typescript
logRetentionDays: parseIntEnv('LOG_RETENTION_DAYS', 30),
runRetentionDays: parseIntEnv('RUN_RETENTION_DAYS', 90),
cleanupIntervalMs: parseIntEnv('CLEANUP_INTERVAL_MS', 86400000), // 24 hours
```

### 2. Add cleanup functions in `orchestrator/src/db.ts`

Add after the existing `clearFixTracking` function (after line 397):

```typescript

export function deleteOldLogs(retentionDays: number): number {
  const result = db.prepare(`
    DELETE FROM logs
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function deleteOldRuns(retentionDays: number): number {
  db.prepare(`
    DELETE FROM logs WHERE run_id IN (
      SELECT id FROM runs
      WHERE status IN ('success', 'failed')
        AND completed_at < datetime('now', '-' || ? || ' days')
    )
  `).run(retentionDays);

  const result = db.prepare(`
    DELETE FROM runs
    WHERE status IN ('success', 'failed')
      AND completed_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function deleteOldProcessedReviews(retentionDays: number): number {
  const result = db.prepare(`
    DELETE FROM processed_reviews
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function deleteOldNotifiedPRs(retentionDays: number): number {
  const result = db.prepare(`
    DELETE FROM notified_prs
    WHERE notified_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function vacuumDatabase(): void {
  db.run('VACUUM');
}

export function getDatabaseSize(): number {
  const stat = db.prepare<{ page_count: number; page_size: number }, []>(
    `SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()`
  ).get();
  if (!stat) return 0;
  return stat.page_count * stat.page_size;
}
```

**Note**: The `result.changes` property works with bun:sqlite — it returns the number of rows affected by the last statement.

### 3. Add cleanup scheduler in `orchestrator/src/runner.ts`

Add a new function and integrate it with the main loop. Add after the `startRunner` function:

```typescript
import {
  deleteOldLogs,
  deleteOldRuns,
  deleteOldProcessedReviews,
  deleteOldNotifiedPRs,
  vacuumDatabase,
  getDatabaseSize,
} from './db.ts';

async function runCleanup(): Promise<void> {
  try {
    const sizeBefore = getDatabaseSize();

    const logsDeleted = deleteOldLogs(config.logRetentionDays);
    const runsDeleted = deleteOldRuns(config.runRetentionDays);
    const reviewsDeleted = deleteOldProcessedReviews(config.runRetentionDays);
    const notificationsDeleted = deleteOldNotifiedPRs(config.runRetentionDays);

    if (logsDeleted + runsDeleted > 0) {
      vacuumDatabase();
    }

    const sizeAfter = getDatabaseSize();
    const savedKB = Math.round((sizeBefore - sizeAfter) / 1024);

    console.log(
      `[cleanup] Deleted ${logsDeleted} logs, ${runsDeleted} runs, ` +
      `${reviewsDeleted} reviews, ${notificationsDeleted} notifications. ` +
      `DB size: ${Math.round(sizeAfter / 1024)}KB (freed ${savedKB}KB)`
    );
  } catch (err) {
    console.error('[cleanup] Error during cleanup:', err);
  }
}
```

In `startRunner()`, add the cleanup interval after the existing intervals:

```typescript
setInterval(runCleanup, config.cleanupIntervalMs);

setTimeout(runCleanup, 30_000);
```

### 4. Update `.env.example`

Add:

```env
# Database retention
# LOG_RETENTION_DAYS=30
# RUN_RETENTION_DAYS=90
# CLEANUP_INTERVAL_MS=86400000
```

## Testing Strategy

- **Unit tests** in `orchestrator/src/db.test.ts`:
  - Insert runs with `completed_at` set to 60 days ago. Call `deleteOldRuns(30)` → runs deleted
  - Insert runs with `completed_at` set to 10 days ago. Call `deleteOldRuns(30)` → runs NOT deleted
  - Insert logs with `created_at` 60 days ago. Call `deleteOldLogs(30)` → logs deleted
  - Verify running/queued runs are NEVER deleted regardless of age
  - Verify `deleteOldRuns` also deletes associated logs (via the cascading delete query)
  - `getDatabaseSize()` returns a positive number

- Run `bunx tsc --noEmit` to verify type correctness.

## Out of Scope

- Exporting/archiving old runs to files before deletion
- Database backup automation
- Admin UI for manually triggering cleanup
- Per-project retention policies
