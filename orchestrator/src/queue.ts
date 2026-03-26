import { monotonicFactory } from 'ulid';
import { log } from './logger.ts';
import { config, loadProjects, resolveProject } from './config.ts';
import {
  insertRun,
  insertLog,
  updateRunStatus,
  getRun,
  getRunByBranch,
  getWatchableRuns,
  isReviewProcessed,
  markReviewProcessed,
  upsertFixTracking,
  getIssueForRun,
} from './db.ts';
import { proactiveRebaseSiblings } from './fix-handler.ts';
import { reconstructIssueFromRun, updateLinearStatus } from './poller.ts';
import { GHPRReviewPollSchema } from './schemas.ts';
import type {
  Run,
  Issue,
  ProjectConfig,
  SSEEvent,
  FixType,
} from './types.ts';

const ulid = monotonicFactory();

type NewRun = Omit<Run, 'created_at' | 'started_at' | 'completed_at'>;

// ---------------------------------------------------------------------------
// SSE broadcaster hook
// ---------------------------------------------------------------------------

let _sseHandler: ((event: SSEEvent) => void) | null = null;

export function onSSE(handler: (event: SSEEvent) => void): void {
  _sseHandler = handler;
}

export function broadcastSSE(event: SSEEvent): void {
  _sseHandler?.(event);
}

// ---------------------------------------------------------------------------
// Log buffering
// ---------------------------------------------------------------------------

export const logBuffers: Map<string, Array<{ stream: string; content: string }>> = new Map();

export function bufferLog(runId: string, stream: string, content: string): void {
  if (!logBuffers.has(runId)) {
    logBuffers.set(runId, []);
  }
  logBuffers.get(runId)!.push({ stream, content });
  broadcastSSE({ type: 'log', runId, stream, content });
}

export function flushLogs(runId: string): void {
  const entries = logBuffers.get(runId);
  if (!entries || entries.length === 0) return;

  for (const entry of entries) {
    insertLog(runId, entry.stream, entry.content);
  }
  logBuffers.delete(runId);
}

export function flushAllLogs(): void {
  for (const runId of logBuffers.keys()) {
    flushLogs(runId);
  }
}

// ---------------------------------------------------------------------------
// Run record creation
// ---------------------------------------------------------------------------

export function createRunRecord(overrides: Partial<NewRun> & Pick<NewRun, 'project' | 'issue_id' | 'issue_key' | 'issue_title' | 'branch' | 'worktree_path'>): NewRun {
  return {
    id: ulid(),
    status: 'queued',
    is_revision: 0,
    is_fix: 0,
    fix_type: null,
    fix_attempt: 0,
    retry_attempt: 0,
    pr_number: null,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    design_path: null,
    issue_repo: null,
    base_branch: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

const queue: Run[] = [];
let activeRunCount = 0;
let shuttingDown = false;

// Sidecar map: runId -> Issue (kept in memory for the lifetime of the queue item)
const issueMap: Map<string, Issue> = new Map();

// Retry context: stores failure context from parent run for injection into retry prompts.
// Keyed by the *retry* run ID. Acceptable to lose on orchestrator restart.
export const retryContextMap: Map<string, string> = new Map();

export function beginShutdown(): void {
  shuttingDown = true;
  queue.length = 0; // Clear pending queue
  log.info('[runner] Shutdown initiated — no new runs will start');
}

export function getRunningCount(): number {
  return activeRunCount;
}

export function getQueueLength(): number {
  return queue.length;
}

export function buildRetryContext(failedRun: Run): string {
  const sections: string[] = [];

  sections.push('## Previous Attempt Failed');
  sections.push('');
  sections.push('The orchestrator is automatically retrying this task because the previous attempt failed.');
  sections.push(`- **Previous attempt**: ${failedRun.retry_attempt + 1}`);
  sections.push(`- **Error**: ${failedRun.error_summary ?? 'Unknown error'}`);
  sections.push(`- **Sessions completed**: ${failedRun.iterations}`);

  // Read logs from in-memory buffer (not yet flushed to DB at this point)
  const buffered = logBuffers.get(failedRun.id);
  if (buffered && buffered.length > 0) {
    const tail = buffered.slice(-30);
    const logText = tail
      .map((e) => `[${e.stream}] ${e.content}`)
      .join('\n');
    sections.push('');
    sections.push(`### What the previous attempt did (last ${tail.length} log entries)`);
    sections.push('```');
    sections.push(logText);
    sections.push('```');
  }

  sections.push('');
  sections.push('### Instructions for this retry');
  sections.push('');
  sections.push('- Review the error and logs above carefully.');
  sections.push('- **Do NOT repeat the same approach** that caused the failure.');
  sections.push('- If the error was a timeout, focus on the most critical features first and skip exploratory work.');
  sections.push('- If the error was "No commits produced", make sure to actually write code and commit it.');
  sections.push('- If the error was a git or setup issue, try an alternative approach to the setup step.');
  sections.push('- Start by reading `.agent-state/features.json` and `.agent-state/progress.md` if they exist from the previous attempt.');

  return sections.join('\n');
}

export function enqueue(run: Run): boolean {
  if (queue.length >= config.maxQueueSize) {
    log.warn(`[runner] Queue full (${queue.length}/${config.maxQueueSize}), rejecting run ${run.id}`);
    updateRunStatus(run.id, 'failed', {
      error_summary: 'Queue full — run rejected',
      completed_at: new Date().toISOString(),
    });
    return false;
  }
  queue.push(run);
  return true;
}

export function enqueueWithIssue(run: Run, issue: Issue): boolean {
  issueMap.set(run.id, issue);
  const ok = enqueue(run);
  if (!ok) {
    issueMap.delete(run.id);
  }
  return ok;
}

export function enqueueRevision(originalRun: Run, prNumber: number, issue: Issue): string {
  const newRun = createRunRecord({
    project: originalRun.project,
    issue_id: originalRun.issue_id,
    issue_key: originalRun.issue_key,
    issue_title: originalRun.issue_title,
    branch: originalRun.branch,
    worktree_path: originalRun.worktree_path,
    is_revision: 1,
    pr_number: prNumber,
    design_path: issue.designPath,
    issue_repo: issue.repo,
    base_branch: issue.baseBranch,
  });

  insertRun(newRun);

  // getRun to get the full record with timestamps
  const fullRun = getRun(newRun.id);
  if (fullRun) {
    enqueueWithIssue(fullRun, issue);
    broadcastSSE({ type: 'run_update', run: fullRun });
  }

  return newRun.id;
}

export function enqueueRetry(
  failedRun: Run,
  issue: Issue,
  delayMs = 0,
): string | null {
  if (failedRun.is_fix) return null;

  const nextAttempt = (failedRun.retry_attempt ?? 0) + 1;
  if (nextAttempt > config.maxRunRetries) return null;

  // Build retry context from the failed run BEFORE logs are flushed
  const retryContext = buildRetryContext(failedRun);

  const newRun = createRunRecord({
    project: failedRun.project,
    issue_id: failedRun.issue_id,
    issue_key: failedRun.issue_key,
    issue_title: failedRun.issue_title,
    branch: failedRun.branch,
    worktree_path: failedRun.worktree_path,
    is_revision: failedRun.is_revision,
    retry_attempt: nextAttempt,
    pr_number: failedRun.pr_number,
    design_path: failedRun.design_path ?? null,
    issue_repo: failedRun.issue_repo ?? null,
    base_branch: failedRun.base_branch ?? null,
  });

  // Insert into DB immediately so hasActiveRunForIssue() sees it
  // and the poll loop won't spawn a duplicate run during the delay.
  insertRun(newRun);

  const fullRun = getRun(newRun.id);
  if (!fullRun) return null;

  // Store context for the retry run to read during execution
  retryContextMap.set(newRun.id, retryContext);

  broadcastSSE({ type: 'run_update', run: fullRun });

  if (delayMs > 0) {
    setTimeout(() => {
      if (!enqueueWithIssue(fullRun, issue)) {
        retryContextMap.delete(newRun.id);
      }
    }, delayMs);
  } else {
    if (!enqueueWithIssue(fullRun, issue)) {
      retryContextMap.delete(newRun.id);
    }
  }

  return newRun.id;
}

export function enqueueFix(
  originalRun: Run,
  prNumber: number,
  issue: Issue,
  fixType: FixType,
  attempt: number,
): string | null {
  const newRun = createRunRecord({
    project: originalRun.project,
    issue_id: originalRun.issue_id,
    issue_key: originalRun.issue_key,
    issue_title: originalRun.issue_title,
    branch: originalRun.branch,
    worktree_path: originalRun.worktree_path,
    is_fix: 1,
    fix_type: fixType,
    fix_attempt: attempt,
    pr_number: prNumber,
    design_path: issue.designPath,
    issue_repo: issue.repo,
    base_branch: issue.baseBranch,
  });

  insertRun(newRun);

  const fullRun = getRun(newRun.id);
  if (!fullRun) {
    // INSERT OR IGNORE dropped the row (likely a queued/running run already
    // exists for this issue_id due to the partial unique index).
    log.warn(`[fixer] Run ${newRun.id} was not inserted — duplicate active run for issue ${newRun.issue_key}`);
    return null;
  }

  enqueueWithIssue(fullRun, issue);
  broadcastSSE({ type: 'run_update', run: fullRun });
  upsertFixTracking(issue.repo, prNumber, fixType, newRun.id);

  return newRun.id;
}

type ExecuteRunFn = (run: Run, project: ProjectConfig, projectKey: string, issue: Issue) => Promise<void>;

export async function dispatchNextRun(executeRunFn: ExecuteRunFn): Promise<void> {
  if (shuttingDown) return;
  if (activeRunCount >= config.maxConcurrentAgents) return;
  if (queue.length === 0) return;

  const run = queue.shift()!;
  activeRunCount++;

  // Look up issue metadata: try in-memory map first (for in-flight runs),
  // then fall back to DB-persisted columns (for runs surviving a restart).
  let issueData = issueMap.get(run.id);
  if (!issueData) {
    issueData = getIssueForRun(run) ?? undefined;
  }

  if (!issueData) {
    log.error(`[runner] tick: no issue data for run ${run.id}`);
    updateRunStatus(run.id, 'failed', {
      error_summary: 'Internal: issue metadata not found for run',
      completed_at: new Date().toISOString(),
    });
    activeRunCount--;
    return;
  }

  // Resolve project config
  const resolved = resolveProject(issueData.repo);

  if (!resolved) {
    log.error(`[runner] tick: could not resolve project for repo "${issueData.repo}" (run ${run.id})`);
    updateRunStatus(run.id, 'failed', {
      error_summary: `Project not found in registry for repo: ${issueData.repo}`,
      completed_at: new Date().toISOString(),
    });
    activeRunCount--;
    return;
  }

  // Fire and forget
  executeRunFn(run, resolved.project, resolved.key, issueData)
    .catch((err) => {
      log.error(`[runner] Unhandled error in executeRun for ${run.id}:`, err);
    })
    .finally(() => {
      activeRunCount--;
      issueMap.delete(run.id);
    });
}

// ---------------------------------------------------------------------------
// PR review polling
// ---------------------------------------------------------------------------

export async function pollReviews(): Promise<void> {
  const watchable = getWatchableRuns(config.reviewWatchMaxAgeDays);
  if (watchable.length === 0) return;

  const projects = loadProjects();

  for (const run of watchable) {
    try {
      const projectConfig = projects[run.project];
      if (!projectConfig?.repo) continue;
      const repo = projectConfig.repo;

      // Skip if there's already a queued/running revision for this branch
      const existing = getRunByBranch(run.branch);
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        continue;
      }

      // Fetch PR state + reviews via gh CLI
      const ghProc = Bun.spawn(
        [
          'gh', 'pr', 'view', String(run.pr_number),
          '--repo', repo,
          '--json', 'state,reviews',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [ghOut, ghExit] = await Promise.all([
        new Response(ghProc.stdout).text(),
        ghProc.exited,
      ]);

      if (ghExit !== 0) continue;

      let pollJson: unknown;
      try {
        pollJson = JSON.parse(ghOut);
      } catch {
        continue;
      }
      const pollResult = GHPRReviewPollSchema.safeParse(pollJson);
      if (!pollResult.success) continue;
      const prData = pollResult.data;

      // Update Linear status and run state for closed/merged PRs
      if (prData.state === 'MERGED') {
        updateRunStatus(run.id, 'merged');
        updateLinearStatus(run.issue_key, 'Done');
        log.info(`[reviewer] PR #${run.pr_number} merged — marked ${run.issue_key} as Done`);
        // Proactively rebase sibling PRs to prevent conflict cascade
        proactiveRebaseSiblings(run).catch((err) =>
          log.error(`[rebase] Error rebasing siblings after ${run.issue_key} merge:`, err),
        );
        continue;
      }
      if (prData.state === 'CLOSED') {
        updateRunStatus(run.id, 'closed');
        updateLinearStatus(run.issue_key, 'Canceled');
        log.info(`[reviewer] PR #${run.pr_number} closed — marked ${run.issue_key} as Canceled`);
        continue;
      }
      if (prData.state !== 'OPEN') continue;

      for (const review of prData.reviews) {
        const reviewId = review.id;
        if (!reviewId) continue;

        const state = review.state.toLowerCase();
        const body = review.body.trim();
        const reviewAuthor = review.author?.login;

        // Skip self-reviews to prevent loops
        if (reviewAuthor === config.githubUsername) continue;

        // Skip already processed reviews
        if (isReviewProcessed(reviewId)) continue;

        // Determine if actionable
        const isActionable =
          state === 'changes_requested' ||
          (state === 'commented' && body.length >= config.reviewMinBodyLength);

        if (!isActionable) continue;

        // Reconstruct Issue from the original run
        const issue = await reconstructIssueFromRun(run);

        // Enqueue revision
        const revisionRunId = enqueueRevision(run, run.pr_number!, issue);

        // Only mark review as processed if the run was actually inserted
        // (INSERT OR IGNORE may skip if a queued run already exists for this issue)
        if (!getRun(revisionRunId)) {
          log.warn(`[reviewer] Revision run ${revisionRunId} was not inserted (duplicate?), skipping review ${reviewId}`);
          continue;
        }
        markReviewProcessed(reviewId, run.pr_number!, repo, revisionRunId);

        log.info(
          `[reviewer] Enqueued revision ${revisionRunId} for PR #${run.pr_number} ` +
          `(review ${reviewId}, state: ${state})`
        );

        // Only process one new review per PR per cycle
        break;
      }
    } catch (err) {
      log.error(`[reviewer] Error checking PR for run ${run.id}:`, err);
    }
  }
}
