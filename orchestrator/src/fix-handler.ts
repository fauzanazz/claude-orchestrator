import { log, errorMsg } from './logger.ts';
import { monotonicFactory } from 'ulid';
import { config, resolveProject } from './config.ts';
import { GHRunListSchema } from './schemas.ts';
import {
  getRunByPRNumber,
  getRunByBranch,
  getFixTracking,
  markFixExhausted,
  resolveFixTracking,
  deleteFixTracking,
  getSiblingOpenPRRuns,
} from './db.ts';
import {
  ensureProjectLocal,
  setupWorktree,
  rebaseOnto,
  abortRebase,
  forcePushFromWorktree,
  cleanupWorktree,
} from './git.ts';
import {
  fetchAllPRStatuses,
  checkFixNeeded,
  sendFixExhaustedNotification,
  type GHPRView,
} from './notify.ts';
import { reconstructIssueFromRun } from './poller.ts';
import type { Run, Issue, FixType } from './types.ts';

const ulid = monotonicFactory();

// ---------------------------------------------------------------------------
// CI failure log fetching
// ---------------------------------------------------------------------------

export async function fetchCIFailureLogs(repo: string, branch: string): Promise<string> {
  // Find the most recent failed workflow run on this branch
  const listProc = Bun.spawn(
    [
      'gh', 'run', 'list',
      '--branch', branch,
      '--repo', repo,
      '--status', 'failure',
      '--json', 'databaseId,name',
      '--limit', '1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [listOut, listExit] = await Promise.all([
    new Response(listProc.stdout).text(),
    listProc.exited,
  ]);

  if (listExit !== 0) return 'Could not fetch CI run list.';

  let listJson: unknown;
  try {
    listJson = JSON.parse(listOut);
  } catch {
    return 'Could not parse CI run list (invalid JSON).';
  }
  const listResult = GHRunListSchema.safeParse(listJson);
  if (!listResult.success) return 'Could not parse CI run list.';
  const runs = listResult.data;

  const firstRun = runs[0];
  if (!firstRun) return 'No failed CI runs found.';

  const runId = firstRun.databaseId;
  const runName = firstRun.name;

  // Fetch the failed logs
  const logProc = Bun.spawn(
    [
      'gh', 'run', 'view', String(runId),
      '--repo', repo,
      '--log-failed',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [logOut, logExit] = await Promise.all([
    new Response(logProc.stdout).text(),
    logProc.exited,
  ]);

  if (logExit !== 0) return `CI run "${runName}" failed but logs could not be retrieved.`;

  // Truncate to avoid overwhelming the agent prompt
  const maxLen = 5000;
  const logs = logOut.trim();
  if (logs.length > maxLen) {
    return `CI run "${runName}" failed. Logs (truncated):\n\n${logs.slice(-maxLen)}`;
  }

  return `CI run "${runName}" failed. Logs:\n\n${logs}`;
}

// ---------------------------------------------------------------------------
// Proactive rebase: after a PR merges, rebase all sibling PRs in the same
// project to prevent the conflict cascade.
// ---------------------------------------------------------------------------

export async function proactiveRebaseSiblings(mergedRun: Run): Promise<void> {
  const siblings = getSiblingOpenPRRuns(mergedRun.project, mergedRun.issue_key);
  if (siblings.length === 0) return;

  const resolved = resolveProject(mergedRun.issue_repo ?? '');
  if (!resolved) return;

  const baseBranch = mergedRun.base_branch ?? resolved.project.baseBranch;

  log.info(
    `[rebase] PR #${mergedRun.pr_number} merged in ${mergedRun.project} — ` +
    `proactively rebasing ${siblings.length} sibling PR(s)`,
  );

  for (const sibling of siblings) {
    try {
      const projectPath = await ensureProjectLocal(resolved.project, resolved.key);
      const slug = ulid().slice(-6).toLowerCase();
      const worktreePath = await setupWorktree(projectPath, sibling.branch, sibling.issue_key, slug);

      try {
        const result = await rebaseOnto(worktreePath, baseBranch);
        if (result.success) {
          await forcePushFromWorktree(worktreePath, sibling.branch);
          log.info(`[rebase] Auto-rebased PR #${sibling.pr_number} (${sibling.issue_key}) onto ${baseBranch}`);
        } else {
          log.info(`[rebase] PR #${sibling.pr_number} (${sibling.issue_key}) has real conflicts — skipping (fixer will handle)`);
          await abortRebase(worktreePath);
        }
      } finally {
        cleanupWorktree(projectPath, worktreePath).catch(() => {});
      }
    } catch (err) {
      log.warn(
        `[rebase] Failed to proactively rebase PR #${sibling.pr_number} (${sibling.issue_key}): ` +
        `${errorMsg(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-fix polling
// ---------------------------------------------------------------------------

export async function pollFixable(
  enqueueFix: (run: Run, issue: Issue, fixType: FixType, errorContext: string) => void,
  prStatuses?: Map<string, GHPRView[]>,
): Promise<void> {
  const allStatuses = prStatuses ?? await fetchAllPRStatuses();

  for (const [repo, prs] of allStatuses) {
    for (const pr of prs) {
      try {
        const fixNeeded = checkFixNeeded(pr);
        if (!fixNeeded) {
          // PR is healthy — delete fix tracking entirely
          deleteFixTracking(repo, pr.number, 'merge_conflict');
          deleteFixTracking(repo, pr.number, 'ci_failure');
          continue;
        }

        const { fixType } = fixNeeded;

        // Only fix PRs created by the orchestrator
        const resolved = resolveProject(repo);
        const originalRun = getRunByPRNumber(pr.number, resolved?.key);
        if (!originalRun) continue;

        // Skip if there's already a queued/running fix for this branch
        const existingRun = getRunByBranch(pr.headRefName);
        if (existingRun && (existingRun.status === 'queued' || existingRun.status === 'running')) {
          continue;
        }

        // Check fix tracking
        const tracking = getFixTracking(repo, pr.number, fixType);

        if (tracking?.exhausted) continue;

        // Cooldown: skip if this fix type was recently resolved
        if (tracking?.resolved_at) {
          const resolvedMs = new Date(tracking.resolved_at + 'Z').getTime();
          const elapsed = Date.now() - resolvedMs;
          if (elapsed < config.fixCooldownMs) {
            continue;
          }
        }

        const currentAttempt = (tracking?.attempt_count ?? 0) + 1;

        if (currentAttempt > config.maxFixRetries) {
          markFixExhausted(repo, pr.number, fixType);
          await sendFixExhaustedNotification({
            repo, prNumber: pr.number, title: pr.title, url: pr.url, fixType, attempts: config.maxFixRetries,
          });
          log.info(`[fixer] Fix attempts exhausted for PR #${pr.number} in ${repo} (${fixType})`);
          continue;
        }

        // Reconstruct issue from original run
        const issue = await reconstructIssueFromRun(originalRun);

        if (fixType === 'merge_conflict') {
          // Try automatic rebase first
          log.info(`[fixer] Attempting rebase for PR #${pr.number} in ${repo}`);
          if (!resolved) continue;

          const projectPath = await ensureProjectLocal(resolved.project, resolved.key);
          const slug = ulid().slice(-6).toLowerCase();
          const worktreePath = await setupWorktree(projectPath, issue.branch, issue.key, slug);

          try {
            const rebaseResult = await rebaseOnto(worktreePath, issue.baseBranch);

            if (rebaseResult.success) {
              // Rebase succeeded cleanly — force push
              await forcePushFromWorktree(worktreePath, issue.branch);
              resolveFixTracking(repo, pr.number, fixType);
              log.info(`[fixer] Auto-rebase succeeded for PR #${pr.number} in ${repo}`);
            } else {
              // Rebase failed — abort and spawn agent
              await abortRebase(worktreePath);
              enqueueFix(originalRun, issue, fixType, `Merge conflict on PR #${pr.number} (attempt ${currentAttempt}/${config.maxFixRetries})`);
            }
          } finally {
            cleanupWorktree(projectPath, worktreePath).catch(() => {});
          }
        } else {
          // CI failure — spawn agent (it will fetch CI logs in its prompt)
          log.info(`[fixer] CI failure detected for PR #${pr.number} in ${repo}`);
          enqueueFix(originalRun, issue, 'ci_failure', `CI failure on PR #${pr.number} (attempt ${currentAttempt}/${config.maxFixRetries})`);
        }
      } catch (err) {
        log.error(`[fixer] Error checking PR #${pr.number} in ${repo}:`, err);
      }
    }
  }
}
