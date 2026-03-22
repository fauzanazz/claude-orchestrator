import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { Run, RunStatus, LogEntry } from './types.ts';

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
`);

// Prepared statements
const stmtInsertRun = db.prepare<void, [
  string, string, string, string, string, string, string, string, number, number | null
]>(`
  INSERT OR IGNORE INTO runs
    (id, project, issue_id, issue_key, issue_title, branch, worktree_path, status, is_revision, pr_number)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const stmtGetLogsForRun = db.prepare<LogEntry, [string]>(`
  SELECT * FROM logs WHERE run_id = ? ORDER BY id ASC
`);

const stmtMarkStaleRunsFailed = db.prepare<void, []>(`
  UPDATE runs
  SET status = 'failed',
      error_summary = 'orchestrator restarted',
      completed_at = datetime('now')
  WHERE status = 'running'
`);

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
    run.pr_number ?? null,
  );
}

export function updateRunStatus(
  id: string,
  status: RunStatus,
  extra?: Partial<Pick<Run, 'agent_pid' | 'error_summary' | 'pr_url' | 'started_at' | 'completed_at'>>
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

  db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...(values as [string, ...string[]]));
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

export function listRuns(filters?: { status?: RunStatus; project?: string }): Run[] {
  if (!filters || (!filters.status && !filters.project)) {
    return db.prepare<Run, []>('SELECT * FROM runs ORDER BY created_at DESC').all();
  }

  const conditions: string[] = [];
  const values: (string | number | null)[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    values.push(filters.status);
  }

  if (filters.project) {
    conditions.push('project = ?');
    values.push(filters.project);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare<Run, (string | number | null)[]>(`SELECT * FROM runs ${where} ORDER BY created_at DESC`).all(...(values as [string, ...string[]]));
}

export function insertLog(runId: string, stream: string, content: string): void {
  stmtInsertLog.run(runId, stream, content);
}

export function getLogsForRun(runId: string): LogEntry[] {
  return stmtGetLogsForRun.all(runId);
}

export function markStaleRunsFailed(): void {
  stmtMarkStaleRunsFailed.run();
}
