# Spec: Auto-Fix Merge Conflicts & CI/CD Failures

## What are we building?
An automated detection and repair system within the orchestrator that identifies merge conflicts and CI/CD failures on PRs created by agents, then attempts to fix them — first via automatic git rebase (for conflicts), then by spawning Claude agents with escalating context (up to a configurable retry limit).

## Who is this for?
The sole operator running the orchestrator, who wants to minimize manual intervention when agent-created PRs hit merge conflicts or CI failures.

## What does success look like?
- The orchestrator detects merge conflicts (via `gh pr view` mergeable state) and CI/CD failures (via status checks) on all agent-created PRs during its existing polling loop.
- For merge conflicts: the orchestrator first attempts `git rebase <baseBranch>`. If the rebase succeeds cleanly, it force-pushes. If the rebase fails with conflicts, it spawns a Claude agent to resolve them.
- For CI/CD failures: the orchestrator spawns a Claude agent with the CI error logs/context to diagnose and fix the issue.
- Up to `MAX_FIX_RETRIES` (default: 3, configurable via env var) fix attempts are made with escalating context (each retry includes the history of prior failed attempts).
- If all retries are exhausted, the operator is notified via macOS notification + Slack (using existing notification channels).
- Each fix attempt is tracked as a new `Run` record in the database with a distinguishing type (e.g., `is_fix = 1`) so it's visible in the dashboard.
- The dashboard shows fix attempt runs alongside regular runs, with clear indication of what triggered them (merge conflict vs CI failure).

## What is explicitly out of scope?
- **No auto-merge**: even if the fix succeeds and CI goes green, the operator still merges manually.
- **No cross-PR conflict resolution**: only handle conflicts against the base branch, not between two in-flight PRs.
- **No new webhook routes**: detection uses polling only (extends existing `pollMergeReadiness` / review polling loops).
- **No fix attempts on non-agent PRs**: only fix PRs that the orchestrator created (tracked in the `runs` table).

## Constraints
- Runtime: Bun + Hono (existing stack).
- Detection via polling using `gh pr view --json` (no new webhook handlers).
- Rebase via `git rebase` in the existing worktree; force-push via `git push --force-with-lease`.
- Agent spawning reuses the existing `executeRun()` pipeline with modified prompt context.
- New env var: `MAX_FIX_RETRIES` (default: 3).
- Fix attempt tracking in SQLite — new columns or table to track attempt count and fix type per PR.
- Must not interfere with existing review polling, agent execution, or merge-ready notifications.
- Notifications on exhausted retries use the existing `notifyMacOS()` + `notifySlack()` from `notify.ts`.
