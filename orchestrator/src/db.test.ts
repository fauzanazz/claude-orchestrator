import { describe, test, expect } from 'bun:test';
import { insertRun, getPRNumberByIssueKey, updateRunStatus } from './db.ts';

describe('getPRNumberByIssueKey', () => {
  test('returns PR number for a successful run with matching issue key', () => {
    const runId = `test-pr-lookup-${Date.now()}`;
    insertRun({
      id: runId,
      project: 'test-project',
      issue_id: 'issue-99',
      issue_key: 'FAU-99',
      issue_title: 'Test issue',
      branch: 'agent/test-pr-lookup',
      worktree_path: '/tmp/test',
      status: 'queued',
      is_revision: 0,
      is_fix: 0,
      fix_type: null,
      fix_attempt: 0,
      retry_attempt: 0,
      pr_number: 42,
      agent_pid: null,
      iterations: 0,
      error_summary: null,
      pr_url: null,
      design_path: null,
      issue_repo: null,
      base_branch: null,
    });
    updateRunStatus(runId, 'success', {
      completed_at: new Date().toISOString(),
    });

    expect(getPRNumberByIssueKey('FAU-99')).toBe(42);
  });

  test('returns null for a non-existent issue key', () => {
    expect(getPRNumberByIssueKey('FAU-NONEXISTENT')).toBeNull();
  });

  test('returns null for a failed run', () => {
    const runId = `test-pr-lookup-failed-${Date.now()}`;
    insertRun({
      id: runId,
      project: 'test-project',
      issue_id: 'issue-failed',
      issue_key: 'FAU-FAILED',
      issue_title: 'Failed issue',
      branch: 'agent/test-failed',
      worktree_path: '/tmp/test-failed',
      status: 'queued',
      is_revision: 0,
      is_fix: 0,
      fix_type: null,
      fix_attempt: 0,
      retry_attempt: 0,
      pr_number: 55,
      agent_pid: null,
      iterations: 0,
      error_summary: null,
      pr_url: null,
      design_path: null,
      issue_repo: null,
      base_branch: null,
    });
    updateRunStatus(runId, 'failed', {
      error_summary: 'test failure',
      completed_at: new Date().toISOString(),
    });

    expect(getPRNumberByIssueKey('FAU-FAILED')).toBeNull();
  });

  test('ignores fix and revision runs', () => {
    const runId = `test-pr-lookup-fix-${Date.now()}`;
    insertRun({
      id: runId,
      project: 'test-project',
      issue_id: 'issue-fix',
      issue_key: 'FAU-FIX',
      issue_title: 'Fix issue',
      branch: 'agent/test-fix',
      worktree_path: '/tmp/test-fix',
      status: 'queued',
      is_revision: 0,
      is_fix: 1,
      fix_type: 'ci_failure',
      fix_attempt: 1,
      retry_attempt: 0,
      pr_number: 77,
      agent_pid: null,
      iterations: 0,
      error_summary: null,
      pr_url: null,
      design_path: null,
      issue_repo: null,
      base_branch: null,
    });
    updateRunStatus(runId, 'success', {
      completed_at: new Date().toISOString(),
    });

    expect(getPRNumberByIssueKey('FAU-FIX')).toBeNull();
  });
});
