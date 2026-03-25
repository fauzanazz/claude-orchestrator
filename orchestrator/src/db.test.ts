import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { db, insertRun, insertLog, getPRNumberByIssueKey, updateRunStatus, deleteOldLogs, deleteOldRuns, deleteOldProcessedReviews, deleteOldNotifiedPRs, getDatabaseSize, getAnalyticsOverview, getProjectStats, getDailyThroughput, getFailureBreakdown } from './db.ts';

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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
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

// Helper to insert an analytics test run with direct SQL for full control
function createAnalyticsRun(opts: {
  id: string;
  project: string;
  status: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  iterations?: number;
  retry_attempt?: number;
  error_summary?: string | null;
}) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO runs (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, is_fix, fix_attempt, retry_attempt, iterations, error_summary, created_at, started_at, completed_at)
    VALUES (?, ?, 'issue-a', 'A-1', 'Test', 'branch-a', '/tmp/wt', ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.project,
    opts.status,
    opts.retry_attempt ?? 0,
    opts.iterations ?? 0,
    opts.error_summary ?? null,
    opts.created_at ?? now,
    opts.started_at ?? null,
    opts.completed_at ?? null,
  );
}

describe('analytics', () => {
  beforeEach(() => {
    cleanTables();
  });

  describe('getAnalyticsOverview', () => {
    test('returns zeroes when no runs exist', () => {
      const overview = getAnalyticsOverview(30);
      expect(overview.total_runs).toBe(0);
      expect(overview.success_rate).toBe(0);
      expect(overview.avg_duration_seconds).toBe(0);
      expect(overview.retry_rate).toBe(0);
    });

    test('computes correct counts and rates', () => {
      createAnalyticsRun({ id: 'a1', project: 'proj-a', status: 'success', started_at: '2026-03-25 00:00:00', completed_at: '2026-03-25 00:10:00' });
      createAnalyticsRun({ id: 'a2', project: 'proj-a', status: 'success' });
      createAnalyticsRun({ id: 'a3', project: 'proj-a', status: 'failed', error_summary: 'timed out' });
      createAnalyticsRun({ id: 'a4', project: 'proj-b', status: 'failed', retry_attempt: 1, error_summary: 'No commits produced' });

      const overview = getAnalyticsOverview(30);
      expect(overview.total_runs).toBe(4);
      expect(overview.success_count).toBe(2);
      expect(overview.failed_count).toBe(2);
      expect(overview.success_rate).toBe(50);
      expect(overview.retry_rate).toBe(25); // 1 out of 4
    });

    test('excludes fix runs', () => {
      createAnalyticsRun({ id: 'b1', project: 'proj-a', status: 'success' });
      // Insert a fix run directly
      db.prepare(`
        INSERT INTO runs (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, is_fix, fix_type, fix_attempt, retry_attempt, iterations, created_at)
        VALUES ('b2', 'proj-a', 'issue-a', 'A-1', 'Test', 'branch-a', '/tmp/wt', 'success', 0, 1, 'ci_failure', 1, 0, 0, datetime('now'))
      `).run();

      const overview = getAnalyticsOverview(30);
      expect(overview.total_runs).toBe(1); // fix run excluded
    });
  });

  describe('getProjectStats', () => {
    test('groups runs by project', () => {
      createAnalyticsRun({ id: 'p1', project: 'proj-a', status: 'success' });
      createAnalyticsRun({ id: 'p2', project: 'proj-a', status: 'failed' });
      createAnalyticsRun({ id: 'p3', project: 'proj-b', status: 'success' });

      const stats = getProjectStats(30);
      expect(stats.length).toBe(2);

      const projA = stats.find(s => s.project === 'proj-a');
      expect(projA).toBeTruthy();
      expect(projA!.total_runs).toBe(2);
      expect(projA!.success_count).toBe(1);
      expect(projA!.failed_count).toBe(1);

      const projB = stats.find(s => s.project === 'proj-b');
      expect(projB).toBeTruthy();
      expect(projB!.total_runs).toBe(1);
      expect(projB!.success_count).toBe(1);
    });

    test('returns empty array when no runs exist', () => {
      const stats = getProjectStats(30);
      expect(stats).toEqual([]);
    });
  });

  describe('getDailyThroughput', () => {
    test('returns date-keyed data', () => {
      createAnalyticsRun({ id: 'd1', project: 'proj-a', status: 'success', created_at: '2026-03-24 10:00:00' });
      createAnalyticsRun({ id: 'd2', project: 'proj-a', status: 'failed', created_at: '2026-03-24 14:00:00' });
      createAnalyticsRun({ id: 'd3', project: 'proj-a', status: 'success', created_at: '2026-03-25 09:00:00' });

      const throughput = getDailyThroughput(30);
      expect(throughput.length).toBe(2);
      for (const row of throughput) {
        expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(row.total).toBeGreaterThan(0);
      }

      const day24 = throughput.find(t => t.date === '2026-03-24');
      expect(day24).toBeTruthy();
      expect(day24!.total).toBe(2);
      expect(day24!.success).toBe(1);
      expect(day24!.failed).toBe(1);
    });

    test('returns empty array when no runs exist', () => {
      const throughput = getDailyThroughput(30);
      expect(throughput).toEqual([]);
    });
  });

  describe('getFailureBreakdown', () => {
    test('categorizes errors correctly', () => {
      createAnalyticsRun({ id: 'f1', project: 'proj-a', status: 'failed', error_summary: 'Agent timed out after 30m' });
      createAnalyticsRun({ id: 'f2', project: 'proj-a', status: 'failed', error_summary: 'No commits produced' });
      createAnalyticsRun({ id: 'f3', project: 'proj-a', status: 'failed', error_summary: 'No commits produced' });
      createAnalyticsRun({ id: 'f4', project: 'proj-a', status: 'failed', error_summary: 'orchestrator restarted' });
      createAnalyticsRun({ id: 'f5', project: 'proj-a', status: 'failed', error_summary: 'something unexpected' });

      const breakdown = getFailureBreakdown(30);
      expect(breakdown.length).toBeGreaterThan(0);

      const timeout = breakdown.find(b => b.category === 'Timeout');
      expect(timeout).toBeTruthy();
      expect(timeout!.count).toBe(1);

      const noCommits = breakdown.find(b => b.category === 'No commits produced');
      expect(noCommits).toBeTruthy();
      expect(noCommits!.count).toBe(2);

      const restart = breakdown.find(b => b.category === 'Orchestrator restart');
      expect(restart).toBeTruthy();
      expect(restart!.count).toBe(1);
    });

    test('filters by project when specified', () => {
      createAnalyticsRun({ id: 'g1', project: 'proj-a', status: 'failed', error_summary: 'timed out' });
      createAnalyticsRun({ id: 'g2', project: 'proj-b', status: 'failed', error_summary: 'timed out' });

      const breakdownA = getFailureBreakdown(30, 'proj-a');
      const total = breakdownA.reduce((sum, b) => sum + b.count, 0);
      expect(total).toBe(1);
    });

    test('returns empty array when no failures', () => {
      createAnalyticsRun({ id: 'h1', project: 'proj-a', status: 'success' });
      const breakdown = getFailureBreakdown(30);
      expect(breakdown).toEqual([]);
    });
  });
});
