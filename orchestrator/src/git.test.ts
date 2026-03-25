import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';
import {
  setupAgentState,
  hasLocalCommits,
  buildAgentSettings,
  writeAgentSettings,
  DEFAULT_ALLOWED_TOOLS,
} from './git.ts';

const tmpDir = join(import.meta.dir, '..', '.test-tmp-git');

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('setupAgentState', () => {
  test('creates .agent-state directory', async () => {
    await setupAgentState(tmpDir);
    // Directory existence check — mkdir would have created it
    const proc = Bun.spawn(['test', '-d', join(tmpDir, '.agent-state')]);
    await proc.exited;
    expect(proc.exitCode).toBe(0);
  });

  test('appends .agent-state to .gitignore', async () => {
    await setupAgentState(tmpDir);
    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agent-state/');
  });

  test('does not duplicate .agent-state in .gitignore on second call', async () => {
    await setupAgentState(tmpDir);
    await setupAgentState(tmpDir);
    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.agent-state/g);
    expect(matches?.length).toBe(1);
  });

  test('preserves existing .gitignore content', async () => {
    await Bun.write(join(tmpDir, '.gitignore'), 'node_modules/\n');
    await setupAgentState(tmpDir);
    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.agent-state/');
  });
});

describe('hasLocalCommits', () => {
  async function gitRun(args: string[]): Promise<void> {
    const proc = Bun.spawn(args);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`git command failed (exit ${exitCode}): ${args.join(' ')}`);
    }
  }

  test('returns true when commits exist ahead of upstream', async () => {
    // Set up a bare repo + clone to simulate upstream tracking
    const bareDir = join(tmpDir, 'bare.git');
    const workDir = join(tmpDir, 'work');

    // Create bare repo with initial commit
    await gitRun(['git', 'init', '--bare', bareDir]);
    await gitRun(['git', 'clone', bareDir, workDir]);
    await gitRun(['git', '-C', workDir, 'config', 'user.email', 'test@test.com']);
    await gitRun(['git', '-C', workDir, 'config', 'user.name', 'Test']);
    await Bun.write(join(workDir, 'init.txt'), 'init');
    await gitRun(['git', '-C', workDir, 'add', '.']);
    await gitRun(['git', '-C', workDir, 'commit', '-m', 'initial']);
    await gitRun(['git', '-C', workDir, 'push', 'origin', 'main']);

    // Make a local commit
    await Bun.write(join(workDir, 'new.txt'), 'new');
    await gitRun(['git', '-C', workDir, 'add', '.']);
    await gitRun(['git', '-C', workDir, 'commit', '-m', 'local change']);

    const result = await hasLocalCommits(workDir);
    expect(result).toBe(true);
  });

  test('returns false when no commits ahead of upstream', async () => {
    const bareDir = join(tmpDir, 'bare2.git');
    const workDir = join(tmpDir, 'work2');

    await gitRun(['git', 'init', '--bare', bareDir]);
    await gitRun(['git', 'clone', bareDir, workDir]);
    await gitRun(['git', '-C', workDir, 'config', 'user.email', 'test@test.com']);
    await gitRun(['git', '-C', workDir, 'config', 'user.name', 'Test']);
    await Bun.write(join(workDir, 'init.txt'), 'init');
    await gitRun(['git', '-C', workDir, 'add', '.']);
    await gitRun(['git', '-C', workDir, 'commit', '-m', 'initial']);
    await gitRun(['git', '-C', workDir, 'push', 'origin', 'main']);

    const result = await hasLocalCommits(workDir);
    expect(result).toBe(false);
  });
});

describe('buildAgentSettings', () => {
  test('returns default allowlist when no args provided', () => {
    const settings = buildAgentSettings() as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.allow).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  test('returns custom allowlist when provided', () => {
    const custom = ['Bash(bun *)', 'Bash(git *)'];
    const settings = buildAgentSettings(custom) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.allow).toEqual(custom);
  });

  test('always includes deny list', () => {
    const settings = buildAgentSettings() as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.deny).toContain('Bash(curl *)');
    expect(settings.permissions.deny).toContain('Bash(sudo *)');
    expect(settings.permissions.deny).toContain('Bash(ssh *)');
  });

  test('includes deny list with custom allowlist', () => {
    const settings = buildAgentSettings(['Read']) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.deny).toContain('Bash(curl *)');
    expect(settings.permissions.allow).toEqual(['Read']);
  });
});

describe('writeAgentSettings', () => {
  test('creates .claude/settings.json with default permissions', async () => {
    await writeAgentSettings(tmpDir);
    const content = await readFile(join(tmpDir, '.claude', 'settings.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.allow).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(parsed.permissions.deny).toContain('Bash(curl *)');
  });

  test('creates .claude/settings.json with custom allowlist', async () => {
    const custom = ['Bash(git *)', 'Read'];
    await writeAgentSettings(tmpDir, custom);
    const content = await readFile(join(tmpDir, '.claude', 'settings.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.allow).toEqual(custom);
    expect(parsed.permissions.deny).toContain('Bash(curl *)');
  });
});
