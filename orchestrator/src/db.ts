import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { Run, RunStatus, LogEntry, FixTracking, Issue } from './types.ts';

export const db = new Database(join(import.meta.dir, '..', 'orchestrator.db'), {
  create: true,
});

// Enable WAL mode for better concurrent read performance
db.run('PRAGMA journal_mode = WAL;');
db.run('PRAGMA foreign_keys = ON;');

// Schema init
db.run(`
  CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    project       TEXT NOT NULL,
    issue_id      TEXT NOT NULL,
    issue_key     TEXT NOT NULL,
    issue_title   TEXT NOT NULL,
    branch        TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    is_revision   INTEGER NOT NULL DEFAULT 0,
    pr_number     INTEGER,
    agent_pid     INTEGER,
    error_summary TEXT,
    pr_url        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    completed_at  TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_issue_status ON runs(issue_id, status)
    WHERE status IN ('queued', 'running');

  CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(id),
    stream     TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_branch ON runs(branch);
  CREATE INDEX IF NOT EXISTS idx_logs_run_id ON logs(run_id);

  CREATE TABLE IF NOT EXISTS processed_reviews (
    review_id   TEXT PRIMARY KEY,
    pr_number   INTEGER NOT NULL,
    repo        TEXT NOT NULL,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_processed_reviews_pr
    ON processed_reviews(repo, pr_number);

  CREATE TABLE IF NOT EXISTS notified_prs (
    repo        TEXT NOT NULL,
    pr_number   INTEGER NOT NULL,
    notified_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo, pr_number)
  );
`);

// Migrate: add fix columns to runs table
try { db.run('ALTER TABLE runs ADD COLUMN is_fix INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.run('ALTER TABLE runs ADD COLUMN fix_type TEXT'); } catch {}
try { db.run('ALTER TABLE runs ADD COLUMN fix_attempt INTEGER NOT NULL DEFAULT 0'); } catch {}

// Migrate: add issue metadata columns for restart persistence
try { db.run('ALTER TABLE runs ADD COLUMN design_path TEXT'); } catch {}
try { db.run('ALTER TABLE runs ADD COLUMN issue_repo TEXT'); } catch {}
try { db.run('ALTER TABLE runs ADD COLUMN base_branch TEXT'); } catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS fix_tracking (
    repo          TEXT NOT NULL,
    pr_number     INTEGER NOT NULL,
    fix_type      TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_run_id   TEXT REFERENCES runs(id),
    exhausted     INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo, pr_number, fix_type)
  );
`);

// Migration: add iterations column
try {
  db.run(`ALTER TABLE runs ADD COLUMN iterations INTEGER NOT NULL DEFAULT 0`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes('duplicate column')) {
    throw err;
  }
}

// Prepared statements
const stmtInsertRun = db.prepare<void, [
  string, string, string, string, string, string, string, string, number, number, string | null, number, number | null, string | null, string | null, string | null
]>(`
  INSERT OR IGNORE INTO runs
    (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, is_fix, fix_type, fix_attempt, pr_number, design_path, issue_repo, base_branch)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetRunById = db.prepare<Run, [string]>(`
  SELECT * FROM runs WHERE id = ? LIMIT 1
`);

const stmtGetRunByBranch = db.prepare<Run, [string]>(`
  SELECT * FROM runs WHERE branch = ? ORDER BY created_at DESC LIMIT 1
`);

const stmtGetRunsByStatus = db.prepare<Run, [string]>(`
  SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC
`);

const stmtInsertLog = db.prepare<void, [string, string, string]>(`
  INSERT INTO logs (run_id, stream, content) VALUES (?, ?, ?)
`);

const stmtMarkStaleRunsFailed = db.prepare<void, []>(`
  UPDATE runs
  SET status = 'failed',
      error_summary = 'orchestrator restarted',
      completed_at = datetime('now')
  WHERE status = 'running'
`);

// Cache for dynamically-built UPDATE statements, keyed by the sorted field list.
// This avoids recompiling SQL on every updateRunStatus call while preserving
// the ability to update only the fields that are actually changing.
const stmtUpdateRunStatusCache = new Map<string, ReturnType<typeof db.prepare>>();

function getUpdateRunStatusStmt(fields: string[]): ReturnType<typeof db.prepare> {
  const key = fields.join(',');
  let stmt = stmtUpdateRunStatusCache.get(key);
  if (!stmt) {
    stmt = db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`);
    stmtUpdateRunStatusCache.set(key, stmt);
  }
  return stmt;
}

// Exported functions

export function insertRun(
  run: Omit<Run, 'created_at' | 'started_at' | 'completed_at'>
): void {
  stmtInsertRun.run(
    run.id,
    run.project,
    run.issue_id,
    run.issue_key,
    run.issue_title,
    run.branch,
    run.worktree_path,
    run.status,
    run.is_revision,
    run.is_fix,
    run.fix_type ?? null,
    run.fix_attempt,
    run.pr_number ?? null,
    run.design_path ?? null,
    run.issue_repo ?? null,
    run.base_branch ?? null,
  );
}

export function getIssueForRun(run: Run): Issue | null {
  if (!run.design_path || !run.issue_repo || !run.base_branch) return null;
  return {
    id: run.issue_id,
    key: run.issue_key,
    title: run.issue_title,
    description: '', // not needed for execution
    designPath: run.design_path,
    branch: run.branch,
    repo: run.issue_repo,
    baseBranch: run.base_branch,
    parentKey: null, // not available from DB, but PR linking is best-effort
  };
}

export function updateRunStatus(
  id: string,
  status: RunStatus,
  extra?: Partial<Pick<Run, 'agent_pid' | 'error_summary' | 'pr_url' | 'pr_number' | 'started_at' | 'completed_at'>>
): void {
  const fields: string[] = ['status = ?'];
  const values: (string | number | null)[] = [status];

  if (extra) {
    if ('agent_pid' in extra) {
      fields.push('agent_pid = ?');
      values.push(extra.agent_pid ?? null);
    }
    if ('error_summary' in extra) {
      fields.push('error_summary = ?');
      values.push(extra.error_summary ?? null);
    }
    if ('pr_url' in extra) {
      fields.push('pr_url = ?');
      values.push(extra.pr_url ?? null);
    }
    if ('pr_number' in extra) {
      fields.push('pr_number = ?');
      values.push(extra.pr_number ?? null);
    }
    if ('started_at' in extra) {
      fields.push('started_at = ?');
      values.push(extra.started_at ?? null);
    }
    if ('completed_at' in extra) {
      fields.push('completed_at = ?');
      values.push(extra.completed_at ?? null);
    }
  }

  values.push(id);

  getUpdateRunStatusStmt(fields).run(...(values as [string, ...string[]]));
}

export function getRun(id: string): Run | null {
  return stmtGetRunById.get(id) ?? null;
}

export function getRunByBranch(branch: string): Run | null {
  return stmtGetRunByBranch.get(branch) ?? null;
}

export function getRunsByStatus(status: RunStatus): Run[] {
  return stmtGetRunsByStatus.all(status);
}

export function listRuns(filters?: { status?: RunStatus; project?: string; limit?: number; offset?: number }): Run[] {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  const conditions: string[] = [];
  const values: (string | number | null)[] = [];

  if (filters?.status) {
    conditions.push('status = ?');
    values.push(filters.status);
  }

  if (filters?.project) {
    conditions.push('project = ?');
    values.push(filters.project);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);
  return db.prepare<Run, (string | number | null)[]>(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...(values as [string, ...string[]]));
}

export function insertLog(runId: string, stream: string, content: string): void {
  stmtInsertLog.run(runId, stream, content);
}

export function getLogsForRun(runId: string, limit?: number, offset?: number): LogEntry[] {
  const l = limit ?? 1000;
  const o = offset ?? 0;
  return db.prepare<LogEntry, [string, number, number]>(
    'SELECT * FROM logs WHERE run_id = ? ORDER BY id ASC LIMIT ? OFFSET ?'
  ).all(runId, l, o);
}

const stmtUpdateRunIterations = db.prepare<void, [number, string]>(
  `UPDATE runs SET iterations = ? WHERE id = ?`
);

export function updateRunIterations(id: string, iterations: number): void {
  stmtUpdateRunIterations.run(iterations, id);
}

export function markStaleRunsFailed(): void {
  stmtMarkStaleRunsFailed.run();
}

// ---------------------------------------------------------------------------
// Processed reviews (deduplication for PR review watching)
// ---------------------------------------------------------------------------

const stmtIsReviewProcessed = db.prepare<{ review_id: string }, [string]>(
  `SELECT review_id FROM processed_reviews WHERE review_id = ? LIMIT 1`
);

const stmtMarkReviewProcessed = db.prepare<void, [string, number, string, string]>(
  `INSERT OR IGNORE INTO processed_reviews (review_id, pr_number, repo, run_id) VALUES (?, ?, ?, ?)`
);

const stmtGetWatchableRuns = db.prepare<Run, [number]>(`
  SELECT * FROM runs
  WHERE status = 'success'
    AND pr_url IS NOT NULL
    AND pr_number IS NOT NULL
    AND created_at > datetime('now', '-' || ? || ' days')
  ORDER BY created_at DESC
`);

export function isReviewProcessed(reviewId: string): boolean {
  return stmtIsReviewProcessed.get(reviewId) !== null;
}

export function markReviewProcessed(
  reviewId: string,
  prNumber: number,
  repo: string,
  runId: string,
): void {
  stmtMarkReviewProcessed.run(reviewId, prNumber, repo, runId);
}

export function getWatchableRuns(maxAgeDays: number): Run[] {
  return stmtGetWatchableRuns.all(maxAgeDays);
}

// ---------------------------------------------------------------------------
// PR merge-readiness notifications (deduplication)
// ---------------------------------------------------------------------------

const stmtIsPRNotified = db.prepare<{ repo: string }, [string, number]>(
  `SELECT repo FROM notified_prs WHERE repo = ? AND pr_number = ? LIMIT 1`
);

const stmtMarkPRNotified = db.prepare<void, [string, number]>(
  `INSERT OR IGNORE INTO notified_prs (repo, pr_number) VALUES (?, ?)`
);

const stmtClearPRNotified = db.prepare<void, [string, number]>(
  `DELETE FROM notified_prs WHERE repo = ? AND pr_number = ?`
);

export function isPRNotified(repo: string, prNumber: number): boolean {
  return stmtIsPRNotified.get(repo, prNumber) !== null;
}

export function markPRNotified(repo: string, prNumber: number): void {
  stmtMarkPRNotified.run(repo, prNumber);
}

export function clearPRNotified(repo: string, prNumber: number): void {
  stmtClearPRNotified.run(repo, prNumber);
}

// ---------------------------------------------------------------------------
// Fix tracking (deduplication & retry counting for auto-fix)
// ---------------------------------------------------------------------------

const stmtGetFixTracking = db.prepare<FixTracking, [string, number, string]>(
  `SELECT * FROM fix_tracking WHERE repo = ? AND pr_number = ? AND fix_type = ? LIMIT 1`
);

const stmtClearFixTracking = db.prepare<void, [string, number, string]>(
  `DELETE FROM fix_tracking WHERE repo = ? AND pr_number = ? AND fix_type = ?`
);

export function getFixTracking(repo: string, prNumber: number, fixType: string): FixTracking | null {
  return stmtGetFixTracking.get(repo, prNumber, fixType) ?? null;
}

export function upsertFixTracking(
  repo: string,
  prNumber: number,
  fixType: string,
  runId: string,
): void {
  const existing = getFixTracking(repo, prNumber, fixType);
  if (existing) {
    db.prepare(`
      UPDATE fix_tracking
      SET attempt_count = attempt_count + 1, last_run_id = ?, updated_at = datetime('now')
      WHERE repo = ? AND pr_number = ? AND fix_type = ?
    `).run(runId, repo, prNumber, fixType);
  } else {
    db.prepare(`
      INSERT INTO fix_tracking (repo, pr_number, fix_type, attempt_count, last_run_id)
      VALUES (?, ?, ?, 1, ?)
    `).run(repo, prNumber, fixType, runId);
  }
}

export function markFixExhausted(repo: string, prNumber: number, fixType: string): void {
  db.prepare(`UPDATE fix_tracking SET exhausted = 1, updated_at = datetime('now') WHERE repo = ? AND pr_number = ? AND fix_type = ?`)
    .run(repo, prNumber, fixType);
}

export function clearFixTracking(repo: string, prNumber: number, fixType: string): void {
  stmtClearFixTracking.run(repo, prNumber, fixType);
}

const stmtGetPRByIssueKey = db.prepare<{ pr_number: number } | null, [string]>(`
  SELECT pr_number FROM runs
  WHERE issue_key = ?
    AND pr_number IS NOT NULL
    AND is_fix = 0
    AND is_revision = 0
    AND status = 'success'
  ORDER BY created_at DESC LIMIT 1
`);

export function getPRNumberByIssueKey(issueKey: string): number | null {
  const row = stmtGetPRByIssueKey.get(issueKey);
  return row?.pr_number ?? null;
}

export function getRunByPRNumber(prNumber: number, projectKey?: string): Run | null {
  // Find the original (non-fix, non-revision) run that created this PR
  if (projectKey) {
    return db.prepare<Run, [number, string]>(`
      SELECT * FROM runs
      WHERE pr_number = ?
        AND project = ?
        AND is_fix = 0
        AND is_revision = 0
        AND status = 'success'
      ORDER BY created_at ASC LIMIT 1
    `).get(prNumber, projectKey) ?? null;
  }
  return db.prepare<Run, [number]>(`
    SELECT * FROM runs
    WHERE pr_number = ?
      AND is_fix = 0
      AND is_revision = 0
      AND status = 'success'
    ORDER BY created_at ASC LIMIT 1
  `).get(prNumber) ?? null;
}
