import { join } from 'node:path';

export async function detectInit(worktreePath: string): Promise<string[]> {
  if (await Bun.file(join(worktreePath, 'bun.lockb')).exists()) {
    return ['bun install'];
  }
  if (await Bun.file(join(worktreePath, 'bun.lock')).exists()) {
    return ['bun install'];
  }
  if (await Bun.file(join(worktreePath, 'package-lock.json')).exists()) {
    return ['npm ci'];
  }
  if (await Bun.file(join(worktreePath, 'yarn.lock')).exists()) {
    return ['yarn install --frozen-lockfile'];
  }
  if (await Bun.file(join(worktreePath, 'pnpm-lock.yaml')).exists()) {
    return ['pnpm install --frozen-lockfile'];
  }
  return [];
}

export async function initWorktree(
  worktreePath: string,
  projectInit: string[] | undefined,
  runId: string,
  appendLog: (runId: string, stream: string, content: string) => void,
): Promise<void> {
  const commands = projectInit ?? (await detectInit(worktreePath));

  for (const cmd of commands) {
    appendLog(runId, 'system', `[init] ${cmd}`);

    const proc = Bun.spawn(['sh', '-c', cmd], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`Init command failed: ${cmd}`);
    }
  }
}
