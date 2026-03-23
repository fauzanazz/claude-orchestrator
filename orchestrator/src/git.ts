import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ProjectConfig } from './types.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawn(
  args: string[],
  opts?: { cwd?: string },
): Promise<SpawnResult> {
  const proc = Bun.spawn(args, {
    cwd: opts?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function pathExists(p: string): Promise<boolean> {
  return Bun.file(p).exists();
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Ensures the project repository is available locally.
 * If `project.path` is set, it is returned as-is.
 * Otherwise the repo is cloned into the shared repos directory.
 */
export async function ensureProjectLocal(
  project: ProjectConfig,
  key: string,
): Promise<string> {
  if (project.path) {
    return project.path;
  }

  const repoDir = join(
    homedir(),
    '.local',
    'share',
    'agent-orchestrator',
    'repos',
    key,
  );

  if (!(await pathExists(repoDir))) {
    await mkdir(repoDir, { recursive: true });
    const result = await spawn([
      'git',
      'clone',
      `git@github.com:${project.repo}.git`,
      repoDir,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `git clone failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  return repoDir;
}

/**
 * Creates a git worktree for the given branch, performing crash-recovery
 * cleanup if the worktree directory already exists.
 */
export async function setupWorktree(
  projectPath: string,
  branch: string,
  issueKey: string,
  slug: string,
): Promise<string> {
  // Fetch the remote branch
  const fetchResult = await spawn(
    ['git', '-C', projectPath, 'fetch', 'origin', branch],
  );
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      `git fetch failed (exit ${fetchResult.exitCode}): ${fetchResult.stderr.trim()}`,
    );
  }

  const worktreePath = join(
    projectPath,
    '.worktrees',
    `agent-${issueKey}-${slug}`,
  );

  // Remove any existing worktrees using the same local branch
  const localBranch = `local/${branch}`;
  const listResult = await spawn(['git', '-C', projectPath, 'worktree', 'list', '--porcelain']);
  if (listResult.exitCode === 0) {
    const entries = listResult.stdout.split('\n\n');
    for (const entry of entries) {
      if (entry.includes(`branch refs/heads/${localBranch}`)) {
        const wtMatch = entry.match(/^worktree (.+)$/m);
        if (wtMatch?.[1]) {
          await spawn(['git', '-C', projectPath, 'worktree', 'remove', '--force', wtMatch[1]]);
        }
      }
    }
  }

  // Prune stale worktree bookkeeping
  await spawn(['git', '-C', projectPath, 'worktree', 'prune']);

  // Delete stale local branch if it exists from a previous run
  await spawn(['git', '-C', projectPath, 'branch', '-D', localBranch]);

  // Create the worktree tracking the remote branch
  const addResult = await spawn([
    'git',
    '-C',
    projectPath,
    'worktree',
    'add',
    '--track',
    '-b',
    localBranch,
    worktreePath,
    `origin/${branch}`,
  ]);
  if (addResult.exitCode !== 0) {
    throw new Error(
      `git worktree add failed (exit ${addResult.exitCode}): ${addResult.stderr.trim()}`,
    );
  }

  return worktreePath;
}

/**
 * Removes a worktree. Errors are silently ignored (best-effort cleanup).
 */
export async function cleanupWorktree(
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await spawn([
      'git',
      '-C',
      projectPath,
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ]);
  } catch {
    // best-effort — ignore errors
  }
}

/**
 * Pushes commits from the worktree's local branch back to the remote branch.
 */
export async function pushFromWorktree(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const result = await spawn([
    'git',
    '-C',
    worktreePath,
    'push',
    'origin',
    `local/${branch}:${branch}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git push failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// GitHub PR creation (via gh CLI)
// ---------------------------------------------------------------------------

interface CreatePROpts {
  repo: string;    // e.g. "owner/repo-name"
  base: string;    // target branch
  head: string;    // source branch
  title: string;
  body: string;
  reviewer: string;
}

/**
 * Creates a pull request via the `gh` CLI and requests a reviewer.
 * Returns the PR URL.
 */
export async function createPR(opts: CreatePROpts): Promise<string> {
  // Check if a PR already exists for this head branch
  const existing = await spawn([
    'gh', 'pr', 'view', opts.head,
    '--repo', opts.repo,
    '--json', 'url',
    '--jq', '.url',
  ]);

  if (existing.exitCode === 0 && existing.stdout.trim()) {
    // PR exists — update it
    await spawn([
      'gh', 'pr', 'edit', opts.head,
      '--repo', opts.repo,
      '--title', opts.title,
      '--body', opts.body,
    ]);
    return existing.stdout.trim();
  }

  const result = await spawn([
    'gh', 'pr', 'create',
    '--repo', opts.repo,
    '--base', opts.base,
    '--head', opts.head,
    '--title', opts.title,
    '--body', opts.body,
    '--reviewer', opts.reviewer,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `gh pr create failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Agent state setup
// ---------------------------------------------------------------------------

export async function setupAgentState(worktreePath: string): Promise<void> {
  await mkdir(join(worktreePath, '.agent-state'), { recursive: true });

  const gitignorePath = join(worktreePath, '.gitignore');
  let content = '';
  try {
    content = await Bun.file(gitignorePath).text();
  } catch {
    // File doesn't exist — start fresh
  }

  if (!content.includes('.agent-state')) {
    content += '\n# Agent orchestrator state (auto-generated)\n.agent-state/\n';
    await Bun.write(gitignorePath, content);
  }
}

// ---------------------------------------------------------------------------
// Commit check
// ---------------------------------------------------------------------------

export async function hasLocalCommits(worktreePath: string): Promise<boolean> {
  const result = await spawn(
    ['git', '-C', worktreePath, 'log', '@{upstream}..HEAD', '--oneline'],
  );

  if (result.exitCode === 0) {
    return result.stdout.trim().length > 0;
  }

  // Fallback: count commits on HEAD not reachable from any remote-tracking branch
  const fallback = await spawn(
    ['git', '-C', worktreePath, 'rev-list', '--count', 'HEAD', '--not', '--remotes'],
  );
  if (fallback.exitCode === 0) {
    return parseInt(fallback.stdout.trim(), 10) > 0;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Agent settings
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',

  'Write',
  'Edit',

  'Bash(git *)',
  'Bash(bun *)',
  'Bash(bunx *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(pnpm *)',
  'Bash(yarn *)',
  'Bash(tsc *)',
  'Bash(eslint *)',
  'Bash(prettier *)',
  'Bash(pytest *)',
  'Bash(python *)',
  'Bash(uv *)',
  'Bash(cargo *)',
  'Bash(go *)',
  'Bash(make *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(find *)',
  'Bash(ls *)',
  'Bash(mkdir *)',
  'Bash(cp *)',
  'Bash(mv *)',
  'Bash(rm *)',
  'Bash(touch *)',
  'Bash(echo *)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(sed *)',
  'Bash(awk *)',
  'Bash(sort *)',
  'Bash(uniq *)',
  'Bash(diff *)',
  'Bash(tree *)',
];

const DENIED_TOOLS = [
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(nc *)',
  'Bash(ncat *)',
  'Bash(netcat *)',
  'Bash(eval *)',
  'Bash(exec *)',
  'Bash(sudo *)',
  'Bash(su *)',
  'Bash(chmod 777 *)',
  'Bash(open *)',
  'Bash(osascript *)',
];

export function buildAgentSettings(allowedTools?: string[]): object {
  const allow = allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  return {
    permissions: {
      allow,
      deny: DENIED_TOOLS,
    },
  };
}

/**
 * Writes `.claude/settings.json` inside the worktree with scoped permissions.
 */
export async function writeAgentSettings(
  worktreePath: string,
  allowedTools?: string[],
): Promise<void> {
  const settingsDir = join(worktreePath, '.claude');
  await mkdir(settingsDir, { recursive: true });

  const settings = buildAgentSettings(allowedTools);

  await Bun.write(
    join(settingsDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Rebase & force-push (for auto-fix conflict resolution)
// ---------------------------------------------------------------------------

export interface RebaseResult {
  success: boolean;
  conflictOutput?: string;
}

/**
 * Attempts to rebase the current branch onto the latest base branch.
 * Returns success status and conflict output if the rebase fails.
 */
export async function rebaseOnto(
  worktreePath: string,
  baseBranch: string,
): Promise<RebaseResult> {
  // Fetch latest base branch
  const fetchResult = await spawn(
    ['git', 'fetch', 'origin', baseBranch],
    { cwd: worktreePath },
  );
  if (fetchResult.exitCode !== 0) {
    return {
      success: false,
      conflictOutput: `Failed to fetch ${baseBranch}: ${fetchResult.stderr.trim()}`,
    };
  }

  // Attempt rebase
  const rebaseResult = await spawn(
    ['git', 'rebase', `origin/${baseBranch}`],
    { cwd: worktreePath },
  );

  if (rebaseResult.exitCode === 0) {
    return { success: true };
  }

  return {
    success: false,
    conflictOutput: [rebaseResult.stdout, rebaseResult.stderr].filter(Boolean).join('\n').trim(),
  };
}

/**
 * Aborts an in-progress rebase.
 */
export async function abortRebase(worktreePath: string): Promise<void> {
  await spawn(['git', 'rebase', '--abort'], { cwd: worktreePath });
}

/**
 * Force-pushes from the worktree using --force-with-lease for safety.
 */
export async function forcePushFromWorktree(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const result = await spawn(
    ['git', 'push', '--force-with-lease', 'origin', `local/${branch}:${branch}`],
    { cwd: worktreePath },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git force-push failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}
