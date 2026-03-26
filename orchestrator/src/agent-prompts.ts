import { join } from 'node:path';
import { log, errorMsg } from './logger.ts';
import { config } from './config.ts';
import { readProjectMemory } from './memory.ts';
import { buildIntelligenceSection } from './project-intelligence.ts';
import type { Issue, FixType } from './types.ts';

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

async function generateCodebaseSummary(worktreePath: string): Promise<string> {
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

  const files = findOut.trim().split('\n').sort((a, b) => a.localeCompare(b)).join('\n');
  return `## Codebase Structure\n\n\`\`\`\n${files}\n\`\`\``;
}

async function fileExistsAndRead(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return file.text();
}

function buildRulesSection(issue: Issue, isRevision: boolean): string {
  const lines: string[] = [
    '## Agent Rules',
    '',
    `- **Branch**: \`${issue.branch}\``,
    `- **Issue**: ${issue.key} — ${issue.title}`,
    `- All commits must reference the issue key in the message, e.g. \`[${issue.key}] feat: description\`.`,
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
      log.warn(`[runner] Memory injection failed for ${projectKey}: ${errorMsg(err)}`);
    }
  }

  // 2.8. Project intelligence (injected on first session only)
  if (isFirstSession && projectKey) {
    const intelligence = buildIntelligenceSection(projectKey);
    if (intelligence) sections.push(intelligence);
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

export async function buildPreviousSessionSummary(
  runId: string,
  worktreePath: string,
  logBuffers: Map<string, Array<{ stream: string; content: string }>>,
): Promise<string | undefined> {
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

export async function buildFixPrompt(
  issue: Issue,
  worktreePath: string,
  opts: {
    fixType: FixType;
    errorContext: string;
    attempt: number;
    codebaseSummary?: string;
    projectKey?: string;
  },
): Promise<string> {
  const { fixType, errorContext, attempt, codebaseSummary, projectKey } = opts;
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
      ? 'A rebase is in progress and conflict markers are present in the working tree. Resolve all conflicts in the affected files and stage them:\n1. Edit each conflicted file to resolve the conflict markers (<<<<<<< / ======= / >>>>>>>).\n2. Run `git add <file>` for each resolved file.\n3. Do NOT run `git rebase --continue` or `git commit` — the orchestrator handles those.'
      : 'Fix the CI/CD failure described above. Read the error logs carefully, identify the root cause, make the necessary code changes, and commit the fix.',
    '',
    '- Do not push — the orchestrator handles git push.',
    `- Reference the issue key in your commit message: [${issue.key}] fix: description`,
  ].join('\n');

  return basePrompt + '\n\n---\n\n' + fixSection;
}

export { generateCodebaseSummary };
