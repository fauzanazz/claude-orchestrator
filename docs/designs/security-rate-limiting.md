# Security: Rate Limiting & Queue Caps

## Context

Security audit finding HIGH-3. `POST /api/runs/:id/retry` creates new runs with no rate limiting, no per-run retry cap, and no global queue size limit. Any local process can spam retries, causing resource exhaustion and API cost explosion.

## Requirements

- Cap the total queue size (reject new runs when queue exceeds threshold)
- Limit retries per original run ID (max N retries of the same failed run)
- Add a cooldown period between retries of the same run
- Return appropriate HTTP error codes when limits are hit (429 Too Many Requests)
- Make limits configurable via environment variables

## Implementation

### 1. Add config values in `orchestrator/src/config.ts`

Add after line 43 (after `port`):

```typescript
maxQueueSize: parseIntEnv('MAX_QUEUE_SIZE', 20),
maxRetriesPerRun: parseIntEnv('MAX_RETRIES_PER_RUN', 3),
retryCooldownMs: parseIntEnv('RETRY_COOLDOWN_MS', 60000), // 1 minute
```

### 2. Add retry tracking query in `orchestrator/src/db.ts`

Add a new prepared statement and function after the existing `getRunByPRNumber` function (after line 420):

```typescript
const stmtCountRetriesForIssue = db.prepare<{ count: number }, [string]>(`
  SELECT COUNT(*) as count FROM runs
  WHERE issue_id = ? AND status = 'queued'
`);

const stmtLatestRetryTime = db.prepare<{ created_at: string } | null, [string, string]>(`
  SELECT created_at FROM runs
  WHERE issue_id = ? AND id != ?
  ORDER BY created_at DESC LIMIT 1
`);

export function countQueuedForIssue(issueId: string): number {
  return stmtCountRetriesForIssue.get(issueId)?.count ?? 0;
}

export function getLatestRunTimeForIssue(issueId: string, excludeRunId: string): string | null {
  return stmtLatestRetryTime.get(issueId, excludeRunId)?.created_at ?? null;
}

export function countTotalQueued(): number {
  return db.prepare<{ count: number }, []>(
    `SELECT COUNT(*) as count FROM runs WHERE status = 'queued'`
  ).get()?.count ?? 0;
}
```

### 3. Add validation in the retry endpoint in `orchestrator/src/server.ts`

Import the new DB functions at the top of server.ts (update the existing import from `./db.ts`):

```typescript
import {
  db, listRuns, getLogsForRun, getRun, getRunByBranch, insertRun,
  isReviewProcessed, markReviewProcessed,
  countQueuedForIssue, getLatestRunTimeForIssue, countTotalQueued,
} from './db.ts';
```

In the `POST /api/runs/:id/retry` handler (after the `status !== 'failed'` check around line 162), add three guards:

```typescript
const totalQueued = countTotalQueued();
if (totalQueued >= config.maxQueueSize) {
  return c.json(
    { error: `Queue full (${totalQueued}/${config.maxQueueSize}). Wait for runs to complete.` },
    429,
  );
}

const queuedForIssue = countQueuedForIssue(original.issue_id);
if (queuedForIssue >= config.maxRetriesPerRun) {
  return c.json(
    { error: `Too many queued retries for this issue (${queuedForIssue}/${config.maxRetriesPerRun})` },
    429,
  );
}

const latestTime = getLatestRunTimeForIssue(original.issue_id, original.id);
if (latestTime) {
  const elapsed = Date.now() - new Date(latestTime + 'Z').getTime();
  if (elapsed < config.retryCooldownMs) {
    const waitSec = Math.ceil((config.retryCooldownMs - elapsed) / 1000);
    return c.json(
      { error: `Retry cooldown: wait ${waitSec}s before retrying this run` },
      429,
    );
  }
}
```

### 4. Add queue size check in `orchestrator/src/runner.ts`

In the `enqueue()` function (line 807), add a size check:

```typescript
export function enqueue(run: Run): boolean {
  if (queue.length >= config.maxQueueSize) {
    console.warn(`[runner] Queue full (${queue.length}/${config.maxQueueSize}), rejecting run ${run.id}`);
    updateRunStatus(run.id, 'failed', {
      error_summary: 'Queue full — run rejected',
      completed_at: new Date().toISOString(),
    });
    return false;
  }
  queue.push(run);
  return true;
}
```

Update all callers of `enqueue()` and `enqueueWithIssue()` to handle the `false` return (or make `enqueueWithIssue` also return boolean).

```typescript
export function enqueueWithIssue(run: Run, issue: Issue): boolean {
  issueMap.set(run.id, issue);
  const ok = enqueue(run);
  if (!ok) {
    issueMap.delete(run.id);
  }
  return ok;
}
```

### 5. Update `.env.example`

Add after the `PORT` line:

```env
# Queue limits
# MAX_QUEUE_SIZE=20
# MAX_RETRIES_PER_RUN=3
# RETRY_COOLDOWN_MS=60000
```

## Testing Strategy

- **Unit tests** in `orchestrator/src/server.test.ts` (or new `orchestrator/src/rate-limit.test.ts`):
  - Call retry endpoint when queue is at max → 429 response with message
  - Call retry endpoint twice rapidly → second call gets 429 cooldown
  - Call retry N+1 times for same issue → gets 429 per-issue cap
  - Call retry for different issues → each gets its own limit (not shared)

- **DB function tests**:
  - `countTotalQueued()` returns correct count after inserting queued runs
  - `countQueuedForIssue(id)` returns count scoped to specific issue
  - `getLatestRunTimeForIssue(id, excludeId)` returns the most recent run time

- Run `bunx tsc --noEmit` to verify type correctness.

## Out of Scope

- Rate limiting on other endpoints (GET /api/runs, SSE) — covered in security-network-auth
- Per-IP rate limiting — not needed for localhost
- Webhook replay protection (already handled by review deduplication)
