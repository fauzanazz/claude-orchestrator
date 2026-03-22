# Design: Auto-Fix Merge Conflicts & CI/CD Failures

**Date**: 2026-03-23
**Spec**: `.planning/spec-auto-fix.md`
**Approach**: Hybrid shared PR fetch with separate handlers

## Architecture

### Detection Flow

```
pollPRStatuses()                    [new unified poller, replaces separate calls]
  |
  +-- fetchAllOpenPRs(projects)     [one gh pr list per project]
  |     +-- ghPRView(repo, pr)      [one gh pr view per PR, with mergeable field]
  |
  +-- handleMergeReadyNotifications(statuses)   [existing logic, moved here]
  +-- handleFixableIssues(statuses)             [NEW: detect & dispatch fixes]
```

### Fix Flow

```
handleFixableIssues(prStatuses)
  |
  for each PR with (conflict OR ci_failure):
    |
    +-- is this an agent-created PR? (check runs table by branch)
    +-- already at MAX_FIX_RETRIES? -> notify exhaustion, skip
    +-- already has a queued/running fix? -> skip
    |
    if MERGE_CONFLICT:
      +-- try git rebase <baseBranch> in worktree
      +-- if rebase succeeds cleanly -> force-push, done
      +-- if rebase fails -> abort rebase, spawn agent with conflict context
    |
    if CI_FAILURE:
      +-- fetch failed run logs via `gh run view <id> --log-failed`
      +-- spawn agent with CI error logs + context
```

### Agent Prompt for Fixes

The fix agent gets the same base prompt (global + CLAUDE.md + design doc) plus a new section:

```
## Fix Task

**Type**: merge_conflict | ci_failure
**Attempt**: 2 of 3
**PR**: #42 — https://github.com/owner/repo/pull/42

### Error Context
[conflict diff or CI failure logs]

### Previous Attempts
[summary of what was tried before, if attempt > 1]
```

### Data Model Changes

**`runs` table** — new columns:
- `is_fix INTEGER NOT NULL DEFAULT 0` — 1 for fix runs
- `fix_type TEXT` — `'merge_conflict'` or `'ci_failure'` (null for non-fix runs)
- `fix_attempt INTEGER NOT NULL DEFAULT 0` — which attempt this is (1, 2, 3...)

**`fix_tracking` table** — new table for deduplication + counting:
- `repo TEXT NOT NULL`
- `pr_number INTEGER NOT NULL`
- `fix_type TEXT NOT NULL`
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `last_run_id TEXT REFERENCES runs(id)`
- `exhausted INTEGER NOT NULL DEFAULT 0` — 1 if all retries used
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`
- PRIMARY KEY `(repo, pr_number, fix_type)`

When a fix succeeds (CI goes green / conflict resolved), the row is deleted so it can re-trigger if the issue recurs.

## File Changes

### `src/types.ts`
- Add `FixType = 'merge_conflict' | 'ci_failure'`
- Add `is_fix`, `fix_type`, `fix_attempt` to `Run` interface
- Add `FixTracking` interface
- Extend `GHPRView` (in notify.ts) to include `mergeable` field

### `src/config.ts`
- Add `maxFixRetries` from `MAX_FIX_RETRIES` (default 3)
- Add `fixPollIntervalMs` from `FIX_POLL_INTERVAL_MS` (default 120000)

### `src/db.ts`
- ALTER TABLE `runs` to add `is_fix`, `fix_type`, `fix_attempt` columns
- CREATE TABLE `fix_tracking`
- Add functions: `getFixTracking()`, `upsertFixTracking()`, `clearFixTracking()`, `getRunByPRNumber()`

### `src/git.ts`
- Add `rebaseOnto(worktreePath, baseBranch)` — runs `git rebase origin/<baseBranch>`, returns success/failure + conflict info
- Add `abortRebase(worktreePath)` — runs `git rebase --abort`
- Add `forcePushFromWorktree(worktreePath, branch)` — uses `--force-with-lease`

### `src/notify.ts`
- Add `mergeable` to `ghPRView()` JSON fields
- Extract `fetchAllPRStatuses()` — returns `Map<string, GHPRView[]>` keyed by repo
- Refactor `pollMergeReadiness()` to use `fetchAllPRStatuses()`
- Export `fetchAllPRStatuses()` for use by runner
- Add `checkFixNeeded(pr)` — returns `{ needsFix: boolean, fixType: FixType }` or null
- Add `sendFixExhaustedNotification()` — macOS + Slack notification for exhausted retries

### `src/runner.ts`
- Add `pollFixable()` — uses `fetchAllPRStatuses()`, cross-references with runs DB, dispatches fixes
- Add `enqueueFix(run, prNumber, issue, fixType, attempt)` — like `enqueueRevision()` but for fixes
- Add `buildFixPrompt(issue, worktreePath, fixType, errorContext, previousAttempts)` — fix-specific prompt
- Add `attemptRebase(projectPath, worktreePath, branch, baseBranch)` — tries rebase, returns result
- Add `fetchCIFailureLogs(repo, branch)` — fetches failed CI run logs via `gh run view --log-failed`
- Register `pollFixable()` interval in `startRunner()`

### `board/index.html`
- Add visual badge for fix runs (e.g., "FIX: merge conflict" or "FIX: CI failure")
- Show attempt number (e.g., "attempt 2/3")

### `.env.example`
- Add `MAX_FIX_RETRIES=3`
- Add `FIX_POLL_INTERVAL_MS=120000`
