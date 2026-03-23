# Auto-retry Failed Runs (up to 3 attempts)

## Context

When a run fails (agent crash, transient git error, timeout, etc.), the orchestrator marks it as "Failed" with no recovery path except manual retry via the dashboard button. All 5 recent issues (FAU-9 through FAU-13) failed on first attempt with no automatic retry.

Fix runs already have retry logic via `fix_tracking`, but initial runs and revision runs have zero auto-retry. This design adds automatic retry for all non-fix runs, up to a configurable max (default 3) with a delay between attempts.

## Requirements

- Failed non-fix runs are automatically retried up to `MAX_RUN_RETRIES` times (default 3)
- Each retry creates a new run record with an incremented `retry_attempt` counter
- A configurable delay (`RUN_RETRY_DELAY_MS`, default 30000) between failure and retry enqueue
- After all retries exhausted: mark Linear status as "Failed", comment on issue (current behavior)
- Linear status stays "In Progress" during retries — only set to "Failed" when retries are exhausted
- Dashboard shows retry attempt info (e.g. "Retry 2/3") in the Type column
- Fix runs are excluded — they have their own retry system via `fix_tracking`

## Implementation

### 1. Add `retry_attempt` column to runs table

**File:** `orchestrator/src/db.ts`

Add migration after the existing `fix_attempt` migration (~line 76):

```typescript
try { db.run('ALTER TABLE runs ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0'); } catch {}
```

### 2. Update `Run` type

**File:** `orchestrator/src/types.ts`

Add `retry_attempt` to the `Run` interface:

```typescript
export interface Run {
  id: string;
  project: string;
  issue_id: string;
  issue_key: string;
  issue_title: string;
  branch: string;
  worktree_path: string;
  status: RunStatus;
  is_revision: number;
  is_fix: number;
  fix_type: string | null;
  fix_attempt: number;
  retry_attempt: number;           // <-- ADD THIS
  pr_number: number | null;
  agent_pid: number | null;
  iterations: number;
  error_summary: string | null;
  pr_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  design_path?: string | null;
  issue_repo?: string | null;
  base_branch?: string | null;
}
```

### 3. Update `insertRun` prepared statement

**File:** `orchestrator/src/db.ts`

Update the `stmtInsertRun` prepared statement to include `retry_attempt`. Change the type parameter list and SQL:

```typescript
const stmtInsertRun = db.prepare<void, [
  string, string, string, string, string, string, string, string, number, number, string | null, number, number, number | null, string | null, string | null, string | null
]>(`
  INSERT OR IGNORE INTO runs
    (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, is_fix, fix_type, fix_attempt, retry_attempt, pr_number, design_path, issue_repo, base_branch)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
```

Update the `insertRun` function to pass `retry_attempt`:

```typescript
export function insertRun(
  run: Omit<Run, 'created_at' | 'started_at' | 'completed_at'>
): void {
  stmtInsertRun.run(
    run.id,
    run.project,
    run.issue_id,
    run.issue_key,
    run.issue_title,
    run.branch,
    run.worktree_path,
    run.status,
    run.is_revision,
    run.is_fix,
    run.fix_type ?? null,
    run.fix_attempt,
    run.retry_attempt,
    run.pr_number ?? null,
    run.design_path ?? null,
    run.issue_repo ?? null,
    run.base_branch ?? null,
  );
}
```

### 4. Add config for retry settings

**File:** `orchestrator/src/config.ts`

Add two new config values after `maxFixRetries`:

```typescript
maxRunRetries: parseIntEnv('MAX_RUN_RETRIES', 3),
runRetryDelayMs: parseIntEnv('RUN_RETRY_DELAY_MS', 30000),
```

### 5. Add `enqueueRetry` function

**File:** `orchestrator/src/runner.ts`

Add after the existing `enqueueFix` function (~line 893):

```typescript
function enqueueRetry(
  failedRun: Run,
  issue: Issue,
): string | null {
  if (failedRun.is_fix) return null;

  const nextAttempt = (failedRun.retry_attempt ?? 0) + 1;
  if (nextAttempt > config.maxRunRetries) return null;

  const newRun: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
    id: ulid(),
    project: failedRun.project,
    issue_id: failedRun.issue_id,
    issue_key: failedRun.issue_key,
    issue_title: failedRun.issue_title,
    branch: failedRun.branch,
    worktree_path: failedRun.worktree_path,
    status: 'queued',
    is_revision: failedRun.is_revision,
    is_fix: 0,
    fix_type: null,
    fix_attempt: 0,
    retry_attempt: nextAttempt,
    pr_number: failedRun.pr_number,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    design_path: failedRun.design_path ?? null,
    issue_repo: failedRun.issue_repo ?? null,
    base_branch: failedRun.base_branch ?? null,
  };

  insertRun(newRun);

  const fullRun = getRun(newRun.id);
  if (!fullRun) return null;

  enqueueWithIssue(fullRun, issue);
  broadcastSSE({ type: 'run_update', run: fullRun });

  return newRun.id;
}
```

### 6. Update `executeRun` catch block — auto-retry on failure

**File:** `orchestrator/src/runner.ts`

Replace the catch block (lines 744–766) with retry-aware logic:

```typescript
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    bufferLog(runId, 'system', `[runner] Run ${runId} failed: ${errorMessage}`);
    updateRunStatus(runId, 'failed', {
      error_summary: errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    });

    const failedRun = getRun(runId);
    if (failedRun) broadcastSSE({ type: 'run_update', run: failedRun });

    if (worktreePath && failedRun) {
      await documentRun(failedRun, issue, worktreePath).catch((e) =>
        console.warn(`[runner] Memory documentation failed: ${e instanceof Error ? e.message : e}`),
      );
    }

    if (!run.is_fix) {
      const nextAttempt = (run.retry_attempt ?? 0) + 1;
      if (nextAttempt <= config.maxRunRetries) {
        const retryLabel = `${nextAttempt}/${config.maxRunRetries}`;
        bufferLog(runId, 'system', `[runner] Scheduling retry ${retryLabel} in ${config.runRetryDelayMs / 1000}s...`);
        commentOnIssue(issue.key, `Run failed (attempt ${run.retry_attempt ?? 0}/${config.maxRunRetries}). Retrying in ${config.runRetryDelayMs / 1000}s...\nError: ${errorMessage.slice(0, 150)}`);

        setTimeout(() => {
          const retryRunId = enqueueRetry(run, issue);
          if (retryRunId) {
            console.log(`[runner] Enqueued retry ${retryLabel} as run ${retryRunId} for ${issue.key}`);
          }
        }, config.runRetryDelayMs);
      } else {
        updateLinearStatus(issue.key, 'Failed');
        commentOnIssue(issue.key, `Agent run failed after ${config.maxRunRetries} retries. Manual investigation needed.\nLast error: ${errorMessage.slice(0, 200)}`);
        bufferLog(runId, 'system', `[runner] All ${config.maxRunRetries} retries exhausted for ${issue.key}`);
      }
    } else {
      commentOnIssue(issue.key, `Fix attempt failed (${run.fix_type}, attempt ${run.fix_attempt}): ${errorMessage.slice(0, 200)}`);
    }

  } finally {
```

**Key behavior changes:**
- Linear status stays "In Progress" during retries (no premature "Failed")
- Each failed attempt comments on the issue with error + retry status
- Only after all retries exhausted → Linear status set to "Failed" + "manual investigation needed" comment
- `setTimeout` provides the delay between attempts

### 7. Update initial run creation to set `retry_attempt: 0`

**File:** `orchestrator/src/runner.ts`

In the `startRunner` poll loop (~line 1182), the run object already has `fix_attempt: 0`. Add `retry_attempt: 0` alongside it:

```typescript
const run: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
  fix_attempt: 0,
  retry_attempt: 0,        // <-- ADD THIS
};
```

Also update `enqueueRevision` (~line 817) to include `retry_attempt: 0`:

```typescript
const newRun: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
  fix_attempt: 0,
  retry_attempt: 0,        // <-- ADD THIS
};
```

And the retry handler in `server.ts` POST `/api/runs/:id/retry` (~line 174):

```typescript
const newRun = {
  fix_attempt: original.fix_attempt ?? 0,
  retry_attempt: 0,        // <-- ADD THIS (manual retry resets the counter)
};
```

### 8. Update dashboard to show retry info

**File:** `orchestrator/board/index.html`

Update the `runTypeBadge` function to show retry attempts:

```javascript
function runTypeBadge(run) {
  if (run.is_fix && run.fix_type) {
    const label = run.fix_type === 'merge_conflict' ? 'Conflict' : 'CI Fix';
    const attempt = run.fix_attempt ? `<span class="fix-attempt">${run.fix_attempt}/${window._maxFixRetries || '?'}</span>` : '';
    return `<span class="fix-badge ${esc(run.fix_type)}">${label}</span>${attempt}`;
  }
  if (run.retry_attempt > 0) {
    return `<span style="color:var(--yellow)">Retry ${run.retry_attempt}/${window._maxRunRetries || 3}</span>`;
  }
  if (run.is_revision) {
    const siblings = [...runs.values()].filter(r => r.issue_key === run.issue_key);
    siblings.sort((a, b) => (a.created_at || a.id) < (b.created_at || b.id) ? -1 : 1);
    const idx = siblings.findIndex(r => r.id === run.id);
    return `<span style="color:var(--text-muted)">Rev #${idx + 1}</span>`;
  }
  return '';
}
```

To make `_maxRunRetries` available on the client, add it to the init sequence. Add a new API endpoint or piggyback on an existing one. Simplest approach — add to the `GET /health` response:

**File:** `orchestrator/src/server.ts`

In the `/health` handler, add:

```typescript
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    db: dbStatus,
    maxRunRetries: config.maxRunRetries,      // <-- ADD
    maxFixRetries: config.maxFixRetries,      // <-- ADD (may already be exposed elsewhere)
  });
});
```

In the dashboard `<script>`, fetch this at init:

```javascript
async function fetchConfig() {
  try {
    const res = await fetch('/health');
    if (res.ok) {
      const data = await res.json();
      window._maxRunRetries = data.maxRunRetries || 3;
      window._maxFixRetries = data.maxFixRetries || 3;
    }
}
```

Update the init line:

```javascript
Promise.all([fetchConfig(), fetchProjectMeta()]).then(() => fetchRuns());
```

## Testing strategy

### 1. TypeScript type check:
```bash
cd orchestrator && bunx tsc --noEmit
```

### 2. Unit test for enqueueRetry (new test file):

**File:** `orchestrator/src/retry.test.ts`

```typescript
import { describe, it, expect } from 'bun:test';

```

### 3. Integration test (manual):
- Set `MAX_RUN_RETRIES=2` and `RUN_RETRY_DELAY_MS=5000` (short for testing)
- Create an issue that will fail (e.g. missing design doc on branch)
- Watch orchestrator logs:
  - Attempt 0 fails → "Scheduling retry 1/2 in 5s..."
  - Attempt 1 fails → "Scheduling retry 2/2 in 5s..."
  - Attempt 2 fails → "All 2 retries exhausted" → Linear status = "Failed"
- Verify dashboard shows "Retry 1/2", "Retry 2/2" in Type column
- Verify Linear issue has 3 comments (one per failure + retry notification)

### 4. Manual retry resets counter:
- After retries exhausted, click [Retry] on dashboard
- Verify new run has `retry_attempt: 0` (fresh start)

### 5. Fix runs excluded:
- Trigger a CI fix run
- Verify it does NOT use the auto-retry system (uses fix_tracking instead)

## Out of scope

- Exponential backoff between retries (fixed delay is simpler and sufficient)
- Per-project retry configuration (global config only)
- Retry only on certain error types (all failures are retried)
- Retry history/audit view in dashboard (individual runs are already visible)
