// Run status
export type RunStatus = 'queued' | 'running' | 'success' | 'failed';

// Project config from projects.json
export interface ProjectConfig {
  path?: string;
  repo: string;
  linearTeam: string;
  linearProfile?: string;
  baseBranch: string;
  init?: string[];
  description?: string;
}

// Projects registry (keyed by project name)
export type ProjectsConfig = Record<string, ProjectConfig>;

// Linear issue (parsed from lineark CLI output)
// Field names are provisional — validated at boundary
export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "ENG-57"
  title: string;
  description: string;
  [key: string]: unknown;
}

// Parsed issue metadata (extracted from description field)
export interface ParsedIssueMetadata {
  designPath: string; // e.g. "docs/designs/rate-limit-middleware.md"
  branch: string;     // e.g. "agent/rate-limit-middleware"
  repo: string;       // e.g. "belle/legalipro"
}

// Issue with parsed metadata
export interface Issue extends ParsedIssueMetadata {
  id: string;
  key: string;        // identifier e.g. "ENG-57"
  title: string;
  description: string;
  baseBranch: string;
}

// Database run record
export interface Run {
  id: string;                    // ULID
  project: string;
  issue_id: string;
  issue_key: string;
  issue_title: string;
  branch: string;
  worktree_path: string;
  status: RunStatus;
  is_revision: number;           // 0 or 1
  pr_number: number | null;
  agent_pid: number | null;
  error_summary: string | null;
  pr_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// SSE event types
export type SSEEvent =
  | { type: 'run_update'; run: Run }
  | { type: 'log'; runId: string; stream: string; content: string };

// Log entry
export interface LogEntry {
  id: number;
  run_id: string;
  stream: 'stdout' | 'stderr' | 'system';
  content: string;
  created_at: string;
}
