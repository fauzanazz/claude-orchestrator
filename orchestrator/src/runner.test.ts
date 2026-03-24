import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  buildSpawnArgs,
  parseReviewFeedback,
  readAgentSignal,
  parseIssueMetadata,
  buildRetryContext,
  logBuffers,
  chunkArray,
} from './runner.ts';
import type { Run } from './types.ts';

// ---------------------------------------------------------------------------
// buildSpawnArgs
// ---------------------------------------------------------------------------

describe('buildSpawnArgs', () => {
  test('includes --print and --output-format stream-json', () => {
    const args = buildSpawnArgs('my prompt');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });

  test('prompt is the last argument', () => {
    const args = buildSpawnArgs('test prompt');
    expect(args[args.length - 1]).toBe('test prompt');
  });

  test('always includes --verbose (required by stream-json output format)', () => {
    const args = buildSpawnArgs('prompt');
    expect(args).toContain('--verbose');
  });

  test('does not include --dangerously-skip-permissions', () => {
    const args = buildSpawnArgs('prompt');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  test('includes --model when provided', () => {
    const args = buildSpawnArgs('prompt', 'claude-sonnet-4-20250514');
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('claude-sonnet-4-20250514');
  });

  test('does not include --model when null', () => {
    const args = buildSpawnArgs('prompt', null);
    expect(args).not.toContain('--model');
  });

  test('does not include --model when undefined', () => {
    const args = buildSpawnArgs('prompt', undefined);
    expect(args).not.toContain('--model');
  });
});

// ---------------------------------------------------------------------------
// parseReviewFeedback
// ---------------------------------------------------------------------------

describe('parseReviewFeedback', () => {
  test('extracts reviewer name and body from reviews', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Please fix the bug' },
      ],
      comments: [],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('alice');
    expect(result).toContain('changes_requested');
    expect(result).toContain('Please fix the bug');
  });

  test('extracts comments', () => {
    const json = JSON.stringify({
      reviews: [],
      comments: [
        { author: { login: 'bob' }, body: 'Nice work but check line 42' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('bob');
    expect(result).toContain('Nice work but check line 42');
  });

  test('skips empty approved reviews', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'APPROVED', body: '' },
      ],
      comments: [],
    });
    const result = parseReviewFeedback(json);
    expect(result).toBeUndefined();
  });

  test('skips empty commented reviews', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'COMMENTED', body: '' },
      ],
      comments: [],
    });
    const result = parseReviewFeedback(json);
    expect(result).toBeUndefined();
  });

  test('returns undefined for invalid JSON', () => {
    const result = parseReviewFeedback('not json');
    expect(result).toBeUndefined();
  });

  test('returns undefined when no actionable content', () => {
    const json = JSON.stringify({ reviews: [], comments: [] });
    const result = parseReviewFeedback(json);
    expect(result).toBeUndefined();
  });

  test('handles missing author gracefully', () => {
    const json = JSON.stringify({
      reviews: [
        { state: 'CHANGES_REQUESTED', body: 'Fix this' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('unknown');
    expect(result).toContain('Fix this');
  });
});

// ---------------------------------------------------------------------------
// readAgentSignal
// ---------------------------------------------------------------------------

const tmpDir = join(import.meta.dir, '..', '.test-tmp-runner');

beforeEach(async () => {
  await mkdir(join(tmpDir, '.agent-state'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('readAgentSignal', () => {
  test('reads valid blocked signal', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'signal.json'),
      JSON.stringify({ status: 'blocked', reason: 'Missing API key' }),
    );
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toEqual({ status: 'blocked', reason: 'Missing API key' });
  });

  test('reads valid needs_clarification signal', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'signal.json'),
      JSON.stringify({ status: 'needs_clarification', reason: 'Ambiguous requirement' }),
    );
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toEqual({ status: 'needs_clarification', reason: 'Ambiguous requirement' });
  });

  test('reads valid impossible signal', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'signal.json'),
      JSON.stringify({ status: 'impossible', reason: 'Library does not exist' }),
    );
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toEqual({ status: 'impossible', reason: 'Library does not exist' });
  });

  test('returns null for invalid status', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'signal.json'),
      JSON.stringify({ status: 'confused', reason: 'Not a valid status' }),
    );
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toBeNull();
  });

  test('returns null for invalid JSON', async () => {
    await Bun.write(join(tmpDir, '.agent-state', 'signal.json'), 'not json');
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toBeNull();
  });

  test('returns null for missing file', async () => {
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toBeNull();
  });

  test('returns null when reason is missing', async () => {
    await Bun.write(
      join(tmpDir, '.agent-state', 'signal.json'),
      JSON.stringify({ status: 'blocked' }),
    );
    const signal = await readAgentSignal(tmpDir);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseIssueMetadata — designless tasks
// ---------------------------------------------------------------------------

describe('parseIssueMetadata', () => {
  test('parses full structured metadata (design + branch + repo)', () => {
    const desc = 'design: docs/designs/auth.md\nbranch: agent/auth\nrepo: acme/app';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: 'docs/designs/auth.md',
      branch: 'agent/auth',
      repo: 'acme/app',
    });
  });

  test('parses designless metadata (branch + repo only)', () => {
    const desc = 'branch: agent/fix-bug\nrepo: acme/app';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: null,
      branch: 'agent/fix-bug',
      repo: 'acme/app',
    });
  });

  test('returns null when branch is missing', () => {
    const desc = 'design: docs/designs/foo.md\nrepo: acme/app';
    const result = parseIssueMetadata(desc);
    expect(result).toBeNull();
  });

  test('returns null when repo is missing', () => {
    const desc = 'design: docs/designs/foo.md\nbranch: agent/foo';
    const result = parseIssueMetadata(desc);
    expect(result).toBeNull();
  });

  test('returns null for empty description', () => {
    const result = parseIssueMetadata('');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildRetryContext
// ---------------------------------------------------------------------------

describe('buildRetryContext', () => {
  test('includes error summary from failed run', () => {
    const failedRun = {
      id: 'run-1',
      retry_attempt: 0,
      iterations: 2,
      error_summary: 'Agent timed out after 1800000ms',
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('Agent timed out');
    expect(context).toContain('Previous Attempt Failed');
    expect(context).toContain('Do NOT repeat');
  });

  test('includes log entries if available in buffer', () => {
    const runId = 'retry-test-run';
    logBuffers.set(runId, [
      { stream: 'stdout', content: 'tool: Read(...)' },
      { stream: 'system', content: '[runner] Session 1 exited' },
    ]);
    const failedRun = {
      id: runId,
      retry_attempt: 0,
      iterations: 1,
      error_summary: 'fail',
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('tool: Read');
    expect(context).toContain('Session 1 exited');
    expect(context).toContain('last 2 log entries');
    logBuffers.delete(runId);
  });

  test('handles missing log buffer gracefully', () => {
    const failedRun = {
      id: 'no-logs',
      retry_attempt: 1,
      iterations: 0,
      error_summary: 'crash',
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('crash');
    expect(context).not.toContain('log entries');
  });

  test('handles null error_summary', () => {
    const failedRun = {
      id: 'no-error',
      retry_attempt: 0,
      iterations: 0,
      error_summary: null,
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('Unknown error');
  });

  test('takes only last 30 log entries', () => {
    const runId = 'many-logs-run';
    const entries = Array.from({ length: 50 }, (_, i) => ({
      stream: 'stdout',
      content: `log line ${i}`,
    }));
    logBuffers.set(runId, entries);
    const failedRun = {
      id: runId,
      retry_attempt: 0,
      iterations: 3,
      error_summary: 'timeout',
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('last 30 log entries');
    expect(context).not.toContain('log line 19');
    expect(context).toContain('log line 20');
    expect(context).toContain('log line 49');
    logBuffers.delete(runId);
  });

  test('shows correct attempt number', () => {
    const failedRun = {
      id: 'attempt-2',
      retry_attempt: 1,
      iterations: 1,
      error_summary: 'failed again',
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('**Previous attempt**: 2');
  });
});

// ---------------------------------------------------------------------------
// chunkArray
// ---------------------------------------------------------------------------

describe('chunkArray', () => {
  test('splits array into chunks of specified size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('returns single chunk if array is smaller than size', () => {
    expect(chunkArray([1, 2], 5)).toEqual([[1, 2]]);
  });

  test('returns empty array for empty input', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});
