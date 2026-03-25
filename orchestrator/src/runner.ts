import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { config } from './config.ts';
import { documentRun, readProjectMemory } from './memory.ts';
import { TokenTracker } from './token-tracker.ts';
import { reviewRun, formatReviewFeedback } from './review-gate.ts';
import {
  insertRun,
  insertLog,
  updateRunStatus,
  updateRunIterations,
  updateRunTokens,
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
  deleteFixTracking,
  getRunByPRNumber,
  getIssueForRun,
  getPRNumberByIssueKey,
  getSiblingOpenPRRuns,
  deleteOldLogs,
  deleteOldRuns,
  deleteOldProcessedReviews,
  deleteOldNotifiedPRs,
  vacuumDatabase,
  getDatabaseSize,
  snapshotDatabase,
  hasActiveRunForIssue,
  hasAnyRunForIssue,
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
  type RebaseResult,
} from './git.ts';
import { initWorktree } from './init.ts';
import { validateDesignPath, validateBranch, validateRepo } from './validate.ts';
import { LinearIssueListSchema, LinearIssueDetailSchema, GHPRReviewPollSchema, GHRunListSchema } from './schemas.ts';
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

// lineark doesn't include the parent field in `issues read` output, so we
// query the Linear GraphQL API directly to resolve parent relationships.
async function fetchLinearParent(issueId: string): Promise<{ id: string; identifier: string } | null> {
  const tokenPath = join(process.env.HOME ?? '~', '.linear_api_token');
  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }

  try {
    const resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        query: `{ issue(id: "${issueId}") { parent { id identifier } } }`,
      }),
    });
    const json = await resp.json() as { data?: { issue?: { parent?: { id: string; identifier: string } | null } } };
    return json.data?.issue?.parent ?? null;
  } catch (err) {
    console.warn(`[runner] Failed to fetch parent for issue ${issueId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function pollLinear(): Promise<LinearIssue[]> {
  // Step 1: List issues (lean output — has identifier + state but no id/description)
  const listOut = await runLineark(['issues', 'list', '--format', 'json']);
  let listJson: unknown;
  try {
    listJson = JSON.parse(listOut);
  } catch {
    throw new Error(`lineark list output is not valid JSON: ${listOut.slice(0, 200)}`);
  }
  const parseResult = LinearIssueListSchema.safeParse(listJson);
  if (!parseResult.success) {
    throw new Error(`lineark list output validation failed: ${parseResult.error.message}`);
  }
  const summaries = parseResult.data;

  // Filter to actionable states: "Ready for Agent" (new work) or "In Progress" (orphaned after restart)
  const ready = summaries.filter((s) => s.state === 'Ready for Agent' || s.state === 'In Progress');
  if (ready.length === 0) return [];

  clearParentStateCache();

  // Step 2: Fetch full details concurrently (5 at a time)
  const POLL_CONCURRENCY = 5;
  const chunks = chunkArray(ready, POLL_CONCURRENCY);
  const issues: LinearIssue[] = [];

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (summary): Promise<LinearIssue | null> => {
        const identifier = summary.identifier;

        let readOut: string;
        try {
          readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
        } catch (err) {
          console.warn(`[runner] lineark read failed for ${identifier}: ${err instanceof Error ? err.message : err}`);
          return null;
        }

        let detailJson: unknown;
        try {
          detailJson = JSON.parse(readOut);
        } catch {
          console.warn(`[runner] lineark read for ${identifier} returned invalid JSON`);
          return null;
        }

        const detailResult = LinearIssueDetailSchema.safeParse(detailJson);
        if (!detailResult.success) {
          console.warn(`[runner] Failed to validate lineark read for ${identifier}: ${detailResult.error.message}`);
          return null;
        }
        const full = detailResult.data;

        if (!full.description.includes('design:') && !(full.description.includes('branch:') && full.description.includes('repo:'))) {
          return null;
        }

        // "In Progress" issues are only re-picked if the orchestrator previously ran them
        // (orphaned after crash). Issues manually moved to "In Progress" are skipped.
        if (summary.state === 'In Progress' && !hasAnyRunForIssue(full.id)) {
          console.log(`[runner] Skipping ${identifier} — "In Progress" but no prior run (manually moved?)`);
          return null;
        }

        // lineark doesn't return parent — fetch from Linear API directly
        const parent = await fetchLinearParent(full.id);
        if (parent?.identifier) {
          const done = await isParentDone(parent.identifier);
          if (!done) {
            console.log(`[runner] Skipping ${identifier}: parent ${parent.identifier} not done yet`);
            return null;
          }
        }

        return {
          id: full.id,
          identifier: full.identifier,
          title: full.title,
          description: full.description,
          parent: parent ?? undefined,
        };
      })
    );

    for (const result of results) {
      if (result) issues.push(result);
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

  // Branch and repo are always required
  if (branch && repo) {
    return {
      designPath: designPath ? validateDesignPath(designPath) : null,
      branch: validateBranch(branch),
      repo: validateRepo(repo),
    };
  }

  // Fallback: extract from prose-style descriptions
  const proseDesign = description.match(/design\s*doc:\s*([\w/._-]+\.md)/i);
  const proseBranch = description.match(/branch\s+([\w/\-]+(?:\/[\w/\-]+)*)/i);
  const proseRepo = description.match(/repo:\s*([\w/._-]+)/i)
    ?? description.match(/repo[.:]?\s*([\w-]+\/[\w._-]+)/i);

  const pd = proseDesign?.[1]?.trim();
  const pb = proseBranch?.[1]?.trim();
  const pr = proseRepo?.[1]?.trim();

  if (!pb || !pr) return null;

  return {
    designPath: pd ? validateDesignPath(pd) : null,
    branch: validateBranch(pb),
    repo: validateRepo(pr),
  };
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

export function commentOnPR(repo: string, prNumber: number, body: string): void {
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
// Parent dependency checking
// ---------------------------------------------------------------------------

const parentStateCache = new Map<string, string>();

export function clearParentStateCache(): void {
  parentStateCache.clear();
}

async function getIssueState(identifier: string): Promise<string | null> {
  const cached = parentStateCache.get(identifier);
  if (cached) return cached;

  try {
    const readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
    const parsed = JSON.parse(readOut) as Record<string, unknown>;
    const state = (parsed.state as Record<string, unknown>)?.name as string | undefined;
    if (state) {
      parentStateCache.set(identifier, state);
    }
    return state ?? null;
  } catch {
    console.warn(`[runner] Failed to read state for ${identifier}`);
    return null;
  }
}

async function isParentDone(parentIdentifier: string): Promise<boolean> {
  const state = await getIssueState(parentIdentifier);
  if (!state) return false; // can't determine — safe to block

  const doneStates = ['done', 'canceled', 'cancelled'];
  return doneStates.includes(state.toLowerCase());
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

  let detailJson: unknown;
  try {
    detailJson = JSON.parse(readOut);
  } catch {
    throw new Error(`lineark read for ${run.issue_key} returned invalid JSON`);
  }
  const detailResult = LinearIssueDetailSchema.safeParse(detailJson);
  if (!detailResult.success) {
    throw new Error(`Failed to validate Linear issue for ${run.issue_key}: ${detailResult.error.message}`);
  }
  const linearIssue = detailResult.data;

  const meta = parseIssueMetadata(linearIssue.description);
  if (!meta) {
    throw new Error(`Could not parse issue metadata from ${run.issue_key} description`);
  }

  const resolved = resolveProject(meta.repo);
  if (!resolved) {
    throw new Error(`Project not found for repo: ${meta.repo}`);
  }

  const parent = await fetchLinearParent(linearIssue.id);

  return {
    id: linearIssue.id,
    key: run.issue_key,
    title: run.issue_title,
    description: linearIssue.description,
    designPath: meta.designPath,
    branch: meta.branch,
    repo: meta.repo,
    baseBranch: resolved.project.baseBranch,
    parentKey: parent?.identifier ?? null,
  };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function parseReviewFeedback(rawJson: string): string | undefined {
  let parsed: { reviews?: unknown[]; comments?: unknown[] };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }

  const sections: string[] = [];

  if (Array.isArray(parsed.reviews)) {
    for (const review of parsed.reviews) {
      const r = review as Record<string, unknown>;
      const author = (r.author as Record<string, unknown>)?.login as string ?? 'unknown';
      const state = (r.state as string ?? '').toLowerCase();
      const body = (r.body as string ?? '').trim();
      if (!body && state === 'approved') continue;
      if (!body && state === 'commented') continue;
      sections.push(`### ${author} (${state})\n\n${body || '_No comment body_'}`);
    }
  }

  if (Array.isArray(parsed.comments)) {
    for (const comment of parsed.comments) {
      const c = comment as Record<string, unknown>;
      const author = (c.author as Record<string, unknown>)?.login as string ?? 'unknown';
      const body = (c.body as string ?? '').trim();
      if (!body) continue;
      sections.push(`### ${author} (comment)\n\n${body}`);
    }
  }

  if (sections.length === 0) return undefined;
  return sections.join('\n\n---\n\n');
}

export async function generateCodebaseSummary(worktreePath: string): Promise<string> {
  const treeProc = Bun.spawn(
    ['tree', '-L', '2', '--gitignore', '-I', 'node_modules|.git|.worktrees'],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
  );
  const [treeOut, treeExit] = await Promise.all([
    new Response(treeProc.stdout).text(),
    treeProc.exited,
  ]);

  if (treeExit === 0 && treeOut.trim()) {
    const output = treeOut.trim();
    const truncated = output.length > 5000 ? output.slice(0, 5000) + '\n... (truncated)' : output;
    return `## Codebase Structure\n\n\`\`\`\n${truncated}\n\`\`\``;
  }

  const findProc = Bun.spawn(
    ['find', '.', '-maxdepth', '2', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/.worktrees/*'],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
  );
  const [findOut] = await Promise.all([
    new Response(findProc.stdout).text(),
    findProc.exited,
  ]);

  const files = findOut.trim().split('\n').sort().join('\n');
  return `## Codebase Structure\n\n\`\`\`\n${files}\n\`\`\``;
}

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
  opts?: {
    reviewFeedback?: string;
    isFirstSession?: boolean;
    codebaseSummary?: string;
    projectKey?: string;
  },
): Promise<string> {
  const { reviewFeedback, isFirstSession = true, codebaseSummary, projectKey } = opts ?? {};
  const sections: string[] = [];

  // 1. Global prompt
  const globalPrompt = await fileExistsAndRead(config.globalPromptPath);
  if (globalPrompt) sections.push(globalPrompt.trim());

  // 2. CLAUDE.md from worktree (project-level instructions)
  const claudeMd = await fileExistsAndRead(join(worktreePath, 'CLAUDE.md'));
  if (claudeMd) sections.push(claudeMd.trim());

  // 2.5. Codebase summary (if provided)
  if (codebaseSummary) sections.push(codebaseSummary);

  // 2.7. Project memory — inject on first session only
  if (isFirstSession && projectKey) {
    try {
      const memory = await readProjectMemory(projectKey, {
        issueTitle: issue.title,
        issueKey: issue.key,
      });
      if (memory) sections.push(memory);
    } catch (err) {
      console.warn(`[runner] Memory injection failed for ${projectKey}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. Design doc — full on first session, reference on continuations
  if (issue.designPath) {
    const designDocPath = join(worktreePath, issue.designPath);
    if (isFirstSession) {
      const designDoc = await fileExistsAndRead(designDocPath);
      if (designDoc) sections.push(designDoc.trim());
    } else {
      const featuresExist = await Bun.file(join(worktreePath, '.agent-state', 'features.json')).exists();
      if (featuresExist) {
        sections.push(`## Design Document\n\nFull design at \`${issue.designPath}\`. Features extracted to \`.agent-state/features.json\`. Read the design doc only if you need to review the original requirements.`);
      } else {
        const designDoc = await fileExistsAndRead(designDocPath);
        if (designDoc) sections.push(designDoc.trim());
      }
    }
  } else {
    // Designless task: use issue description as the spec
    sections.push(`## Task Specification\n\n${issue.description}`);
  }

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

async function buildPreviousSessionSummary(runId: string, worktreePath: string): Promise<string | undefined> {
  const parts: string[] = [];

  // Recent git log from worktree
  try {
    const gitProc = Bun.spawn(
      ['git', '-C', worktreePath, 'log', '--oneline', '-10'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [gitOut] = await Promise.all([new Response(gitProc.stdout).text(), gitProc.exited]);
    const gitLog = gitOut.trim();
    if (gitLog) {
      parts.push(`### Recent Commits\n\`\`\`\n${gitLog}\n\`\`\``);
    }
  } catch { /* ignore */ }

  // Last 20 log entries from the buffer
  const recentLogs = logBuffers.get(runId);
  if (recentLogs && recentLogs.length > 0) {
    const tail = recentLogs.slice(-20);
    const logSummary = tail.map(e => `[${e.stream}] ${e.content}`).join('\n');
    parts.push(`### Last Session Output (tail)\n\`\`\`\n${logSummary}\n\`\`\``);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (streamName === 'stderr') {
          bufferLog(runId, streamName, text);
        } else {
          for (const line of text.split('\n').filter(Boolean)) {
            onRawLine?.(line);
            const readable = parseAgentEvent(line);
            if (readable) {
              bufferLog(runId, streamName, readable);
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

async function buildFixPrompt(
  issue: Issue,
  worktreePath: string,
  fixType: FixType,
  errorContext: string,
  attempt: number,
  codebaseSummary?: string,
  projectKey?: string,
): Promise<string> {
  // Build the base prompt (global + CLAUDE.md + design doc + issue context)
  const basePrompt = await buildAgentPrompt(issue, worktreePath, { codebaseSummary, projectKey });

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
      await initWorktree(worktreePath, project.init, runId, bufferLog);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
          clearFixTracking(issue.repo, run.pr_number!, run.fix_type);
          bufferLog(runId, 'system', `[runner] Conflict resolved via clean rebase`);
          return;
        }
        errorContext = `Automatic rebase onto ${issue.baseBranch} failed. Conflict markers are present in the working tree.\n\n${rebaseResult.conflictOutput ?? ''}`;
      }

      let fixPrompt = await buildFixPrompt(issue, worktreePath, run.fix_type as FixType, errorContext, run.fix_attempt, codebaseSummary, projectKey);
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
        previousSummary = await buildPreviousSessionSummary(runId, worktreePath!);

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
      if (run.fix_type) clearFixTracking(issue.repo, prNum ?? run.pr_number!, run.fix_type);
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
        const reviewResult = await reviewRun(updatedRun ?? run, issue, worktreePath);
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
          `[runner] Auto-review failed (non-fatal): ${err instanceof Error ? err.message : err}`
        );
      }
    }
    // Document the run to obsidian-memory (fire-and-forget, before worktree cleanup)
    if (worktreePath && updatedRun) {
      await documentRun(updatedRun, issue, worktreePath).catch((e) =>
        console.warn(`[runner] Memory documentation failed: ${e instanceof Error ? e.message : e}`),
      );
    }

  } catch (err) {
    // Record token usage even on failure
    const failCost = tokenTracker.estimateCost();
    if (failCost.input_tokens > 0 || failCost.output_tokens > 0) {
      updateRunTokens(runId, failCost);
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
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
          console.log(`[runner] Enqueued retry ${retryLabel} as run ${retryRunId} for ${issue.key}`);
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
        console.warn(`[runner] Memory documentation failed: ${e instanceof Error ? e.message : e}`),
      );
    }

  } finally {
    flushLogs(runId);
    retryContextMap.delete(runId); // Clean up in case it wasn't consumed
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
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function beginShutdown(): void {
  shuttingDown = true;
  queue.length = 0; // Clear pending queue
  console.log('[runner] Shutdown initiated — no new runs will start');
}

export function getRunningCount(): number {
  return running;
}

export function flushAllLogs(): void {
  for (const runId of logBuffers.keys()) {
    flushLogs(runId);
  }
}

// Sidecar map: runId -> Issue (kept in memory for the lifetime of the queue item)
const issueMap: Map<string, Issue> = new Map();

// Retry context: stores failure context from parent run for injection into retry prompts.
// Keyed by the *retry* run ID. Acceptable to lose on orchestrator restart.
const retryContextMap: Map<string, string> = new Map();

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

export function enqueueWithIssue(run: Run, issue: Issue): boolean {
  issueMap.set(run.id, issue);
  const ok = enqueue(run);
  if (!ok) {
    issueMap.delete(run.id);
  }
  return ok;
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
    retry_attempt: 0,
    pr_number: prNumber,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
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
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    design_path: failedRun.design_path ?? null,
    issue_repo: failedRun.issue_repo ?? null,
    base_branch: failedRun.base_branch ?? null,
  };

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
    retry_attempt: 0,
    pr_number: prNumber,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
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
  if (shuttingDown) return;
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
        console.log(`[reviewer] PR #${run.pr_number} merged — marked ${run.issue_key} as Done`);
        // Proactively rebase sibling PRs to prevent conflict cascade
        proactiveRebaseSiblings(run).catch((err) =>
          console.error(`[rebase] Error rebasing siblings after ${run.issue_key} merge:`, err),
        );
        continue;
      }
      if (prData.state === 'CLOSED') {
        updateRunStatus(run.id, 'closed');
        updateLinearStatus(run.issue_key, 'Canceled');
        console.log(`[reviewer] PR #${run.pr_number} closed — marked ${run.issue_key} as Canceled`);
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
          console.warn(`[reviewer] Revision run ${revisionRunId} was not inserted (duplicate?), skipping review ${reviewId}`);
          continue;
        }
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
// Proactive rebase: after a PR merges, rebase all sibling PRs in the same
// project to prevent the conflict cascade.
// ---------------------------------------------------------------------------

async function proactiveRebaseSiblings(mergedRun: Run): Promise<void> {
  const siblings = getSiblingOpenPRRuns(mergedRun.project, mergedRun.issue_key);
  if (siblings.length === 0) return;

  const resolved = resolveProject(mergedRun.issue_repo ?? '');
  if (!resolved) return;

  const baseBranch = mergedRun.base_branch ?? resolved.project.baseBranch;

  console.log(
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
          console.log(`[rebase] Auto-rebased PR #${sibling.pr_number} (${sibling.issue_key}) onto ${baseBranch}`);
        } else {
          console.log(`[rebase] PR #${sibling.pr_number} (${sibling.issue_key}) has real conflicts — skipping (fixer will handle)`);
          await abortRebase(worktreePath);
        }
      } finally {
        cleanupWorktree(projectPath, worktreePath).catch(() => {});
      }
    } catch (err) {
      console.warn(
        `[rebase] Failed to proactively rebase PR #${sibling.pr_number} (${sibling.issue_key}): ` +
        `${err instanceof Error ? err.message : err}`,
      );
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
        let meta: ReturnType<typeof parseIssueMetadata>;
        try {
          meta = parseIssueMetadata(linearIssue.description ?? '');
        } catch (err) {
          console.warn(`[runner] poll: invalid metadata in issue ${linearIssue.identifier}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
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
          design_path: issue.designPath,
          issue_repo: issue.repo,
          base_branch: issue.baseBranch,
        };

        // Skip if there's already an active (queued/running) run for this issue
        if (hasActiveRunForIssue(issue.id)) continue;

        // insertRun uses INSERT OR IGNORE as a secondary safeguard
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

  // Snapshot DB on startup
  try {
    const snap = snapshotDatabase(config.maxSnapshots);
    if (snap) console.log(`[runner] DB snapshot saved: ${snap}`);
  } catch (err) {
    console.error('[runner] DB snapshot failed:', err);
  }

  // Database cleanup: periodic retention enforcement
  setInterval(runCleanup, config.cleanupIntervalMs);
  setTimeout(runCleanup, 30_000);

  // Heartbeat: log orchestrator status every 60s
  setInterval(() => {
    console.log(
      `[heartbeat] queue=${queue.length} running=${running}/${config.maxConcurrentAgents}`,
    );
  }, 60_000);

  console.log(
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
    if (snap) console.log(`[cleanup] DB snapshot: ${snap}`);

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

    console.log(
      `[cleanup] Deleted ${logsDeleted} logs, ${runsDeleted} runs, ` +
      `${reviewsDeleted} reviews, ${notificationsDeleted} notifications. ` +
      `DB size: ${Math.round(sizeAfter / 1024)}KB (freed ${savedKB}KB)`
    );
  } catch (err) {
    console.error('[cleanup] Error during cleanup:', err);
  }
}
