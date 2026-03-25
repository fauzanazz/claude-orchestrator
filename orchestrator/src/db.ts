import { Database } from 'bun:sqlite';
import { join, dirname } from 'node:path';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import type { Run, RunStatus, LogEntry, FixTracking, Issue } from './types.ts';

const dbPath = process.env.ORCHESTRATOR_DB_PATH ?? join(import.meta.dir, '..', 'orchestrator.db');
export const db = new Database(dbPath, {
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

// Safe migration helper: only swallows "duplicate column" errors, rethrows everything else
function migrateAddColumn(sql: string): void {
  try {
    db.run(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column')) throw err;
  }
}

// Migrate: add fix columns to runs table
migrateAddColumn('ALTER TABLE runs ADD COLUMN is_fix INTEGER NOT NULL DEFAULT 0');
migrateAddColumn('ALTER TABLE runs ADD COLUMN fix_type TEXT');
migrateAddColumn('ALTER TABLE runs ADD COLUMN fix_attempt INTEGER NOT NULL DEFAULT 0');

// Migrate: add retry_attempt column for auto-retry
migrateAddColumn('ALTER TABLE runs ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0');

// Migrate: add issue metadata columns for restart persistence
migrateAddColumn('ALTER TABLE runs ADD COLUMN design_path TEXT');
migrateAddColumn('ALTER TABLE runs ADD COLUMN issue_repo TEXT');
migrateAddColumn('ALTER TABLE runs ADD COLUMN base_branch TEXT');

db.run(`
  CREATE TABLE IF NOT EXISTS fix_tracking (
    repo          TEXT NOT NULL,
    pr_number     INTEGER NOT NULL,
    fix_type      TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_run_id   TEXT REFERENCES runs(id),
    exhausted     INTEGER NOT NULL DEFAULT 0,
    resolved_at   TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo, pr_number, fix_type)
  );
`);

// Migration: add resolved_at column to fix_tracking
migrateAddColumn('ALTER TABLE fix_tracking ADD COLUMN resolved_at TEXT');

// Migrate: add token tracking columns
migrateAddColumn('ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0');
migrateAddColumn('ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0');
migrateAddColumn('ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0');
migrateAddColumn('ALTER TABLE runs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0');
migrateAddColumn('ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0');

// Migration: add iterations column
migrateAddColumn('ALTER TABLE runs ADD COLUMN iterations INTEGER NOT NULL DEFAULT 0');

// Prepared statements
const stmtInsertRun = db.prepare<void, [
  string, string, string, string, string, string, string, string, number, number, string | null, number, number, number | null, string | null, string | null, string | null
]>(`
  INSERT OR IGNORE INTO runs
    (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, is_fix, fix_type, fix_attempt, retry_attempt, pr_number, design_path, issue_repo, base_branch)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    run.retry_attempt,
    run.pr_number ?? null,
    run.design_path ?? null,
    run.issue_repo ?? null,
    run.base_branch ?? null,
  );
}

export function getIssueForRun(run: Run): Issue | null {
  if (!run.issue_repo || !run.base_branch) return null;
  return {
    id: run.issue_id,
    key: run.issue_key,
    title: run.issue_title,
    description: '', // not needed for execution
    designPath: run.design_path ?? null,
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

// ---------------------------------------------------------------------------
// Token tracking
// ---------------------------------------------------------------------------

const stmtUpdateRunTokens = db.prepare<void, [number, number, number, number, number, string]>(`
  UPDATE runs
  SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?
  WHERE id = ?
`);

export function updateRunTokens(
  id: string,
  tokens: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number },
): void {
  stmtUpdateRunTokens.run(
    tokens.input_tokens, tokens.output_tokens,
    tokens.cache_read_tokens, tokens.cache_creation_tokens,
    tokens.cost_usd, id,
  );
}

interface CostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_runs_with_cost: number;
  avg_cost_per_run: number;
  by_project: Array<{ project: string; total_cost: number; run_count: number }>;
}

export function getCostSummary(days: number): CostSummary {
  const totals = db.prepare<{
    total_cost: number; total_input: number; total_output: number;
    total_cache: number; run_count: number;
  }, [number]>(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache,
      COUNT(CASE WHEN cost_usd > 0 THEN 1 END) as run_count
    FROM runs
    WHERE created_at >= datetime('now', '-' || ? || ' days')
  `).get(days);

  const byProject = db.prepare<{ project: string; total_cost: number; run_count: number }, [number]>(`
    SELECT
      project,
      ROUND(COALESCE(SUM(cost_usd), 0), 4) as total_cost,
      COUNT(*) as run_count
    FROM runs
    WHERE created_at >= datetime('now', '-' || ? || ' days') AND cost_usd > 0
    GROUP BY project
    ORDER BY total_cost DESC
  `).all(days);

  return {
    total_cost_usd: Math.round((totals?.total_cost ?? 0) * 10000) / 10000,
    total_input_tokens: totals?.total_input ?? 0,
    total_output_tokens: totals?.total_output ?? 0,
    total_cache_read_tokens: totals?.total_cache ?? 0,
    total_runs_with_cost: totals?.run_count ?? 0,
    avg_cost_per_run: totals?.run_count ? Math.round(((totals?.total_cost ?? 0) / totals.run_count) * 10000) / 10000 : 0,
    by_project: byProject,
  };
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
  `UPDATE fix_tracking SET attempt_count = 0, resolved_at = datetime('now'), updated_at = datetime('now') WHERE repo = ? AND pr_number = ? AND fix_type = ?`
);

const stmtDeleteFixTracking = db.prepare<void, [string, number, string]>(
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

export function resolveFixTracking(repo: string, prNumber: number, fixType: string): void {
  stmtClearFixTracking.run(repo, prNumber, fixType);
}

export function deleteFixTracking(repo: string, prNumber: number, fixType: string): void {
  stmtDeleteFixTracking.run(repo, prNumber, fixType);
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

// ---------------------------------------------------------------------------
// Database retention & cleanup
// ---------------------------------------------------------------------------

export function deleteOldLogs(retentionDays: number): number {
  const result = db.prepare(`
    DELETE FROM logs
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function deleteOldRuns(retentionDays: number): number {
  const oldRunsFilter = `
    run_id IN (
      SELECT id FROM runs
      WHERE status IN ('success', 'failed')
        AND completed_at < datetime('now', '-' || ? || ' days')
    )
  `;

  db.prepare(`DELETE FROM logs WHERE ${oldRunsFilter}`).run(retentionDays);
  db.prepare(`DELETE FROM processed_reviews WHERE ${oldRunsFilter}`).run(retentionDays);
  db.prepare(`DELETE FROM fix_tracking WHERE last_run_id IN (
    SELECT id FROM runs
    WHERE status IN ('success', 'failed')
      AND completed_at < datetime('now', '-' || ? || ' days')
  )`).run(retentionDays);

  const result = db.prepare(`
    DELETE FROM runs
    WHERE status IN ('success', 'failed')
      AND completed_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function deleteOldProcessedReviews(retentionDays: number): number {
  const result = db.prepare(`
    DELETE FROM processed_reviews
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function deleteOldNotifiedPRs(retentionDays: number): number {
  const result = db.prepare(`
    DELETE FROM notified_prs
    WHERE notified_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return result.changes;
}

export function vacuumDatabase(): void {
  db.run('VACUUM');
}

export function getDatabaseSize(): number {
  const stat = db.prepare<{ page_count: number; page_size: number }, []>(
    `SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()`
  ).get();
  if (!stat) return 0;
  return stat.page_count * stat.page_size;
}

export function snapshotDatabase(maxSnapshots: number): string | null {
  if (dbPath === ':memory:') return null;

  const snapshotDir = join(dirname(dbPath), 'snapshots');
  mkdirSync(snapshotDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshotPath = join(snapshotDir, `orchestrator-${timestamp}.db`);

  db.run(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

  // Prune old snapshots beyond the limit
  const files = readdirSync(snapshotDir)
    .filter((f) => f.startsWith('orchestrator-') && f.endsWith('.db'))
    .sort();
  while (files.length > maxSnapshots) {
    const oldest = files.shift()!;
    unlinkSync(join(snapshotDir, oldest));
  }

  return snapshotPath;
}

// ---------------------------------------------------------------------------
// Rate limiting: retry tracking queries
// ---------------------------------------------------------------------------

const stmtCountQueuedForIssue = db.prepare<{ count: number }, [string]>(`
  SELECT COUNT(*) as count FROM runs
  WHERE issue_id = ? AND status = 'queued'
`);

const stmtLatestRetryTime = db.prepare<{ created_at: string } | null, [string, string]>(`
  SELECT created_at FROM runs
  WHERE issue_id = ? AND id != ?
  ORDER BY created_at DESC LIMIT 1
`);

export function countQueuedForIssue(issueId: string): number {
  return stmtCountQueuedForIssue.get(issueId)?.count ?? 0;
}

export function getLatestRunTimeForIssue(issueId: string, excludeRunId: string): string | null {
  return stmtLatestRetryTime.get(issueId, excludeRunId)?.created_at ?? null;
}

export function countTotalQueued(): number {
  return db.prepare<{ count: number }, []>(
    `SELECT COUNT(*) as count FROM runs WHERE status = 'queued'`
  ).get()?.count ?? 0;
}

export function hasAnyRunForIssue(issueId: string): boolean {
  return db.prepare<{ id: string }, [string]>(
    `SELECT id FROM runs WHERE issue_id = ? LIMIT 1`
  ).get(issueId) !== null;
}

export function hasActiveRunForIssue(issueId: string, excludeRunId?: string): boolean {
  if (excludeRunId) {
    return db.prepare<{ id: string }, [string, string]>(
      `SELECT id FROM runs WHERE issue_id = ? AND status IN ('queued', 'running') AND id != ? LIMIT 1`
    ).get(issueId, excludeRunId) !== null;
  }
  return db.prepare<{ id: string }, [string]>(
    `SELECT id FROM runs WHERE issue_id = ? AND status IN ('queued', 'running') LIMIT 1`
  ).get(issueId) !== null;
}

export function getSiblingOpenPRRuns(project: string, excludeIssueKey: string): Run[] {
  return db.prepare<Run, [string, string]>(`
    SELECT * FROM runs
    WHERE project = ?
      AND issue_key != ?
      AND pr_number IS NOT NULL
      AND status = 'success'
      AND is_fix = 0
      AND is_revision = 0
    ORDER BY created_at ASC
  `).all(project, excludeIssueKey);
}

// ---------------------------------------------------------------------------
// Analytics queries
// ---------------------------------------------------------------------------

interface AnalyticsOverview {
  total_runs: number;
  success_count: number;
  failed_count: number;
  success_rate: number;
  avg_duration_seconds: number;
  avg_iterations: number;
  retry_rate: number;
}

interface ProjectStats {
  project: string;
  total_runs: number;
  success_count: number;
  failed_count: number;
  success_rate: number;
  avg_duration_seconds: number;
  avg_iterations: number;
}

interface DailyThroughput {
  date: string;
  total: number;
  success: number;
  failed: number;
}

interface FailureBreakdown {
  category: string;
  count: number;
}

export function getAnalyticsOverview(days: number): AnalyticsOverview {
  const row = db.prepare<{
    total_runs: number;
    success_count: number;
    failed_count: number;
    avg_duration: number | null;
    avg_iterations: number | null;
    retry_count: number;
  }, [number]>(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN status IN ('success', 'merged') THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(started_at)) * 86400
          ELSE NULL END) as avg_duration,
      AVG(iterations) as avg_iterations,
      SUM(CASE WHEN retry_attempt > 0 THEN 1 ELSE 0 END) as retry_count
    FROM runs
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND is_fix = 0
  `).get(days);

  if (!row) return { total_runs: 0, success_count: 0, failed_count: 0, success_rate: 0, avg_duration_seconds: 0, avg_iterations: 0, retry_rate: 0 };

  return {
    total_runs: row.total_runs,
    success_count: row.success_count,
    failed_count: row.failed_count,
    success_rate: row.total_runs > 0 ? Math.round((row.success_count / row.total_runs) * 100) : 0,
    avg_duration_seconds: Math.round(row.avg_duration ?? 0),
    avg_iterations: Math.round((row.avg_iterations ?? 0) * 10) / 10,
    retry_rate: row.total_runs > 0 ? Math.round((row.retry_count / row.total_runs) * 100) : 0,
  };
}

export function getProjectStats(days: number): ProjectStats[] {
  return db.prepare<ProjectStats, [number]>(`
    SELECT
      project,
      COUNT(*) as total_runs,
      SUM(CASE WHEN status IN ('success', 'merged') THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      ROUND(AVG(CASE WHEN status IN ('success', 'merged') THEN 100.0 ELSE 0 END), 1) as success_rate,
      ROUND(AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(started_at)) * 86400
          ELSE NULL END)) as avg_duration_seconds,
      ROUND(AVG(iterations), 1) as avg_iterations
    FROM runs
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND is_fix = 0
    GROUP BY project
    ORDER BY total_runs DESC
  `).all(days);
}

export function getDailyThroughput(days: number): DailyThroughput[] {
  return db.prepare<DailyThroughput, [number]>(`
    SELECT
      date(created_at) as date,
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('success', 'merged') THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM runs
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND is_fix = 0
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(days);
}

export function getFailureBreakdown(days: number, project?: string): FailureBreakdown[] {
  const whereProject = project ? ' AND project = ?' : '';
  const params: (number | string)[] = project ? [days, project] : [days];
  return db.prepare<FailureBreakdown, (number | string)[]>(`
    SELECT
      CASE
        WHEN error_summary LIKE '%timed out%' THEN 'Timeout'
        WHEN error_summary LIKE '%No commits%' THEN 'No commits produced'
        WHEN error_summary LIKE '%Queue full%' THEN 'Queue full'
        WHEN error_summary LIKE '%duplicate%' THEN 'Duplicate run'
        WHEN error_summary LIKE '%restarted%' THEN 'Orchestrator restart'
        WHEN error_summary LIKE '%non-retryable%' OR error_summary LIKE '%Non-retryable%' THEN 'Non-retryable error'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM runs
    WHERE status = 'failed'
      AND created_at >= datetime('now', '-' || ? || ' days')
      AND is_fix = 0
      ${whereProject}
    GROUP BY category
    ORDER BY count DESC
  `).all(...(params as [number, ...string[]]));
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
