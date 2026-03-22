import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { config } from './config.ts';
import {
  insertRun,
  insertLog,
  updateRunStatus,
  getRun,
  getRunsByStatus,
  markStaleRunsFailed,
} from './db.ts';
import {
  ensureProjectLocal,
  setupWorktree,
  writeAgentSettings,
  cleanupWorktree,
  pushFromWorktree,
  createPR,
} from './git.ts';
import { initWorktree } from './init.ts';
import type {
  Run,
  Issue,
  LinearIssue,
  ParsedIssueMetadata,
  ProjectConfig,
  ProjectsConfig,
  SSEEvent,
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

export function loadProjects(): ProjectsConfig {
  const raw = readFileSync(config.projectsConfigPath, 'utf-8');
  return JSON.parse(raw) as ProjectsConfig;
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
    // Update Linear and DB: In Progress
    updateLinearStatus(issue.key, 'In Progress');
    updateRunStatus(runId, 'running', { started_at: new Date().toISOString() });

    bufferLog(runId, 'system', `[runner] Starting run ${runId} for ${issue.key}`);

    // Ensure project is cloned locally
    projectPath = await ensureProjectLocal(project, projectKey);
    bufferLog(runId, 'system', `[runner] Project path: ${projectPath}`);

    // Setup worktree
    const slug = ulid().slice(-6).toLowerCase();
    worktreePath = await setupWorktree(projectPath, issue.branch, issue.key, slug);
    bufferLog(runId, 'system', `[runner] Worktree: ${worktreePath}`);

    // Write agent settings (permissions)
    await writeAgentSettings(worktreePath);

    // Init worktree (install dependencies, etc.)
    await initWorktree(worktreePath, project.init, runId, bufferLog);

    // Build prompt
    let reviewFeedback: string | undefined;
    let prInstructions = '';

    if (run.pr_number) {
      // Revision: fetch PR review comments via gh CLI
      bufferLog(runId, 'system', `[runner] Fetching review comments for PR #${run.pr_number}`);
      const ghProc = Bun.spawn(
        [
          'gh', 'pr', 'view', String(run.pr_number),
          '--repo', issue.repo,
          '--json', 'reviews,comments',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [ghOut] = await Promise.all([
        new Response(ghProc.stdout).text(),
        ghProc.exited,
      ]);
      reviewFeedback = ghOut.trim() || undefined;
      prInstructions =
        `\n\n## PR Instructions\n\n` +
        `This is a revision of PR #${run.pr_number}. ` +
        `After committing your changes, the orchestrator will push and update the existing PR automatically. ` +
        `Use \`gh pr review\` to understand reviewer feedback and address all requested changes.`;
    }

    const prompt = (await buildAgentPrompt(issue, worktreePath, reviewFeedback)) + prInstructions;

    bufferLog(runId, 'system', `[runner] Spawning claude agent`);

    // Spawn claude
    const agentProc = Bun.spawn(
      [config.claudeCodePath, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', prompt],
      {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    // Update DB with agent PID
    updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

    // Race: stream output vs timeout
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), config.agentTimeoutMs),
    );

    const completionPromise = Promise.all([
      streamOutput(agentProc.stdout, runId, 'stdout'),
      streamOutput(agentProc.stderr, runId, 'stderr'),
      agentProc.exited,
    ]).then(() => 'done' as const);

    const result = await Promise.race([completionPromise, timeoutPromise]);

    if (result === 'timeout') {
      bufferLog(runId, 'system', `[runner] Agent timed out after ${config.agentTimeoutMs}ms — killing`);
      agentProc.kill();
      updateRunStatus(runId, 'failed', {
        error_summary: `Agent timed out after ${config.agentTimeoutMs}ms`,
        completed_at: new Date().toISOString(),
      });
      updateLinearStatus(issue.key, 'Failed');
      commentOnIssue(issue.key, `Agent timed out after ${config.agentTimeoutMs / 1000}s.`);
      return;
    }

    const exitCode = agentProc.exitCode ?? 0;
    bufferLog(runId, 'system', `[runner] Agent exited with code ${exitCode}`);

    if (exitCode !== 0) {
      throw new Error(`Claude agent exited with code ${exitCode}`);
    }

    // Push commits
    bufferLog(runId, 'system', `[runner] Pushing branch ${issue.branch}`);
    await pushFromWorktree(worktreePath, issue.branch);

    // Create or update PR
    let prUrl: string;
    if (run.pr_number) {
      // Revision — PR already exists, construct URL
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

    // Update DB and Linear to success
    updateRunStatus(runId, 'success', {
      pr_url: prUrl,
      completed_at: new Date().toISOString(),
    });
    updateLinearStatus(issue.key, 'In Review');
    commentOnIssue(issue.key, `PR ready for review: ${prUrl}`);

    bufferLog(runId, 'system', `[runner] Run ${runId} completed successfully`);

    // Broadcast run update
    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    bufferLog(runId, 'system', `[runner] Run ${runId} failed: ${errorMessage}`);

    updateRunStatus(runId, 'failed', {
      error_summary: errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    });
    updateLinearStatus(issue.key, 'Failed');
    commentOnIssue(issue.key, `Agent run failed: ${errorMessage.slice(0, 200)}`);

    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

  } finally {
    flushLogs(runId);

    // Best-effort worktree cleanup
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

export function enqueueRevision(originalRun: Run, prNumber: number): void {
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
    pr_number: prNumber,
    agent_pid: null,
    error_summary: null,
    pr_url: null,
  };

  insertRun(newRun);

  // getRun to get the full record with timestamps
  const fullRun = getRun(newRun.id);
  if (fullRun) {
    enqueue(fullRun);
    broadcastSSE({ type: 'run_update', run: fullRun });
  }
}

export async function tick(): Promise<void> {
  if (running >= config.maxConcurrentAgents) return;
  if (queue.length === 0) return;

  const run = queue.shift()!;
  running++;

  // Look up issue metadata from the sidecar map
  const issueData = issueMap.get(run.id);

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
    // Note: issueMap entries are not persisted, so these will fail at tick() time
    // with "no issue data". This is acceptable — operators re-trigger from Linear.
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
          pr_number: null,
          agent_pid: null,
          error_summary: null,
          pr_url: null,
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

  // Tick every 5 seconds to dispatch queued runs
  setInterval(() => {
    tick().catch((err) => console.error('[runner] tick error:', err));
  }, 5_000);

  console.log(
    `[runner] Running. Poll interval: ${config.pollIntervalMs}ms, ` +
    `max concurrent: ${config.maxConcurrentAgents}, ` +
    `timeout: ${config.agentTimeoutMs}ms`,
  );
}
