import { join } from 'node:path';
import { log, errorMsg } from './logger.ts';
import { monotonicFactory } from 'ulid';
import { config, resolveProject } from './config.ts';
import { documentRun } from './memory.ts';
import { TokenTracker } from './token-tracker.ts';
import { reviewRun, formatReviewFeedback } from './review-gate.ts';
import { updateProjectIntelligence } from './project-intelligence.ts';
import {
  parseReviewFeedback,
  generateCodebaseSummary,
  buildAgentPrompt,
  buildPreviousSessionSummary,
  buildFixPrompt,
} from './agent-prompts.ts';
import {
  insertRun,
  updateRunStatus,
  updateRunIterations,
  updateRunTokens,
  getRun,
  getRunsByStatus,
  markStaleRunsFailed,
  getFixTracking,
  resolveFixTracking,
  getPRNumberByIssueKey,
  deleteOldLogs,
  deleteOldRuns,
  deleteOldProcessedReviews,
  deleteOldNotifiedPRs,
  vacuumDatabase,
  getDatabaseSize,
  snapshotDatabase,
  hasActiveRunForIssue,
} from './db.ts';
import {
  ensureProjectLocal,
  setupWorktree,
  setupAgentState,
  hasLocalCommits,
  writeAgentSettings,
  cleanupWorktree,
  pushFromWorktree,
  createPR,
  rebaseOnto,
  continueRebase,
  forcePushFromWorktree,
  type RebaseResult,
} from './git.ts';
import { initWorktree } from './init.ts';
import { fetchCIFailureLogs, pollFixable } from './fix-handler.ts';
import {
  buildInitializerPrompt,
  buildCodingPrompt,
  readFeatureList,
  isAllFeaturesDone,
  type SessionPromptContext,
} from './prompts.ts';
import { pollMergeReadiness, fetchAllPRStatuses } from './notify.ts';
import {
  pollLinear,
  parseIssueMetadata,
  reconstructIssueFromRun,
  updateLinearStatus,
  commentOnIssue,
} from './poller.ts';
import {
  onSSE,
  broadcastSSE,
  logBuffers,
  bufferLog,
  flushLogs,
  createRunRecord,
  enqueue,
  enqueueWithIssue,
  enqueueRevision,
  enqueueRetry,
  enqueueFix,
  dispatchNextRun,
  pollReviews,
  beginShutdown,
  getRunningCount,
  getQueueLength,
  flushAllLogs,
  buildRetryContext,
  retryContextMap,
} from './queue.ts';
import type { Run, Issue, ProjectConfig, FixType } from './types.ts';

// Re-export poller functions that were previously exported from runner.ts
export { parseIssueMetadata, reconstructIssueFromRun };
// Re-export prompt functions that were previously exported from runner.ts
export { parseReviewFeedback };
// Re-export queue functions for consumers that import from runner.ts
export { createRunRecord, onSSE, logBuffers, beginShutdown, getRunningCount, flushAllLogs, buildRetryContext, enqueueWithIssue, enqueueRevision };

const ulid = monotonicFactory();

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

function commentOnPR(repo: string, prNumber: number, body: string): void {
  Bun.spawn(['gh', 'pr', 'comment', String(prNumber), '--repo', repo, '--body', body], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function getAgentConclusion(runId: string): string | null {
  const entries = logBuffers.get(runId);
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.stream === 'stdout' && entry.content.startsWith('result: ')) {
      return entry.content.slice('result: '.length).trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt building (extracted to agent-prompts.ts)
// ---------------------------------------------------------------------------

export interface AgentSignal {
  status: 'blocked' | 'needs_clarification' | 'impossible';
  reason: string;
}

const VALID_SIGNAL_STATUSES = ['blocked', 'needs_clarification', 'impossible'];

export async function readAgentSignal(worktreePath: string): Promise<AgentSignal | null> {
  const signalPath = join(worktreePath, '.agent-state', 'signal.json');
  try {
    const text = await Bun.file(signalPath).text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof parsed.status === 'string' &&
      VALID_SIGNAL_STATUSES.includes(parsed.status) &&
      typeof parsed.reason === 'string'
    ) {
      return { status: parsed.status as AgentSignal['status'], reason: parsed.reason };
    }
    return null;
  } catch {
    return null;
  }
}

async function clearAgentSignal(worktreePath: string): Promise<void> {
  const signalPath = join(worktreePath, '.agent-state', 'signal.json');
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(signalPath);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Spawn args builder
// ---------------------------------------------------------------------------

export function buildSpawnArgs(prompt: string, model?: string | null): string[] {
  // --verbose is required by claude CLI when using --output-format stream-json
  const args = [config.claudeCodePath, '--print', '--verbose', '--output-format', 'stream-json'];
  if (model) {
    args.push('--model', model);
  }
  args.push(prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

function parseAgentEvent(line: string): string | null {
  try {
    const evt = JSON.parse(line);
    if (evt.type === 'assistant' && evt.message?.content) {
      const parts: string[] = [];
      for (const block of evt.message.content) {
        if (block.type === 'text') parts.push(block.text);
        if (block.type === 'tool_use') parts.push(`tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
      }
      return parts.join('\n') || null;
    }
    if (evt.type === 'result') return `result: ${(evt.result ?? '').slice(0, 500)}`;
    return null;
  } catch {
    return line;
  }
}

async function streamOutput(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  runId: string,
  streamName: 'stdout' | 'stderr',
  onRawLine?: (line: string) => void,
): Promise<void> {
  if (!stream || typeof stream === 'number') return;

  const decoder = new TextDecoder();
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  let partial = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (streamName === 'stderr') {
          bufferLog(runId, streamName, text);
        } else {
          partial += text;
          const lines = partial.split('\n');
          // Last element is either '' (if text ended with \n) or a partial line
          partial = lines.pop()!;
          for (const line of lines) {
            if (!line) continue;
            onRawLine?.(line);
            const readable = parseAgentEvent(line);
            if (readable) {
              bufferLog(runId, streamName, readable);
            }
          }
        }
      }
    }
    // Flush any remaining partial line
    if (partial) {
      onRawLine?.(partial);
      const readable = parseAgentEvent(partial);
      if (readable) {
        bufferLog(runId, streamName, readable);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

async function executeRun(
  run: Run,
  project: ProjectConfig,
  projectKey: string,
  issue: Issue,
): Promise<void> {
  const runId = run.id;
  const tokenTracker = new TokenTracker();
  let worktreePath: string | null = null;
  let projectPath: string | null = null;

  try {
    // Guard: skip if another run for the same issue is already queued/running
    if (hasActiveRunForIssue(issue.id, runId)) {
      bufferLog(runId, 'system', `[runner] Skipping run ${runId} — another run for ${issue.key} is already active`);
      updateRunStatus(runId, 'failed', {
        error_summary: 'Skipped: duplicate run for same issue',
        completed_at: new Date().toISOString(),
      });
      return;
    }

    if (!run.is_fix) {
      updateLinearStatus(issue.key, 'In Progress');
    }
    updateRunStatus(runId, 'running', { started_at: new Date().toISOString() });

    const runningRun = getRun(runId);
    if (runningRun) broadcastSSE({ type: 'run_update', run: runningRun });

    bufferLog(runId, 'system', `[runner] Starting run ${runId} for ${issue.key}`);

    projectPath = await ensureProjectLocal(project, projectKey);
    bufferLog(runId, 'system', `[runner] Project path: ${projectPath}`);

    const slug = ulid().slice(-6).toLowerCase();
    worktreePath = await setupWorktree(projectPath, issue.branch, issue.key, slug);
    bufferLog(runId, 'system', `[runner] Worktree: ${worktreePath}`);

    // For fix runs, rebase BEFORE writing settings (rebase needs clean working tree)
    let earlyRebaseResult: RebaseResult | null = null;
    if (run.is_fix && run.fix_type && run.fix_type !== 'ci_failure') {
      bufferLog(runId, 'system', `[runner] Rebasing onto ${issue.baseBranch} to surface conflict markers`);
      earlyRebaseResult = await rebaseOnto(worktreePath, issue.baseBranch);
    }

    await writeAgentSettings(worktreePath, project.allowedTools);

    let initFailure: string | null = null;
    try {
      await initWorktree(worktreePath, project.init, (stream, content) => bufferLog(runId, stream, content));
    } catch (err) {
      const msg = errorMsg(err);
      initFailure = msg;
      bufferLog(runId, 'system', `[runner] Init failed (non-blocking): ${msg}`);
    }

    await setupAgentState(worktreePath);

    const codebaseSummary = await generateCodebaseSummary(worktreePath);
    bufferLog(runId, 'system', `[runner] Generated codebase summary (${codebaseSummary.length} chars)`);

    let completedSessions = 0;

    if (run.is_fix && run.fix_type) {
      // ─── Fix run: single-session execution ─────────────────────────────
      let errorContext: string;
      if (run.fix_type === 'ci_failure') {
        errorContext = await fetchCIFailureLogs(issue.repo, issue.branch);
      } else {
        const rebaseResult = earlyRebaseResult!;
        if (rebaseResult.success) {
          bufferLog(runId, 'system', `[runner] Rebase succeeded cleanly, force-pushing`);
          await forcePushFromWorktree(worktreePath, issue.branch);
          updateRunStatus(runId, 'success', { completed_at: new Date().toISOString(), pr_url: `https://github.com/${issue.repo}/pull/${run.pr_number}`, pr_number: run.pr_number });
          resolveFixTracking(issue.repo, run.pr_number!, run.fix_type);
          bufferLog(runId, 'system', `[runner] Conflict resolved via clean rebase`);
          return;
        }
        errorContext = `Automatic rebase onto ${issue.baseBranch} failed. Conflict markers are present in the working tree.\n\n${rebaseResult.conflictOutput ?? ''}`;
      }

      let fixPrompt = await buildFixPrompt(issue, worktreePath, { fixType: run.fix_type as FixType, errorContext, attempt: run.fix_attempt, codebaseSummary, projectKey });
      if (initFailure) {
        fixPrompt += `\n\n## Warning: Dependency Install Failed\n\n\`${initFailure}\`\n\nRun the install command yourself before proceeding.`;
      }
      bufferLog(runId, 'system', `[runner] Spawning claude agent for fix`);

      const fixModel = project.fixModel ?? config.defaultFixModel ?? project.model ?? config.defaultModel;
      tokenTracker.setModel(fixModel);
      const agentProc = Bun.spawn(
        buildSpawnArgs(fixPrompt, fixModel),
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
      );
      updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

      const pidRun = getRun(runId);
      if (pidRun) broadcastSSE({ type: 'run_update', run: pidRun });

      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), config.agentTimeoutMs),
      );
      const completion = Promise.all([
        streamOutput(agentProc.stdout, runId, 'stdout', (line) => tokenTracker.parseAndAccumulate(line)),
        streamOutput(agentProc.stderr, runId, 'stderr'),
        agentProc.exited,
      ]).then(() => 'done' as const);

      const result = await Promise.race([completion, timeoutPromise]);

      if (result === 'timeout') {
        bufferLog(runId, 'system', `[runner] Agent timed out after ${config.agentTimeoutMs}ms — killing`);
        agentProc.kill();
        await completion;
        updateRunStatus(runId, 'failed', {
          error_summary: `Agent timed out after ${config.agentTimeoutMs}ms`,
          completed_at: new Date().toISOString(),
        });
        commentOnIssue(issue.key, `Fix agent timed out after ${config.agentTimeoutMs / 1000}s.`);
        const timeoutCost = tokenTracker.estimateCost();
        updateRunTokens(runId, timeoutCost);
        return;
      }

      completedSessions = 1;
    } else {
      // ─── Normal/revision run: multi-session loop ───────────────────────
      let reviewFeedback: string | undefined;
      let prInstructions = '';

      if (run.pr_number) {
        bufferLog(runId, 'system', `[runner] Fetching review comments for PR #${run.pr_number}`);
        const ghProc = Bun.spawn(
          ['gh', 'pr', 'view', String(run.pr_number), '--repo', issue.repo, '--json', 'reviews,comments'],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const [ghOut] = await Promise.all([new Response(ghProc.stdout).text(), ghProc.exited]);
        reviewFeedback = parseReviewFeedback(ghOut);
        prInstructions =
          `\n\n## PR Instructions\n\n` +
          `This is a revision of PR #${run.pr_number}. ` +
          `After committing your changes, the orchestrator will push and update the existing PR automatically. ` +
          `Use \`gh pr review\` to understand reviewer feedback and address all requested changes.`;
      }

      const runStartTime = Date.now();
      let isFirstRun = true;
      let previousSummary: string | undefined;

      // Inject retry context for retry runs (retry_attempt > 0)
      const retryContext = retryContextMap.get(runId);
      if (retryContext) {
        retryContextMap.delete(runId); // Clean up after reading
      }

      for (let iteration = 0; iteration < config.maxSessionIterations; iteration++) {
        const elapsed = Date.now() - runStartTime;
        if (elapsed > config.agentTimeoutMs) {
          bufferLog(runId, 'system', `[runner] Total run timeout (${config.agentTimeoutMs}ms) reached after ${completedSessions} session(s)`);
          break;
        }

        let sessionBase = await buildAgentPrompt(issue, worktreePath!, {
          reviewFeedback: isFirstRun ? reviewFeedback : undefined,
          isFirstSession: isFirstRun,
          codebaseSummary,
          projectKey,
        });

        // Append retry context on the first session of a retry run
        if (isFirstRun && retryContext) {
          sessionBase += '\n\n---\n\n' + retryContext;
        }

        if (isFirstRun && prInstructions) sessionBase += prInstructions;
        if (isFirstRun && initFailure) {
          sessionBase += `\n\n## Warning: Dependency Install Failed\n\n\`${initFailure}\`\n\nRun the install command yourself before proceeding.`;
        }
        const ctx: SessionPromptContext = {
          basePrompt: sessionBase,
          issueKey: issue.key,
          previousSessionSummary: previousSummary,
          hasDesignDoc: !!issue.designPath,
        };
        const prompt = isFirstRun
          ? buildInitializerPrompt(ctx)
          : buildCodingPrompt(ctx);
        isFirstRun = false;

        bufferLog(runId, 'system', `[runner] Starting session ${iteration + 1}/${config.maxSessionIterations}`);

        const runModel = project.model ?? config.defaultModel;
        tokenTracker.setModel(runModel);
        const agentProc = Bun.spawn(
          buildSpawnArgs(prompt, runModel),
          { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
        );

        updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

        const sessionTimeout = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), config.sessionTimeoutMs),
        );

        const completion = Promise.all([
          streamOutput(agentProc.stdout, runId, 'stdout', (line) => tokenTracker.parseAndAccumulate(line)),
          streamOutput(agentProc.stderr, runId, 'stderr'),
          agentProc.exited,
        ]).then(() => 'done' as const);

        const result = await Promise.race([completion, sessionTimeout]);

        if (result === 'timeout') {
          bufferLog(runId, 'system', `[runner] Session ${iteration + 1} timed out after ${config.sessionTimeoutMs}ms — killing`);
          agentProc.kill();
          await completion;
        } else {
          const exitCode = agentProc.exitCode ?? 0;
          bufferLog(runId, 'system', `[runner] Session ${iteration + 1} exited with code ${exitCode}`);
        }

        completedSessions++;
        updateRunIterations(runId, completedSessions);

        broadcastSSE({ type: 'iteration', runId, current: completedSessions, max: config.maxSessionIterations, allDone: false });

        // Check for agent signal
        const signal = await readAgentSignal(worktreePath!);
        if (signal) {
          bufferLog(runId, 'system', `[runner] Agent signaled "${signal.status}": ${signal.reason}`);
          commentOnIssue(issue.key, `Agent signaled **${signal.status}**: ${signal.reason}`);
          await clearAgentSignal(worktreePath!);
          if (signal.status === 'blocked' || signal.status === 'impossible') {
            bufferLog(runId, 'system', `[runner] Breaking loop due to agent signal: ${signal.status}`);
            break;
          }
        }

        const features = await readFeatureList(worktreePath!);
        if (isAllFeaturesDone(features)) {
          bufferLog(runId, 'system', `[runner] All features complete after ${completedSessions} session(s)`);
          broadcastSSE({ type: 'iteration', runId, current: completedSessions, max: config.maxSessionIterations, allDone: true });
          break;
        }

        // Build previous session summary for next iteration
        previousSummary = await buildPreviousSessionSummary(runId, worktreePath!, logBuffers);

        if (iteration < config.maxSessionIterations - 1) {
          bufferLog(runId, 'system', `[runner] Waiting ${config.autoContinueDelayMs}ms before next session`);
          await new Promise((resolve) => setTimeout(resolve, config.autoContinueDelayMs));
        }
      }

      bufferLog(runId, 'system', `[runner] Loop finished after ${completedSessions} session(s)`);
    }

    // Record token usage
    const costEstimate = tokenTracker.estimateCost();
    updateRunTokens(runId, {
      input_tokens: costEstimate.input_tokens,
      output_tokens: costEstimate.output_tokens,
      cache_read_tokens: costEstimate.cache_read_tokens,
      cache_creation_tokens: costEstimate.cache_creation_tokens,
      cost_usd: costEstimate.cost_usd,
    });
    bufferLog(runId, 'system',
      `[runner] Token usage: ${costEstimate.input_tokens} in / ${costEstimate.output_tokens} out ` +
      `(cache: ${costEstimate.cache_read_tokens} read, ${costEstimate.cache_creation_tokens} created) ` +
      `≈ $${costEstimate.cost_usd}`
    );

    const hasCommits = await hasLocalCommits(worktreePath!);

    if (!hasCommits) {
      // If a PR already exists for this issue, the work was done by a prior run.
      // Treat as a no-op success instead of failing.
      const existingPR = getPRNumberByIssueKey(issue.key);
      if (existingPR) {
        const prUrl = `https://github.com/${issue.repo}/pull/${existingPR}`;
        bufferLog(runId, 'system', `[runner] No new commits but PR #${existingPR} already exists — nothing to do`);
        updateRunStatus(runId, 'success', {
          pr_url: prUrl,
          pr_number: existingPR,
          completed_at: new Date().toISOString(),
        });
        updateLinearStatus(issue.key, 'In Review');

        if (run.is_revision) {
          const conclusion = getAgentConclusion(runId);
          const body = conclusion
            ? `Reviewed the feedback — no changes needed.\n\n${conclusion}`
            : `Reviewed the feedback — no changes were necessary.`;
          commentOnPR(issue.repo, existingPR, body);
          bufferLog(runId, 'system', `[runner] Posted review response on PR #${existingPR}`);
        }

        const updatedRun = getRun(runId);
        if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });
        return;
      }
      throw new NonRetryableError(`No commits made after ${completedSessions} session(s) — nothing to push`);
    }

    if (run.is_fix && run.fix_type === 'merge_conflict') {
      // Agent resolved conflicts and staged files; runner continues the rebase
      bufferLog(runId, 'system', `[runner] Continuing rebase after agent conflict resolution`);
      await continueRebase(worktreePath!);
      bufferLog(runId, 'system', `[runner] Force-pushing branch ${issue.branch} (post-rebase)`);
      await forcePushFromWorktree(worktreePath!, issue.branch);
    } else {
      bufferLog(runId, 'system', `[runner] Pushing branch ${issue.branch}`);
      await pushFromWorktree(worktreePath!, issue.branch);
    }

    let prUrl: string;
    if (run.pr_number) {
      prUrl = `https://github.com/${issue.repo}/pull/${run.pr_number}`;
      bufferLog(runId, 'system', `[runner] Updated existing PR: ${prUrl}`);
    } else {
      let prBody = issue.designPath
        ? `Automated implementation for ${issue.key}.\n\nDesign: \`${issue.designPath}\``
        : `Automated implementation for ${issue.key}.`;

      if (issue.parentKey) {
        const parentPR = getPRNumberByIssueKey(issue.parentKey);
        if (parentPR) {
          prBody += `\n\nDepends on #${parentPR}`;
          bufferLog(runId, 'system', `[runner] Linked PR to parent ${issue.parentKey} (PR #${parentPR})`);
        } else {
          bufferLog(runId, 'system', `[runner] Parent ${issue.parentKey} has no PR yet — skipping dependency link`);
        }
      }

      prUrl = await createPR({
        repo: issue.repo,
        base: issue.baseBranch,
        head: issue.branch,
        title: `[${issue.key}] ${issue.title}`,
        body: prBody,
        reviewer: config.githubUsername,
      });
      bufferLog(runId, 'system', `[runner] Created PR: ${prUrl}`);
    }

    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNum = prNumberMatch?.[1] ? parseInt(prNumberMatch[1], 10) : null;

    updateRunStatus(runId, 'success', {
      pr_url: prUrl,
      pr_number: prNum,
      completed_at: new Date().toISOString(),
    });
    if (run.is_fix) {
      commentOnIssue(issue.key, `Fix applied (${run.fix_type}, attempt ${run.fix_attempt}): ${prUrl}`);
      if (run.fix_type) resolveFixTracking(issue.repo, prNum ?? run.pr_number!, run.fix_type);
    } else {
      updateLinearStatus(issue.key, 'In Review');
      commentOnIssue(issue.key, `PR ready for review: ${prUrl}`);
    }

    bufferLog(runId, 'system', `[runner] Run ${runId} completed successfully after ${completedSessions} session(s)`);

    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

    // --- AI Auto-Review Gate ---
    if (
      config.autoReview &&
      !run.is_fix &&
      !run.is_revision &&
      !run.pr_number &&
      run.retry_attempt === 0 &&
      worktreePath
    ) {
      bufferLog(runId, 'system', '[runner] Running AI auto-review gate...');
      try {
        const reviewResult = await reviewRun(issue, worktreePath);
        const issueCount = reviewResult.issues.length;
        const errorCount = reviewResult.issues.filter((i) => i.severity === 'error').length;

        bufferLog(runId, 'system',
          `[runner] Auto-review: ${reviewResult.pass ? 'PASS' : 'FAIL'} — ` +
          `${issueCount} issue(s) (${errorCount} error(s)). ${reviewResult.summary}`
        );

        if (!reviewResult.pass && prNum) {
          // Post review feedback as PR comment — must succeed before revision reads it
          const feedback = formatReviewFeedback(reviewResult);
          const commentArgs = ['gh', 'pr', 'comment', String(prNum), '--repo', issue.repo, '--body', `### AI Auto-Review\n\n${feedback}`];

          let commentPosted = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            const commentProc = Bun.spawn(commentArgs, { stdout: 'pipe', stderr: 'pipe' });
            const commentExitCode = await commentProc.exited;
            if (commentExitCode === 0) {
              commentPosted = true;
              break;
            }
            if (attempt === 0) {
              bufferLog(runId, 'system',
                `[runner] Auto-review: PR comment failed (exit ${commentExitCode}), retrying...`
              );
              await Bun.sleep(2000);
            } else {
              bufferLog(runId, 'system',
                `[runner] Auto-review: PR comment retry failed (exit ${commentExitCode}) — skipping revision`
              );
            }
          }

          if (commentPosted) {
            // Trigger a revision run — AI feedback is now visible on the PR
            const revisionRunId = enqueueRevision(
              updatedRun ?? run,
              prNum,
              issue,
            );
            bufferLog(runId, 'system',
              `[runner] Auto-review failed — enqueued revision ${revisionRunId} with AI feedback`
            );
          }
        }
      } catch (err) {
        bufferLog(runId, 'system',
          `[runner] Auto-review failed (non-fatal): ${errorMsg(err)}`
        );
      }
    }
    // Document the run to obsidian-memory (fire-and-forget, before worktree cleanup)
    if (worktreePath && updatedRun) {
      await documentRun(updatedRun, issue, worktreePath).catch((e) =>
        log.warn(`[runner] Memory documentation failed: ${errorMsg(e)}`),
      );
    }

    // Update project intelligence (fire-and-forget)
    updateProjectIntelligence(projectKey).catch((e) =>
      log.warn(`[runner] Project intelligence update failed: ${errorMsg(e)}`),
    );

  } catch (err) {
    // Record token usage even on failure
    const failCost = tokenTracker.estimateCost();
    if (failCost.input_tokens > 0 || failCost.output_tokens > 0) {
      updateRunTokens(runId, failCost);
    }

    const errorMessage = errorMsg(err);
    bufferLog(runId, 'system', `[runner] Run ${runId} failed: ${errorMessage}`);
    updateRunStatus(runId, 'failed', {
      error_summary: errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    });

    const failedRun = getRun(runId);
    if (failedRun) broadcastSSE({ type: 'run_update', run: failedRun });

    const isNonRetryable = err instanceof NonRetryableError;

    if (!run.is_fix) {
      const nextAttempt = (run.retry_attempt ?? 0) + 1;
      if (!isNonRetryable && nextAttempt <= config.maxRunRetries) {
        const retryLabel = `${nextAttempt}/${config.maxRunRetries}`;
        bufferLog(runId, 'system', `[runner] Scheduling retry ${retryLabel} in ${config.runRetryDelayMs / 1000}s...`);
        commentOnIssue(issue.key, `Run failed (attempt ${nextAttempt}/${config.maxRunRetries}). Retrying in ${config.runRetryDelayMs / 1000}s...\nError: ${errorMessage.slice(0, 150)}`);

        // Insert retry run into DB immediately (blocks poll loop from re-spawning),
        // but delay adding it to the in-memory queue.
        // Pass failedRun (has error_summary) so buildRetryContext can read it.
        const retryRunId = enqueueRetry(failedRun ?? run, issue, config.runRetryDelayMs);
        if (retryRunId) {
          log.info(`[runner] Enqueued retry ${retryLabel} as run ${retryRunId} for ${issue.key}`);
        }
      } else {
        updateLinearStatus(issue.key, 'Failed');
        const reason = isNonRetryable
          ? `Agent run failed (non-retryable): ${errorMessage.slice(0, 200)}`
          : `Agent run failed after ${config.maxRunRetries} retries. Manual investigation needed.\nLast error: ${errorMessage.slice(0, 200)}`;
        commentOnIssue(issue.key, reason);
        bufferLog(runId, 'system', isNonRetryable
          ? `[runner] Non-retryable failure for ${issue.key}: ${errorMessage}`
          : `[runner] All ${config.maxRunRetries} retries exhausted for ${issue.key}`);
      }
    } else {
      commentOnIssue(issue.key, `Fix attempt failed (${run.fix_type}, attempt ${run.fix_attempt}): ${errorMessage.slice(0, 200)}`);
    }

    // Document failed run to obsidian-memory (before worktree cleanup)
    if (worktreePath && failedRun) {
      await documentRun(failedRun, issue, worktreePath).catch((e) =>
        log.warn(`[runner] Memory documentation failed: ${errorMsg(e)}`),
      );
    }

    // Update intelligence even for failed runs (failure patterns are valuable)
    updateProjectIntelligence(projectKey).catch((e) =>
      log.warn(`[runner] Project intelligence update failed: ${errorMsg(e)}`),
    );

  } finally {
    flushLogs(runId);
    retryContextMap.delete(runId); // Clean up in case it wasn't consumed
    if (projectPath && worktreePath) {
      cleanupWorktree(projectPath, worktreePath).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export function startRunner(): void {
  log.info('[runner] Starting orchestration engine');

  // Mark any runs that were "running" when the process last died as failed
  markStaleRunsFailed();

  // Re-enqueue any runs that are still "queued" in DB (survive restarts)
  const queuedRuns = getRunsByStatus('queued');
  if (queuedRuns.length > 0) {
    log.info(`[runner] Re-queuing ${queuedRuns.length} persisted queued run(s)`);
    // Issue metadata is persisted in the runs table (design_path, issue_repo, base_branch),
    // so dispatchNextRun() will reconstruct it via getIssueForRun() on the DB-fetched run.
    for (const run of queuedRuns) {
      enqueue(run);
    }
  }

  // Start periodic log flush interval
  setInterval(() => {
    for (const runId of logBuffers.keys()) {
      flushLogs(runId);
    }
  }, config.logFlushIntervalMs);

  // Poll Linear for new issues
  setInterval(async () => {
    try {
      const issues = await pollLinear();

      for (const linearIssue of issues) {
        let meta: ReturnType<typeof parseIssueMetadata>;
        try {
          meta = parseIssueMetadata(linearIssue.description ?? '');
        } catch (err) {
          log.warn(`[runner] poll: invalid metadata in issue ${linearIssue.identifier}: ${errorMsg(err)}`);
          continue;
        }
        if (!meta) continue;

        const resolved = resolveProject(meta.repo);
        if (!resolved) {
          log.warn(`[runner] poll: no project config for repo "${meta.repo}" (issue ${linearIssue.identifier})`);
          continue;
        }

        const issue: Issue = {
          id: linearIssue.id,
          key: linearIssue.identifier,
          title: linearIssue.title,
          description: linearIssue.description,
          designPath: meta.designPath,
          branch: meta.branch,
          repo: meta.repo,
          baseBranch: resolved.project.baseBranch,
          parentKey: linearIssue.parent?.identifier ?? null,
        };

        const worktreePath = join(
          (resolved.project.path ?? join(
            process.env.HOME ?? '~',
            '.local', 'share', 'agent-orchestrator', 'repos', resolved.key,
          )),
          '.worktrees',
          `agent-${issue.key}-pending`,
        );

        const run = createRunRecord({
          project: resolved.key,
          issue_id: issue.id,
          issue_key: issue.key,
          issue_title: issue.title,
          branch: issue.branch,
          worktree_path: worktreePath,
          design_path: issue.designPath,
          issue_repo: issue.repo,
          base_branch: issue.baseBranch,
        });

        // Skip if there's already an active (queued/running) run for this issue
        if (hasActiveRunForIssue(issue.id)) continue;

        // insertRun uses INSERT OR IGNORE as a secondary safeguard
        insertRun(run);

        const fullRun = getRun(run.id);
        if (!fullRun) continue; // was a duplicate, already queued/running

        enqueueWithIssue(fullRun, issue);
        broadcastSSE({ type: 'run_update', run: fullRun });

        log.info(`[runner] Enqueued run ${run.id} for ${issue.key}`);
      }
    } catch (err) {
      log.error('[runner] Poll error:', err);
    }
  }, config.pollIntervalMs);

  // Poll GitHub for new PR reviews
  setInterval(async () => {
    try {
      await pollReviews();
    } catch (err) {
      log.error('[reviewer] Poll error:', err);
    }
  }, config.reviewPollIntervalMs);

  // Unified PR polling: merge-readiness notifications + auto-fix detection
  setInterval(async () => {
    try {
      const prStatuses = await fetchAllPRStatuses();
      await pollMergeReadiness(prStatuses);
      await pollFixable(
        (run, issue, fixType, errorContext) => {
          const tracking = getFixTracking(issue.repo, run.pr_number!, fixType);
          const attempt = (tracking?.attempt_count ?? 0) + 1;
          const fixRunId = enqueueFix(run, run.pr_number!, issue, fixType, attempt);
          if (fixRunId) {
            log.info(`[fixer] Enqueued ${fixType} fix ${fixRunId} for PR #${run.pr_number} (${errorContext})`);
          }
        },
        prStatuses,
      );
    } catch (err) {
      log.error('[notify/fixer] Poll error:', err);
    }
  }, config.fixPollIntervalMs);

  // Dispatch queued runs every 5 seconds
  setInterval(() => {
    dispatchNextRun(executeRun).catch((err) => log.error('[runner] dispatch error:', err));
  }, 5_000);

  // Snapshot DB on startup
  try {
    const snap = snapshotDatabase(config.maxSnapshots);
    if (snap) log.info(`[runner] DB snapshot saved: ${snap}`);
  } catch (err) {
    log.error('[runner] DB snapshot failed:', err);
  }

  // Database cleanup: periodic retention enforcement
  setInterval(runCleanup, config.cleanupIntervalMs);
  setTimeout(runCleanup, 30_000);

  // Heartbeat: log orchestrator status every 60s
  setInterval(() => {
    log.info(
      `[heartbeat] queue=${getQueueLength()} running=${getRunningCount()}/${config.maxConcurrentAgents}`,
    );
  }, 60_000);

  log.info(
    `[runner] Running. Poll interval: ${config.pollIntervalMs}ms, ` +
    `review poll: ${config.reviewPollIntervalMs}ms, ` +
    `fix poll: ${config.fixPollIntervalMs}ms, ` +
    `max concurrent: ${config.maxConcurrentAgents}, ` +
    `max fix retries: ${config.maxFixRetries}, ` +
    `timeout: ${config.agentTimeoutMs}ms`,
  );
}

function runCleanup(): void {
  try {
    // Snapshot before deleting anything
    const snap = snapshotDatabase(config.maxSnapshots);
    if (snap) log.info(`[cleanup] DB snapshot: ${snap}`);

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

    log.info(
      `[cleanup] Deleted ${logsDeleted} logs, ${runsDeleted} runs, ` +
      `${reviewsDeleted} reviews, ${notificationsDeleted} notifications. ` +
      `DB size: ${Math.round(sizeAfter / 1024)}KB (freed ${savedKB}KB)`
    );
  } catch (err) {
    log.error('[cleanup] Error during cleanup:', err);
  }
}
