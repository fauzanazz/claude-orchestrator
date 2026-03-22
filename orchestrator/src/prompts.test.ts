import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  buildInitializerPrompt,
  buildCodingPrompt,
  readFeatureList,
  isAllFeaturesDone,
  type SessionPromptContext,
  type FeatureEntry,
} from './prompts.ts';

const tmpDir = join(import.meta.dir, '..', '.test-tmp-prompts');

beforeEach(async () => {
  await mkdir(join(tmpDir, '.agent-state'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('buildInitializerPrompt', () => {
  test('contains base prompt and Session Mode: Initializer', () => {
    const ctx: SessionPromptContext = { basePrompt: 'BASE PROMPT CONTENT', issueKey: 'FAU-1' };
    const result = buildInitializerPrompt(ctx);
    expect(result).toContain('BASE PROMPT CONTENT');
    expect(result).toContain('Session Mode: Initializer');
  });
});

describe('buildCodingPrompt', () => {
  test('contains base prompt and Session Mode: Coding', () => {
    const ctx: SessionPromptContext = { basePrompt: 'BASE PROMPT CONTENT', issueKey: 'FAU-1' };
    const result = buildCodingPrompt(ctx);
    expect(result).toContain('BASE PROMPT CONTENT');
    expect(result).toContain('Session Mode: Coding (Continuation)');
  });
});

describe('readFeatureList', () => {
  test('returns parsed array for valid JSON', async () => {
    const features: FeatureEntry[] = [
      { name: 'feat-a', description: 'Feature A', passes: true },
      { name: 'feat-b', description: 'Feature B', passes: false },
    ];
    await Bun.write(join(tmpDir, '.agent-state', 'features.json'), JSON.stringify(features));

    const result = await readFeatureList(tmpDir);
    expect(result).toEqual(features);
  });

  test('returns null for invalid JSON', async () => {
    await Bun.write(join(tmpDir, '.agent-state', 'features.json'), 'not valid json');

    const result = await readFeatureList(tmpDir);
    expect(result).toBeNull();
  });

  test('returns null for missing file', async () => {
    const result = await readFeatureList(tmpDir);
    expect(result).toBeNull();
  });

  test('returns null if entries are missing required fields', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'features.json'),
      JSON.stringify([{ name: 'feat-a' }]),
    );

    const result = await readFeatureList(tmpDir);
    expect(result).toBeNull();
  });

  test('returns null for non-array JSON', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'features.json'),
      JSON.stringify({ name: 'feat-a', description: 'desc', passes: false }),
    );

    const result = await readFeatureList(tmpDir);
    expect(result).toBeNull();
  });
});

describe('isAllFeaturesDone', () => {
  test('returns true when all features pass', () => {
    const features: FeatureEntry[] = [
      { name: 'a', description: 'A', passes: true },
      { name: 'b', description: 'B', passes: true },
    ];
    expect(isAllFeaturesDone(features)).toBe(true);
  });

  test('returns false when some features are incomplete', () => {
    const features: FeatureEntry[] = [
      { name: 'a', description: 'A', passes: true },
      { name: 'b', description: 'B', passes: false },
    ];
    expect(isAllFeaturesDone(features)).toBe(false);
  });

  test('returns false for null', () => {
    expect(isAllFeaturesDone(null)).toBe(false);
  });

  test('returns false for empty array', () => {
    expect(isAllFeaturesDone([])).toBe(false);
  });
});
