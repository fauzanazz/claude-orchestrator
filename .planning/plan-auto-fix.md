# Implementation Plan: Auto-Fix Merge Conflicts & CI/CD Failures

**Spec**: `.planning/spec-auto-fix.md`
**Design**: `docs/plans/2026-03-23-auto-fix-design.md`

## Wave 1: Foundation (all independent, run in parallel)

### Task 1.1: Types — add fix-related types
**Files**: `orchestrator/src/types.ts`
- Add `FixType = 'merge_conflict' | 'ci_failure'`
- Add `is_fix: number`, `fix_type: string | null`, `fix_attempt: number` to `Run` interface
- Add `FixTracking` interface: `{ repo, pr_number, fix_type, attempt_count, last_run_id, exhausted, updated_at }`

### Task 1.2: Config — add new env vars
**Files**: `orchestrator/src/config.ts`, `orchestrator/.env.example`
- Add `maxFixRetries` from `MAX_FIX_RETRIES` env var (default: 3)
- Add `fixPollIntervalMs` from `FIX_POLL_INTERVAL_MS` env var (default: 120000)
- Update `.env.example` with both vars

### Task 1.3: Database — add fix columns and table
**Files**: `orchestrator/src/db.ts`
- Add `is_fix`, `fix_type`, `fix_attempt` columns to `runs` table (via ALTER TABLE in schema init)
- Create `fix_tracking` table with composite PK `(repo, pr_number, fix_type)`
- Add prepared statements and functions:
  - `getFixTracking(repo, prNumber, fixType)` — returns current tracking record
  - `upsertFixTracking(repo, prNumber, fixType, runId)` — increments attempt_count, updates last_run_id
  - `markFixExhausted(repo, prNumber, fixType)` — sets exhausted = 1
  - `clearFixTracking(repo, prNumber, fixType)` — deletes row (for when issue is resolved)
  - `getRunByPRNumber(prNumber, repo)` — finds the original run that created this PR

### Task 1.4: Git — add rebase and force-push functions
**Files**: `orchestrator/src/git.ts`
- Add `rebaseOnto(worktreePath, baseBranch)`:
  - Runs `git fetch origin <baseBranch>` then `git rebase origin/<baseBranch>`
  - Returns `{ success: boolean, conflictOutput?: string }`
- Add `abortRebase(worktreePath)`: runs `git rebase --abort`
- Add `forcePushFromWorktree(worktreePath, branch)`:
  - Runs `git push --force-with-lease origin local/<branch>:<branch>`

## Wave 2: Core Logic (depends on Wave 1)

### Task 2.1: Notify — refactor to shared PR fetching + fix detection
**Files**: `orchestrator/src/notify.ts`
- Add `mergeable` to `ghPRView()` JSON query field list
- Add `mergeable` field to `GHPRView` interface
- Extract `fetchAllPRStatuses(): Promise<Map<string, GHPRView[]>>`:
  - Iterates all projects from `loadProjects()`
  - Calls `ghPRList()` then `ghPRView()` for each
  - Returns map keyed by repo
- Refactor `pollMergeReadiness()` to accept `Map<string, GHPRView[]>` parameter (or call `fetchAllPRStatuses()` internally if no param)
- Add `checkFixNeeded(pr: GHPRView)`: returns `{ fixType: FixType } | null`
  - `merge_conflict` if `pr.mergeable === 'CONFLICTING'`
  - `ci_failure` if any check has conclusion not in `['SUCCESS', 'NEUTRAL', 'SKIPPED', '']` and at least one check is `FAILURE` or `ERROR`
- Add `sendFixExhaustedNotification(repo, prNumber, title, url, fixType, attempts)`:
  - macOS notification: "Fix attempts exhausted for PR #N"
  - Slack Block Kit: header, fix type, attempt count, "View PR" button
- Export `fetchAllPRStatuses`, `checkFixNeeded`, `sendFixExhaustedNotification`

### Task 2.2: Runner — add fix polling, enqueueing, and prompt building
**Files**: `orchestrator/src/runner.ts`
- Import new functions from notify.ts, db.ts, git.ts
- Add `fetchCIFailureLogs(repo, branch)`:
  - `gh run list --branch <branch> --repo <repo> --status failure --json databaseId,name --limit 1`
  - If found: `gh run view <id> --repo <repo> --log-failed` (truncate to 5000 chars)
  - Returns string with CI error context
- Add `buildFixPrompt(issue, worktreePath, fixType, errorContext, previousAttempts?)`:
  - Base prompt (global + CLAUDE.md + design doc) via existing `buildAgentPrompt()`
  - Appends fix-specific section: type, attempt number, error context, previous attempts
  - Rules: "fix the issue, commit changes, do not push"
- Add `enqueueFix(originalRun, prNumber, issue, fixType, attempt)`:
  - Creates new Run with `is_fix=1`, `fix_type`, `fix_attempt`
  - `insertRun()` + `enqueueWithIssue()` + `broadcastSSE()`
  - `upsertFixTracking()`
- Add `pollFixable()`:
  - Call `fetchAllPRStatuses()` (shared with notifications)
  - For each PR with `checkFixNeeded()` returning non-null:
    - Find the original run via `getRunByPRNumber()`
    - Skip if no matching run (not an agent PR)
    - Skip if already has queued/running fix (`getRunByBranch()`)
    - Check `getFixTracking()` — skip if exhausted
    - If at max retries: `markFixExhausted()`, `sendFixExhaustedNotification()`, continue
    - For `merge_conflict`:
      1. `ensureProjectLocal()` + `setupWorktree()`
      2. `rebaseOnto(worktreePath, baseBranch)`
      3. If rebase succeeds: `forcePushFromWorktree()`, log success, `clearFixTracking()`
      4. If rebase fails: `abortRebase()`, `enqueueFix()` with conflict output as context
    - For `ci_failure`:
      1. `fetchCIFailureLogs()`
      2. `enqueueFix()` with CI logs as context
  - Also check previously fixed PRs: if CI now passes and no conflicts, `clearFixTracking()`
- Modify `startRunner()`:
  - Add new `setInterval` for unified polling that calls both `pollMergeReadiness()` and `pollFixable()` with shared PR data
  - Or: keep separate intervals, have `pollFixable()` call `fetchAllPRStatuses()` directly

## Wave 3: UI + Polish (depends on Wave 2)

### Task 3.1: Dashboard — show fix run indicators
**Files**: `orchestrator/board/index.html`
- In the run card rendering, detect `is_fix === 1`
- Show badge with fix type: "CONFLICT FIX" or "CI FIX"
- Show attempt number: "attempt 2/3"
- Use distinct color (e.g., orange for fix runs vs blue for normal)

## Execution Notes

- Wave 1 tasks are fully independent — run all 4 in parallel
- Wave 2 tasks depend on Wave 1 but are also independent of each other (notify + runner touch different files)
- Wave 3 depends on Wave 2 for the data model but is a simple UI change
- Total: 7 tasks across 3 waves
