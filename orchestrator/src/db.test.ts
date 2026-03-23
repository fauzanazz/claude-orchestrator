import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { db, insertRun, insertLog, getPRNumberByIssueKey, updateRunStatus, deleteOldLogs, deleteOldRuns, deleteOldProcessedReviews, deleteOldNotifiedPRs, getDatabaseSize } from './db.ts';

// Safety: abort if tests are running against the production database
beforeAll(() => {
  const filename = (db as any).filename;
  if (filename && filename !== ':memory:' && filename !== '' && !filename.includes('test')) {
    throw new Error(
      `Tests are targeting the production DB (${filename}). ` +
      `Run tests from orchestrator/ so bunfig.toml preload applies.`
    );
  }
});

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

function createTestRun(overrides: {
  id: string;
  status?: string;
  completed_at?: string;
  created_at?: string;
}) {
  const id = overrides.id;
  const status = overrides.status ?? 'success';
  db.prepare(`
    INSERT INTO runs (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, is_fix, fix_attempt, retry_attempt, created_at, completed_at)
    VALUES (?, 'test-proj', 'issue-1', 'TST-1', 'Test', 'branch-1', '/tmp/wt', ?, 0, 0, 0, 0, ?, ?)
  `).run(
    id,
    status,
    overrides.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    overrides.completed_at ?? null,
  );
}

function createTestLog(runId: string, createdAt?: string) {
  if (createdAt) {
    db.prepare(`
      INSERT INTO logs (run_id, stream, content, created_at) VALUES (?, 'stdout', 'test log', ?)
    `).run(runId, createdAt);
  } else {
    insertLog(runId, 'stdout', 'test log');
  }
}

function cleanTables() {
  db.run('DELETE FROM logs');
  db.run('DELETE FROM processed_reviews');
  db.run('DELETE FROM notified_prs');
  db.run('DELETE FROM fix_tracking');
  db.run('DELETE FROM runs');
}

describe('database retention & cleanup', () => {
  beforeEach(() => {
    cleanTables();
  });

  describe('deleteOldLogs', () => {
    test('deletes logs older than retention period', () => {
      createTestRun({ id: 'run-1' });
      createTestLog('run-1', '2020-01-01 00:00:00');
      createTestLog('run-1', '2020-01-02 00:00:00');

      const deleted = deleteOldLogs(30);
      expect(deleted).toBe(2);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number };
      expect(remaining.count).toBe(0);
    });

    test('keeps logs within retention period', () => {
      createTestRun({ id: 'run-2' });
      createTestLog('run-2'); // created now

      const deleted = deleteOldLogs(30);
      expect(deleted).toBe(0);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number };
      expect(remaining.count).toBe(1);
    });
  });

  describe('deleteOldRuns', () => {
    test('deletes completed runs older than retention period', () => {
      createTestRun({ id: 'run-old-success', status: 'success', completed_at: '2020-01-01 00:00:00', created_at: '2020-01-01 00:00:00' });
      createTestRun({ id: 'run-old-failed', status: 'failed', completed_at: '2020-01-02 00:00:00', created_at: '2020-01-02 00:00:00' });

      const deleted = deleteOldRuns(30);
      expect(deleted).toBe(2);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM runs').get() as { count: number };
      expect(remaining.count).toBe(0);
    });

    test('keeps recent completed runs', () => {
      // Use a recent completed_at
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      createTestRun({ id: 'run-recent', status: 'success', completed_at: now, created_at: now });

      const deleted = deleteOldRuns(30);
      expect(deleted).toBe(0);
    });

    test('never deletes running or queued runs regardless of age', () => {
      createTestRun({ id: 'run-running', status: 'running', created_at: '2020-01-01 00:00:00' });
      createTestRun({ id: 'run-queued', status: 'queued', created_at: '2020-01-01 00:00:00' });

      const deleted = deleteOldRuns(30);
      expect(deleted).toBe(0);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM runs').get() as { count: number };
      expect(remaining.count).toBe(2);
    });

    test('cascading: also deletes associated logs when runs are deleted', () => {
      createTestRun({ id: 'run-cascade', status: 'success', completed_at: '2020-01-01 00:00:00', created_at: '2020-01-01 00:00:00' });
      createTestLog('run-cascade', '2020-01-01 00:00:00');
      createTestLog('run-cascade', '2020-01-01 01:00:00');

      deleteOldRuns(30);

      const remainingLogs = db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number };
      expect(remainingLogs.count).toBe(0);
    });
  });

  describe('deleteOldProcessedReviews', () => {
    test('deletes reviews older than retention period', () => {
      createTestRun({ id: 'run-rev' });
      db.prepare(`
        INSERT INTO processed_reviews (review_id, pr_number, repo, run_id, created_at)
        VALUES ('rev-1', 1, 'org/repo', 'run-rev', '2020-01-01 00:00:00')
      `).run();

      const deleted = deleteOldProcessedReviews(30);
      expect(deleted).toBe(1);
    });

    test('keeps recent reviews', () => {
      createTestRun({ id: 'run-rev2' });
      db.prepare(`
        INSERT INTO processed_reviews (review_id, pr_number, repo, run_id)
        VALUES ('rev-2', 1, 'org/repo', 'run-rev2')
      `).run();

      const deleted = deleteOldProcessedReviews(30);
      expect(deleted).toBe(0);
    });
  });

  describe('deleteOldNotifiedPRs', () => {
    test('deletes notifications older than retention period', () => {
      db.prepare(`
        INSERT INTO notified_prs (repo, pr_number, notified_at)
        VALUES ('org/repo', 1, '2020-01-01 00:00:00')
      `).run();

      const deleted = deleteOldNotifiedPRs(30);
      expect(deleted).toBe(1);
    });

    test('keeps recent notifications', () => {
      db.prepare(`
        INSERT INTO notified_prs (repo, pr_number)
        VALUES ('org/repo', 2)
      `).run();

      const deleted = deleteOldNotifiedPRs(30);
      expect(deleted).toBe(0);
    });
  });

  describe('getDatabaseSize', () => {
    test('returns a positive number', () => {
      const size = getDatabaseSize();
      expect(size).toBeGreaterThan(0);
    });
  });
});
