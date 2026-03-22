import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { setupAgentState, hasLocalCommits } from './git.ts';

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
    const exists = await Bun.file(join(tmpDir, '.agent-state')).exists();
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
  test('returns true when commits exist ahead of upstream', async () => {
    // Set up a bare repo + clone to simulate upstream tracking
    const bareDir = join(tmpDir, 'bare.git');
    const workDir = join(tmpDir, 'work');

    // Create bare repo with initial commit
    await Bun.spawn(['git', 'init', '--bare', bareDir]).exited;
    await Bun.spawn(['git', 'clone', bareDir, workDir]).exited;
    await Bun.spawn(['git', '-C', workDir, 'config', 'user.email', 'test@test.com']).exited;
    await Bun.spawn(['git', '-C', workDir, 'config', 'user.name', 'Test']).exited;
    await Bun.write(join(workDir, 'init.txt'), 'init');
    await Bun.spawn(['git', '-C', workDir, 'add', '.']).exited;
    await Bun.spawn(['git', '-C', workDir, 'commit', '-m', 'initial']).exited;
    await Bun.spawn(['git', '-C', workDir, 'push', 'origin', 'main']).exited;

    // Make a local commit
    await Bun.write(join(workDir, 'new.txt'), 'new');
    await Bun.spawn(['git', '-C', workDir, 'add', '.']).exited;
    await Bun.spawn(['git', '-C', workDir, 'commit', '-m', 'local change']).exited;

    const result = await hasLocalCommits(workDir);
    expect(result).toBe(true);
  });

  test('returns false when no commits ahead of upstream', async () => {
    const bareDir = join(tmpDir, 'bare2.git');
    const workDir = join(tmpDir, 'work2');

    await Bun.spawn(['git', 'init', '--bare', bareDir]).exited;
    await Bun.spawn(['git', 'clone', bareDir, workDir]).exited;
    await Bun.spawn(['git', '-C', workDir, 'config', 'user.email', 'test@test.com']).exited;
    await Bun.spawn(['git', '-C', workDir, 'config', 'user.name', 'Test']).exited;
    await Bun.write(join(workDir, 'init.txt'), 'init');
    await Bun.spawn(['git', '-C', workDir, 'add', '.']).exited;
    await Bun.spawn(['git', '-C', workDir, 'commit', '-m', 'initial']).exited;
    await Bun.spawn(['git', '-C', workDir, 'push', 'origin', 'main']).exited;

    const result = await hasLocalCommits(workDir);
    expect(result).toBe(false);
  });
});
