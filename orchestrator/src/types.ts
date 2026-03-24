// Run status
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'merged' | 'closed';

export type FixType = 'merge_conflict' | 'ci_failure';

// Project config from projects.json
export interface ProjectConfig {
  path?: string;
  repo: string;
  linearTeam: string;
  linearProfile?: string;
  baseBranch: string;
  init?: string[];
  description?: string;
  allowedTools?: string[];  // Claude Code tool/command patterns for settings.json allow list
  linearProject?: string;
  model?: string;       // Default model for normal runs (e.g., "claude-sonnet-4-20250514")
  fixModel?: string;    // Model for fix runs (cheaper model for simple fixes)
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
  parent?: {
    id: string;
    identifier: string;
  } | null;
  [key: string]: unknown;
}

// Parsed issue metadata (extracted from description field)
export interface ParsedIssueMetadata {
  designPath: string | null; // e.g. "docs/designs/rate-limit-middleware.md" or null for designless tasks
  branch: string;            // e.g. "agent/rate-limit-middleware"
  repo: string;              // e.g. "belle/legalipro"
}

// Issue with parsed metadata
export interface Issue extends ParsedIssueMetadata {
  id: string;
  key: string;        // identifier e.g. "ENG-57"
  title: string;
  description: string;
  baseBranch: string;
  parentKey: string | null;  // parent issue identifier (e.g. "FAU-9")
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
  is_fix: number;                // 0 or 1
  fix_type: string | null;       // 'merge_conflict' or 'ci_failure'
  fix_attempt: number;           // which attempt (1, 2, 3...)
  retry_attempt: number;         // auto-retry attempt (0 = first try, 1+ = retries)
  pr_number: number | null;
  agent_pid: number | null;
  iterations: number;
  error_summary: string | null;
  pr_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  // Persisted issue metadata for restart recovery (optional — absent on legacy rows)
  design_path?: string | null;
  issue_repo?: string | null;
  base_branch?: string | null;
}

// SSE event types
export type SSEEvent =
  | { type: 'run_update'; run: Run }
  | { type: 'log'; runId: string; stream: string; content: string }
  | { type: 'iteration'; runId: string; current: number; max: number; allDone: boolean };

// PR merge-readiness status (from gh CLI)
export interface PRMergeStatus {
  repo: string;
  prNumber: number;
  title: string;
  url: string;
  branch: string;
  reviewDecision: string;
  checks: Array<{ name: string; conclusion: string }>;
  isReady: boolean;
}

// Processed review record (for deduplication)
export interface ProcessedReview {
  review_id: string;
  pr_number: number;
  repo: string;
  run_id: string;
  created_at: string;
}

// Fix tracking record (for automated fix attempts)
export interface FixTracking {
  repo: string;
  pr_number: number;
  fix_type: string;
  attempt_count: number;
  last_run_id: string | null;
  exhausted: number;             // 0 or 1
  resolved_at: string | null;
  updated_at: string;
}

// Log entry
export interface LogEntry {
  id: number;
  run_id: string;
  stream: 'stdout' | 'stderr' | 'system';
  content: string;
  created_at: string;
}
