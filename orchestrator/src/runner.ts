import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { config } from './config.ts';
import {
  insertRun,
  insertLog,
  updateRunStatus,
  updateRunIterations,
  getRun,
  getRunByBranch,
  getRunsByStatus,
  markStaleRunsFailed,
  isReviewProcessed,
  markReviewProcessed,
  getWatchableRuns,
  getFixTracking,
  upsertFixTracking,
  markFixExhausted,
  clearFixTracking,
  getRunByPRNumber,
  getIssueForRun,
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
  abortRebase,
  forcePushFromWorktree,
} from './git.ts';
import { initWorktree } from './init.ts';
import {
  buildInitializerPrompt,
  buildCodingPrompt,
  readFeatureList,
  isAllFeaturesDone,
  type SessionPromptContext,
} from './prompts.ts';
import { pollMergeReadiness, fetchAllPRStatuses, checkFixNeeded, sendFixExhaustedNotification } from './notify.ts';
import type {
  Run,
  Issue,
  LinearIssue,
  ParsedIssueMetadata,
  ProjectConfig,
  ProjectsConfig,
  SSEEvent,
  FixType,
} from './types.ts';

const ulid = monotonicFactory();

// ---------------------------------------------------------------------------
// SSE broadcaster hook
// ---------------------------------------------------------------------------

let _sseHandler: ((event: SSEEvent) => void) | null = null;

export function onSSE(handler: (event: SSEEvent) => void): void {
  _sseHandler = handler;
}

function broadcastSSE(event: SSEEvent): void {
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

// Start periodic flush interval
setInterval(() => {
  for (const runId of logBuffers.keys()) {
    flushLogs(runId);
  }
}, config.logFlushIntervalMs);

// ---------------------------------------------------------------------------
// Linear interaction
// ---------------------------------------------------------------------------

async function runLineark(args: string[]): Promise<string> {
  const proc = Bun.spawn(['lineark', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [rawOut, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`lineark ${args[0]} failed (exit ${exitCode}): ${errText.trim()}`);
  }
  return rawOut;
}

export async function pollLinear(): Promise<LinearIssue[]> {
  // Step 1: List issues (lean output — has identifier + state but no id/description)
  const listOut = await runLineark(['issues', 'list', '--format', 'json']);
  let summaries: Array<Record<string, unknown>>;
  try {
    summaries = JSON.parse(listOut);
  } catch {
    throw new Error(`Failed to parse lineark list output: ${listOut.slice(0, 200)}`);
  }

  // Filter to "Ready for Agent" state
  const ready = summaries.filter((s) => s.state === 'Ready for Agent');
  if (ready.length === 0) return [];

  // Step 2: Read full details for each matching issue (has id + description)
  const issues: LinearIssue[] = [];
  for (const summary of ready) {
    const identifier = summary.identifier as string;
    const readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
    let full: Record<string, unknown>;
    try {
      full = JSON.parse(readOut);
    } catch {
      console.warn(`[runner] Failed to parse lineark read for ${identifier}`);
      continue;
    }

    if (
      typeof full.description === 'string' &&
      full.description.includes('design:')
    ) {
      issues.push({
        id: full.id as string,
        identifier: full.identifier as string,
        title: full.title as string,
        description: full.description as string,
      });
    }
  }

  return issues;
}

export function parseIssueMetadata(description: string): ParsedIssueMetadata | null {
  // Try structured format first (from submit.sh): "design: ...\nbranch: ...\nrepo: ..."
  const designMatch = description.match(/^design:\s*(.+)$/im);
  const branchMatch = description.match(/^branch:\s*(.+)$/im);
  const repoMatch = description.match(/^repo:\s*(.+)$/im);

  const designPath = designMatch?.[1]?.trim();
  const branch = branchMatch?.[1]?.trim();
  const repo = repoMatch?.[1]?.trim();

  if (designPath && branch && repo) {
    return { designPath, branch, repo };
  }

  // Fallback: extract from prose-style descriptions
  const proseDesign = description.match(/design\s*doc:\s*([\w/._-]+\.md)/i);
  const proseBranch = description.match(/branch\s+([\w/\-]+(?:\/[\w/\-]+)*)/i);
  const proseRepo = description.match(/repo:\s*([\w/._-]+)/i)
    ?? description.match(/repo[.:]?\s*([\w-]+\/[\w._-]+)/i);

  const pd = proseDesign?.[1]?.trim();
  const pb = proseBranch?.[1]?.trim();
  const pr = proseRepo?.[1]?.trim();

  if (!pd || !pb || !pr) return null;

  return { designPath: pd, branch: pb, repo: pr };
}

export function updateLinearStatus(key: string, state: string): void {
  // Fire and forget
  Bun.spawn(['lineark', 'issues', 'update', key, '-s', state], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export function commentOnIssue(key: string, message: string): void {
  // Fire and forget
  Bun.spawn(['lineark', 'comments', 'create', key, '--body', message], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

let _projectsCache: ProjectsConfig | null = null;
let _projectsMtime: number = 0;

export function loadProjects(): ProjectsConfig {
  const stat = statSync(config.projectsConfigPath);
  const mtime = stat.mtimeMs;
  if (_projectsCache && mtime === _projectsMtime) {
    return _projectsCache;
  }
  const raw = readFileSync(config.projectsConfigPath, 'utf-8');
  _projectsCache = JSON.parse(raw) as ProjectsConfig;
  _projectsMtime = mtime;
  return _projectsCache;
}

export function resolveProject(
  repo: string,
): { key: string; project: ProjectConfig } | null {
  const projects = loadProjects();

  for (const [key, project] of Object.entries(projects)) {
    if (project.repo === repo) {
      return { key, project };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Issue reconstruction (from DB run record via Linear)
// ---------------------------------------------------------------------------

export async function reconstructIssueFromRun(run: Run): Promise<Issue> {
  const readOut = await runLineark(['issues', 'read', run.issue_key, '--format', 'json']);

  let linearIssue: Record<string, unknown>;
  try {
    linearIssue = JSON.parse(readOut);
  } catch {
    throw new Error(`Failed to parse Linear issue for ${run.issue_key}`);
  }

  const meta = parseIssueMetadata((linearIssue.description as string) ?? '');
  if (!meta) {
    throw new Error(`Could not parse issue metadata from ${run.issue_key} description`);
  }

  const resolved = resolveProject(meta.repo);
  if (!resolved) {
    throw new Error(`Project not found for repo: ${meta.repo}`);
  }

  return {
    id: linearIssue.id as string,
    key: run.issue_key,
    title: run.issue_title,
    description: linearIssue.description as string,
    designPath: meta.designPath,
    branch: meta.branch,
    repo: meta.repo,
    baseBranch: resolved.project.baseBranch,
  };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

async function fileExistsAndRead(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return file.text();
}

export function buildRulesSection(issue: Issue, isRevision: boolean): string {
  const lines: string[] = [
    '## Agent Rules',
    '',
    `- **Branch**: \`${issue.branch}\``,
    `- **Issue**: ${issue.key} — ${issue.title}`,
    '- All commits must reference the issue key in the message, e.g. `[${issue.key}] feat: description`.',
    '- Only modify files relevant to the scope described in the design document.',
    '- Do not modify unrelated files, configuration, or documentation outside the design scope.',
    '- Do not push — the orchestrator handles git push.',
    '- Stage and commit your changes using `git add` and `git commit`.',
  ];

  if (isRevision) {
    lines.push('- This is a **revision run**. Address the review feedback below before making new commits.');
  }

  return lines.join('\n');
}

export async function buildAgentPrompt(
  issue: Issue,
  worktreePath: string,
  reviewFeedback?: string,
): Promise<string> {
  const sections: string[] = [];

  // 1. Global prompt
  const globalPrompt = await fileExistsAndRead(config.globalPromptPath);
  if (globalPrompt) sections.push(globalPrompt.trim());

  // 2. CLAUDE.md from worktree (project-level instructions)
  const claudeMd = await fileExistsAndRead(join(worktreePath, 'CLAUDE.md'));
  if (claudeMd) sections.push(claudeMd.trim());

  // 3. Design doc from worktree
  const designDocPath = join(worktreePath, issue.designPath);
  const designDoc = await fileExistsAndRead(designDocPath);
  if (designDoc) sections.push(designDoc.trim());

  // 4. Issue context
  const contextLines: string[] = [
    `## Task`,
    '',
    `**Issue**: ${issue.key} — ${issue.title}`,
  ];

  if (reviewFeedback) {
    contextLines.push('', '## Review Feedback', '', reviewFeedback.trim());
  }

  sections.push(contextLines.join('\n'));

  // 5. Rules
  sections.push(buildRulesSection(issue, !!reviewFeedback));

  return sections.join('\n\n---\n\n');
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
): Promise<void> {
  if (!stream || typeof stream === 'number') return;

  const decoder = new TextDecoder();
  const reader = (stream as ReadableStream<Uint8Array>).getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (streamName === 'stderr') {
          bufferLog(runId, streamName, text);
          process.stderr.write(text);
        } else {
          for (const line of text.split('\n').filter(Boolean)) {
            const readable = parseAgentEvent(line);
            if (readable) {
              bufferLog(runId, streamName, readable);
              console.log(`[agent] ${readable}`);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// CI failure log fetching
// ---------------------------------------------------------------------------

async function fetchCIFailureLogs(repo: string, branch: string): Promise<string> {
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

  let runs: Array<{ databaseId: number; name: string }>;
  try {
    runs = JSON.parse(listOut);
  } catch {
    return 'Could not parse CI run list.';
  }

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

async function buildFixPrompt(
  issue: Issue,
  worktreePath: string,
  fixType: FixType,
  errorContext: string,
  attempt: number,
): Promise<string> {
  // Build the base prompt (global + CLAUDE.md + design doc + issue context)
  const basePrompt = await buildAgentPrompt(issue, worktreePath);

  const typeLabel = fixType === 'merge_conflict' ? 'Merge Conflict' : 'CI/CD Failure';

  const fixSection = [
    '## Fix Task',
    '',
    `**Type**: ${typeLabel}`,
    `**Attempt**: ${attempt} of ${config.maxFixRetries}`,
    '',
    '### Error Context',
    '',
    errorContext,
    '',
    '### Instructions',
    '',
    fixType === 'merge_conflict'
      ? 'A rebase is in progress and conflict markers are present in the working tree. Resolve all conflicts in the affected files, then stage and continue the rebase:\n1. Edit each conflicted file to resolve the conflict markers (<<<<<<< / ======= / >>>>>>>).\n2. Run `git add <file>` for each resolved file.\n3. Run `git rebase --continue` to complete the rebase.\n4. Do NOT run `git commit` — the rebase continuation handles the commit.'
      : 'Fix the CI/CD failure described above. Read the error logs carefully, identify the root cause, make the necessary code changes, and commit the fix.',
    '',
    '- Do not push — the orchestrator handles git push.',
    `- Reference the issue key in your commit message: [${issue.key}] fix: description`,
  ].join('\n');

  return basePrompt + '\n\n---\n\n' + fixSection;
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

export async function executeRun(
  run: Run,
  project: ProjectConfig,
  projectKey: string,
  issue: Issue,
): Promise<void> {
  const runId = run.id;
  let worktreePath: string | null = null;
  let projectPath: string | null = null;

  try {
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

    await writeAgentSettings(worktreePath);
    await initWorktree(worktreePath, project.init, runId, bufferLog);

    await setupAgentState(worktreePath);

    let completedSessions = 0;

    if (run.is_fix && run.fix_type) {
      // ─── Fix run: single-session execution ─────────────────────────────
      let errorContext: string;
      if (run.fix_type === 'ci_failure') {
        errorContext = await fetchCIFailureLogs(issue.repo, issue.branch);
      } else {
        bufferLog(runId, 'system', `[runner] Rebasing onto ${issue.baseBranch} to surface conflict markers`);
        const rebaseResult = await rebaseOnto(worktreePath, issue.baseBranch);
        if (rebaseResult.success) {
          bufferLog(runId, 'system', `[runner] Rebase succeeded cleanly, force-pushing`);
          await forcePushFromWorktree(worktreePath, issue.branch);
          updateRunStatus(runId, 'success', { completed_at: new Date().toISOString(), pr_url: `https://github.com/${issue.repo}/pull/${run.pr_number}`, pr_number: run.pr_number });
          clearFixTracking(issue.repo, run.pr_number!, run.fix_type);
          bufferLog(runId, 'system', `[runner] Conflict resolved via clean rebase`);
          return;
        }
        errorContext = `Automatic rebase onto ${issue.baseBranch} failed. Conflict markers are present in the working tree.\n\n${rebaseResult.conflictOutput ?? ''}`;
      }

      const fixPrompt = await buildFixPrompt(issue, worktreePath, run.fix_type as FixType, errorContext, run.fix_attempt);
      bufferLog(runId, 'system', `[runner] Spawning claude agent for fix`);

      const agentProc = Bun.spawn(
        [config.claudeCodePath, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', fixPrompt],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
      );
      updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

      const pidRun = getRun(runId);
      if (pidRun) broadcastSSE({ type: 'run_update', run: pidRun });

      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), config.agentTimeoutMs),
      );
      const completion = Promise.all([
        streamOutput(agentProc.stdout, runId, 'stdout'),
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
        reviewFeedback = ghOut.trim() || undefined;
        prInstructions =
          `\n\n## PR Instructions\n\n` +
          `This is a revision of PR #${run.pr_number}. ` +
          `After committing your changes, the orchestrator will push and update the existing PR automatically. ` +
          `Use \`gh pr review\` to understand reviewer feedback and address all requested changes.`;
      }

      const basePrompt = (await buildAgentPrompt(issue, worktreePath, reviewFeedback)) + prInstructions;
      const ctx: SessionPromptContext = { basePrompt, issueKey: issue.key };

      const runStartTime = Date.now();
      let isFirstRun = true;

      for (let iteration = 0; iteration < config.maxSessionIterations; iteration++) {
        const elapsed = Date.now() - runStartTime;
        if (elapsed > config.agentTimeoutMs) {
          bufferLog(runId, 'system', `[runner] Total run timeout (${config.agentTimeoutMs}ms) reached after ${completedSessions} session(s)`);
          break;
        }

        const prompt = isFirstRun
          ? buildInitializerPrompt(ctx)
          : buildCodingPrompt(ctx);
        isFirstRun = false;

        bufferLog(runId, 'system', `[runner] Starting session ${iteration + 1}/${config.maxSessionIterations}`);

        const agentProc = Bun.spawn(
          [config.claudeCodePath, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', prompt],
          { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
        );

        updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

        const sessionTimeout = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), config.sessionTimeoutMs),
        );

        const completion = Promise.all([
          streamOutput(agentProc.stdout, runId, 'stdout'),
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

        const features = await readFeatureList(worktreePath!);
        if (isAllFeaturesDone(features)) {
          bufferLog(runId, 'system', `[runner] All features complete after ${completedSessions} session(s)`);
          broadcastSSE({ type: 'iteration', runId, current: completedSessions, max: config.maxSessionIterations, allDone: true });
          break;
        }

        if (iteration < config.maxSessionIterations - 1) {
          bufferLog(runId, 'system', `[runner] Waiting ${config.autoContinueDelayMs}ms before next session`);
          await new Promise((resolve) => setTimeout(resolve, config.autoContinueDelayMs));
        }
      }

      bufferLog(runId, 'system', `[runner] Loop finished after ${completedSessions} session(s)`);
    }

    const hasCommits = await hasLocalCommits(worktreePath!);

    if (!hasCommits) {
      throw new Error(`No commits made after ${completedSessions} session(s) — nothing to push`);
    }

    if (run.is_fix && run.fix_type === 'merge_conflict') {
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
      prUrl = await createPR({
        repo: issue.repo,
        base: issue.baseBranch,
        head: issue.branch,
        title: `[${issue.key}] ${issue.title}`,
        body: `Automated implementation for ${issue.key}.\n\nDesign: \`${issue.designPath}\``,
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
      if (run.fix_type) clearFixTracking(issue.repo, prNum ?? run.pr_number!, run.fix_type);
    } else {
      updateLinearStatus(issue.key, 'In Review');
      commentOnIssue(issue.key, `PR ready for review: ${prUrl}`);
    }

    bufferLog(runId, 'system', `[runner] Run ${runId} completed successfully after ${completedSessions} session(s)`);

    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    bufferLog(runId, 'system', `[runner] Run ${runId} failed: ${errorMessage}`);
    updateRunStatus(runId, 'failed', {
      error_summary: errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    });
    if (run.is_fix) {
      commentOnIssue(issue.key, `Fix attempt failed (${run.fix_type}, attempt ${run.fix_attempt}): ${errorMessage.slice(0, 200)}`);
    } else {
      updateLinearStatus(issue.key, 'Failed');
      commentOnIssue(issue.key, `Agent run failed: ${errorMessage.slice(0, 200)}`);
    }

    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

  } finally {
    flushLogs(runId);
    if (projectPath && worktreePath) {
      cleanupWorktree(projectPath, worktreePath).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

const queue: Run[] = [];
let running = 0;

// Sidecar map: runId -> Issue (kept in memory for the lifetime of the queue item)
const issueMap: Map<string, Issue> = new Map();

export function enqueue(run: Run): void {
  queue.push(run);
}

export function enqueueWithIssue(run: Run, issue: Issue): void {
  issueMap.set(run.id, issue);
  enqueue(run);
}

export function enqueueRevision(originalRun: Run, prNumber: number, issue: Issue): string {
  const newRun: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
    id: ulid(),
    project: originalRun.project,
    issue_id: originalRun.issue_id,
    issue_key: originalRun.issue_key,
    issue_title: originalRun.issue_title,
    branch: originalRun.branch,
    worktree_path: originalRun.worktree_path,
    status: 'queued',
    is_revision: 1,
    is_fix: 0,
    fix_type: null,
    fix_attempt: 0,
    pr_number: prNumber,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    design_path: issue.designPath,
    issue_repo: issue.repo,
    base_branch: issue.baseBranch,
  };

  insertRun(newRun);

  // getRun to get the full record with timestamps
  const fullRun = getRun(newRun.id);
  if (fullRun) {
    enqueueWithIssue(fullRun, issue);
    broadcastSSE({ type: 'run_update', run: fullRun });
  }

  return newRun.id;
}

export function enqueueFix(
  originalRun: Run,
  prNumber: number,
  issue: Issue,
  fixType: FixType,
  attempt: number,
): string {
  const newRun: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
    id: ulid(),
    project: originalRun.project,
    issue_id: originalRun.issue_id,
    issue_key: originalRun.issue_key,
    issue_title: originalRun.issue_title,
    branch: originalRun.branch,
    worktree_path: originalRun.worktree_path,
    status: 'queued',
    is_revision: 0,
    is_fix: 1,
    fix_type: fixType,
    fix_attempt: attempt,
    pr_number: prNumber,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    design_path: issue.designPath,
    issue_repo: issue.repo,
    base_branch: issue.baseBranch,
  };

  insertRun(newRun);

  const fullRun = getRun(newRun.id);
  if (fullRun) {
    enqueueWithIssue(fullRun, issue);
    broadcastSSE({ type: 'run_update', run: fullRun });
  }

  upsertFixTracking(issue.repo, prNumber, fixType, newRun.id);

  return newRun.id;
}

export async function tick(): Promise<void> {
  if (running >= config.maxConcurrentAgents) return;
  if (queue.length === 0) return;

  const run = queue.shift()!;
  running++;

  // Look up issue metadata: try in-memory map first (for in-flight runs),
  // then fall back to DB-persisted columns (for runs surviving a restart).
  let issueData = issueMap.get(run.id);
  if (!issueData) {
    issueData = getIssueForRun(run) ?? undefined;
  }

  if (!issueData) {
    console.error(`[runner] tick: no issue data for run ${run.id}`);
    updateRunStatus(run.id, 'failed', {
      error_summary: 'Internal: issue metadata not found for run',
      completed_at: new Date().toISOString(),
    });
    running--;
    return;
  }

  // Resolve project config
  const resolved = resolveProject(issueData.repo);

  if (!resolved) {
    console.error(`[runner] tick: could not resolve project for repo "${issueData.repo}" (run ${run.id})`);
    updateRunStatus(run.id, 'failed', {
      error_summary: `Project not found in registry for repo: ${issueData.repo}`,
      completed_at: new Date().toISOString(),
    });
    running--;
    return;
  }

  // Fire and forget
  executeRun(run, resolved.project, resolved.key, issueData)
    .catch((err) => {
      console.error(`[runner] Unhandled error in executeRun for ${run.id}:`, err);
    })
    .finally(() => {
      running--;
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

      let prData: { state?: string; reviews?: Array<Record<string, unknown>> };
      try {
        prData = JSON.parse(ghOut);
      } catch {
        continue;
      }

      // Stop watching closed/merged PRs
      if (prData.state !== 'OPEN') continue;

      for (const review of prData.reviews ?? []) {
        const reviewId = review.id as string | undefined;
        if (!reviewId) continue;

        const state = ((review.state as string) ?? '').toLowerCase();
        const body = ((review.body as string) ?? '').trim();
        const reviewAuthor = (review.author as Record<string, unknown>)?.login as string | undefined;

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

        // Mark review as processed
        markReviewProcessed(reviewId, run.pr_number!, repo, revisionRunId);

        console.log(
          `[reviewer] Enqueued revision ${revisionRunId} for PR #${run.pr_number} ` +
          `(review ${reviewId}, state: ${state})`
        );

        // Only process one new review per PR per cycle
        break;
      }
    } catch (err) {
      console.error(`[reviewer] Error checking PR for run ${run.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-fix polling
// ---------------------------------------------------------------------------

export async function pollFixable(prStatuses?: Map<string, import('./notify.ts').GHPRView[]>): Promise<void> {
  const allStatuses = prStatuses ?? await fetchAllPRStatuses();

  for (const [repo, prs] of allStatuses) {
    for (const pr of prs) {
      try {
        const fixNeeded = checkFixNeeded(pr);
        if (!fixNeeded) {
          // PR is healthy — clear any existing fix tracking
          clearFixTracking(repo, pr.number, 'merge_conflict');
          clearFixTracking(repo, pr.number, 'ci_failure');
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

        const currentAttempt = (tracking?.attempt_count ?? 0) + 1;

        if (currentAttempt > config.maxFixRetries) {
          markFixExhausted(repo, pr.number, fixType);
          await sendFixExhaustedNotification(
            repo, pr.number, pr.title, pr.url, fixType, config.maxFixRetries,
          );
          console.log(`[fixer] Fix attempts exhausted for PR #${pr.number} in ${repo} (${fixType})`);
          continue;
        }

        // Reconstruct issue from original run
        const issue = await reconstructIssueFromRun(originalRun);

        if (fixType === 'merge_conflict') {
          // Try automatic rebase first
          console.log(`[fixer] Attempting rebase for PR #${pr.number} in ${repo}`);
          if (!resolved) continue;

          const projectPath = await ensureProjectLocal(resolved.project, resolved.key);
          const slug = ulid().slice(-6).toLowerCase();
          const worktreePath = await setupWorktree(projectPath, issue.branch, issue.key, slug);

          try {
            const rebaseResult = await rebaseOnto(worktreePath, issue.baseBranch);

            if (rebaseResult.success) {
              // Rebase succeeded cleanly — force push
              await forcePushFromWorktree(worktreePath, issue.branch);
              clearFixTracking(repo, pr.number, fixType);
              console.log(`[fixer] Auto-rebase succeeded for PR #${pr.number} in ${repo}`);
            } else {
              // Rebase failed — abort and spawn agent
              await abortRebase(worktreePath);
              const fixRunId = enqueueFix(originalRun, pr.number, issue, fixType, currentAttempt);
              console.log(`[fixer] Enqueued conflict fix ${fixRunId} for PR #${pr.number} (attempt ${currentAttempt}/${config.maxFixRetries})`);
            }
          } finally {
            cleanupWorktree(projectPath, worktreePath).catch(() => {});
          }
        } else {
          // CI failure — spawn agent (it will fetch CI logs in its prompt)
          console.log(`[fixer] CI failure detected for PR #${pr.number} in ${repo}`);
          const fixRunId = enqueueFix(originalRun, pr.number, issue, 'ci_failure', currentAttempt);
          console.log(`[fixer] Enqueued CI fix ${fixRunId} for PR #${pr.number} (attempt ${currentAttempt}/${config.maxFixRetries})`);
        }
      } catch (err) {
        console.error(`[fixer] Error checking PR #${pr.number} in ${repo}:`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export function startRunner(): void {
  console.log('[runner] Starting orchestration engine');

  // Mark any runs that were "running" when the process last died as failed
  markStaleRunsFailed();

  // Re-enqueue any runs that are still "queued" in DB (survive restarts)
  const queuedRuns = getRunsByStatus('queued');
  if (queuedRuns.length > 0) {
    console.log(`[runner] Re-queuing ${queuedRuns.length} persisted queued run(s)`);
    // Issue metadata is persisted in the runs table (design_path, issue_repo, base_branch),
    // so tick() will reconstruct it via getIssueForRun() on the DB-fetched run.
    for (const run of queuedRuns) {
      enqueue(run);
    }
  }

  // Poll Linear for new issues
  setInterval(async () => {
    try {
      const issues = await pollLinear();

      for (const linearIssue of issues) {
        const meta = parseIssueMetadata(linearIssue.description ?? '');
        if (!meta) continue;

        const resolved = resolveProject(meta.repo);
        if (!resolved) {
          console.warn(`[runner] poll: no project config for repo "${meta.repo}" (issue ${linearIssue.identifier})`);
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
        };

        const worktreePath = join(
          (resolved.project.path ?? join(
            process.env.HOME ?? '~',
            '.local', 'share', 'agent-orchestrator', 'repos', resolved.key,
          )),
          '.worktrees',
          `agent-${issue.key}-pending`,
        );

        const runId = ulid();
        const run: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
          id: runId,
          project: resolved.key,
          issue_id: issue.id,
          issue_key: issue.key,
          issue_title: issue.title,
          branch: issue.branch,
          worktree_path: worktreePath,
          status: 'queued',
          is_revision: 0,
          is_fix: 0,
          fix_type: null,
          fix_attempt: 0,
          pr_number: null,
          agent_pid: null,
          iterations: 0,
          error_summary: null,
          pr_url: null,
          design_path: issue.designPath,
          issue_repo: issue.repo,
          base_branch: issue.baseBranch,
        };

        // insertRun uses INSERT OR IGNORE on (issue_id, status) for 'queued'/'running',
        // so duplicate polls are safely ignored.
        insertRun(run);

        const fullRun = getRun(runId);
        if (!fullRun) continue; // was a duplicate, already queued/running

        enqueueWithIssue(fullRun, issue);
        broadcastSSE({ type: 'run_update', run: fullRun });

        console.log(`[runner] Enqueued run ${runId} for ${issue.key}`);
      }
    } catch (err) {
      console.error('[runner] Poll error:', err);
    }
  }, config.pollIntervalMs);

  // Poll GitHub for new PR reviews
  setInterval(async () => {
    try {
      await pollReviews();
    } catch (err) {
      console.error('[reviewer] Poll error:', err);
    }
  }, config.reviewPollIntervalMs);

  // Unified PR polling: merge-readiness notifications + auto-fix detection
  setInterval(async () => {
    try {
      const prStatuses = await fetchAllPRStatuses();
      await pollMergeReadiness(prStatuses);
      await pollFixable(prStatuses);
    } catch (err) {
      console.error('[notify/fixer] Poll error:', err);
    }
  }, config.fixPollIntervalMs);

  // Tick every 5 seconds to dispatch queued runs
  setInterval(() => {
    tick().catch((err) => console.error('[runner] tick error:', err));
  }, 5_000);

  console.log(
    `[runner] Running. Poll interval: ${config.pollIntervalMs}ms, ` +
    `review poll: ${config.reviewPollIntervalMs}ms, ` +
    `fix poll: ${config.fixPollIntervalMs}ms, ` +
    `max concurrent: ${config.maxConcurrentAgents}, ` +
    `max fix retries: ${config.maxFixRetries}, ` +
    `timeout: ${config.agentTimeoutMs}ms`,
  );
}
