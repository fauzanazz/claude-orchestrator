import { describe, test, expect, beforeEach } from 'bun:test';
import { db, insertRun, countTotalQueued, countQueuedForIssue, getLatestRunTimeForIssue } from './db.ts';
import type { Run, RunStatus } from './types.ts';

function makeRun(overrides: Partial<Run> = {}): Omit<Run, 'created_at' | 'started_at' | 'completed_at'> {
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    project: 'test-project',
    issue_id: 'issue-1',
    issue_key: 'TEST-1',
    issue_title: 'Test issue',
    branch: 'agent/test',
    worktree_path: '/tmp/test',
    status: 'queued' as RunStatus,
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
    design_path: null,
    issue_repo: null,
    base_branch: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.run('DELETE FROM logs');
  db.run('DELETE FROM runs');
});

describe('countTotalQueued', () => {
  test('returns 0 when no runs exist', () => {
    expect(countTotalQueued()).toBe(0);
  });

  test('counts only queued runs', () => {
    // Each queued run needs a unique issue_id due to unique index on (issue_id, status)
    insertRun(makeRun({ id: 'r1', issue_id: 'issue-1', issue_key: 'TEST-1', status: 'queued' }));
    insertRun(makeRun({ id: 'r2', issue_id: 'issue-2', issue_key: 'TEST-2', status: 'queued' }));
    insertRun(makeRun({ id: 'r3', issue_id: 'issue-3', issue_key: 'TEST-3', status: 'failed' }));
    insertRun(makeRun({ id: 'r4', issue_id: 'issue-4', issue_key: 'TEST-4', status: 'running' }));

    expect(countTotalQueued()).toBe(2);
  });
});

describe('countQueuedForIssue', () => {
  test('returns 0 when no queued runs for issue', () => {
    insertRun(makeRun({ id: 'r1', status: 'failed' }));
    expect(countQueuedForIssue('issue-1')).toBe(0);
  });

  test('counts queued runs scoped to specific issue', () => {
    insertRun(makeRun({ id: 'r1', issue_id: 'issue-1', status: 'queued' }));
    insertRun(makeRun({ id: 'r2', issue_id: 'issue-2', issue_key: 'TEST-2', status: 'queued' }));

    expect(countQueuedForIssue('issue-1')).toBe(1);
    expect(countQueuedForIssue('issue-2')).toBe(1);
  });

  test('different issues get independent limits', () => {
    insertRun(makeRun({ id: 'r1', issue_id: 'issue-A', issue_key: 'A-1', status: 'queued' }));
    insertRun(makeRun({ id: 'r2', issue_id: 'issue-B', issue_key: 'B-1', status: 'queued' }));
    insertRun(makeRun({ id: 'r3', issue_id: 'issue-A', issue_key: 'A-1', status: 'failed' }));

    // Only 1 queued per issue (unique index constraint), but failed runs don't count
    expect(countQueuedForIssue('issue-A')).toBe(1);
    expect(countQueuedForIssue('issue-B')).toBe(1);
    expect(countQueuedForIssue('issue-C')).toBe(0);
  });
});

describe('getLatestRunTimeForIssue', () => {
  test('returns null when no other runs exist', () => {
    insertRun(makeRun({ id: 'r1', issue_id: 'issue-1' }));
    expect(getLatestRunTimeForIssue('issue-1', 'r1')).toBeNull();
  });

  test('returns latest run time excluding the specified run', () => {
    insertRun(makeRun({ id: 'r1', issue_id: 'issue-1', status: 'failed' }));
    insertRun(makeRun({ id: 'r2', issue_id: 'issue-1', status: 'queued' }));

    const latest = getLatestRunTimeForIssue('issue-1', 'r1');
    expect(latest).not.toBeNull();
    expect(typeof latest).toBe('string');
  });

  test('does not return runs from different issues', () => {
    insertRun(makeRun({ id: 'r1', issue_id: 'issue-1' }));
    insertRun(makeRun({ id: 'r2', issue_id: 'issue-2', issue_key: 'TEST-2' }));

    expect(getLatestRunTimeForIssue('issue-1', 'r1')).toBeNull();
  });
});
