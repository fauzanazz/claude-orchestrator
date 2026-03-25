# Project Intelligence Profiles

## Context

Every agent starts with zero knowledge of project-specific patterns. It doesn't know that project A's tests take 3 minutes to run, that project B requires `pnpm db:push` before tests, or that project C commonly fails because of missing TypeScript path alias resolution. This project-level knowledge exists implicitly across dozens of session notes and run records but is never surfaced to agents.

This task builds an automated intelligence layer that learns per-project patterns from historical run data and injects them into agent prompts. Over time, the profiles become richer as more runs complete.

## Requirements

- New `project_intelligence` SQLite table storing key-value metrics per project
- After each successful run, compute and update project intelligence metrics
- Metrics tracked: average duration, average sessions, success rate, common failures, test commands detected, common patterns/gotchas
- Intelligence is injected into agent prompts as a "Project Intelligence" section
- Gemini Flash 2 analyzes run logs to extract qualitative insights (test commands, gotchas, patterns)
- Metrics are recomputed periodically (not just on every run) to avoid excessive Gemini calls
- Intelligence is project-scoped: each project has its own profile

## Implementation

### 1. Create project intelligence module

**File:** `orchestrator/src/project-intelligence.ts` (new)

```typescript
import { GoogleGenAI } from '@google/genai';
import { config } from './config.ts';
import { db } from './db.ts';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.run(`
  CREATE TABLE IF NOT EXISTS project_intelligence (
    project     TEXT NOT NULL,
    metric      TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project, metric)
  )
`);

export interface ProjectProfile {
  project: string;
  avg_duration_seconds: number;
  avg_sessions: number;
  success_rate: number;
  total_runs: number;
  common_failures: string[];
  insights: string[];  // Gemini-extracted qualitative insights
}

// ---------------------------------------------------------------------------
// Metric computation (from run history)
// ---------------------------------------------------------------------------

interface RunStats {
  avg_duration: number | null;
  avg_iterations: number | null;
  success_rate: number;
  total_runs: number;
}

function computeRunStats(project: string): RunStats {
  const row = db.prepare<{
    avg_duration: number | null;
    avg_iterations: number | null;
    success_count: number;
    total_runs: number;
  }, [string]>(`
    SELECT
      AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(started_at)) * 86400
          ELSE NULL END) as avg_duration,
      AVG(iterations) as avg_iterations,
      SUM(CASE WHEN status IN ('success', 'merged') THEN 1 ELSE 0 END) as success_count,
      COUNT(*) as total_runs
    FROM runs
    WHERE project = ? AND is_fix = 0
      AND created_at >= datetime('now', '-90 days')
  `).get(project);

  if (!row || row.total_runs === 0) {
    return { avg_duration: null, avg_iterations: null, success_rate: 0, total_runs: 0 };
  }

  return {
    avg_duration: row.avg_duration,
    avg_iterations: row.avg_iterations,
    success_rate: Math.round((row.success_count / row.total_runs) * 100),
    total_runs: row.total_runs,
  };
}

function getCommonFailures(project: string): string[] {
  const rows = db.prepare<{ error_summary: string }, [string]>(`
    SELECT error_summary
    FROM runs
    WHERE project = ? AND status = 'failed' AND error_summary IS NOT NULL AND is_fix = 0
      AND created_at >= datetime('now', '-30 days')
    ORDER BY created_at DESC
    LIMIT 10
  `).all(project);

  // Deduplicate and count
  const counts = new Map<string, number>();
  for (const row of rows) {
    const normalized = row.error_summary.slice(0, 100).toLowerCase().trim();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([msg, count]) => `${msg} (${count}x)`);
}

// ---------------------------------------------------------------------------
// Gemini-powered qualitative insights
// ---------------------------------------------------------------------------

async function extractInsights(project: string): Promise<string[]> {
  if (!config.geminiApiKey) return [];

  // Get recent successful run logs (sample 3 runs)
  const recentRuns = db.prepare<{ id: string; issue_title: string; iterations: number }, [string]>(`
    SELECT id, issue_title, iterations
    FROM runs
    WHERE project = ? AND status IN ('success', 'merged') AND is_fix = 0
    ORDER BY created_at DESC
    LIMIT 3
  `).all(project);

  if (recentRuns.length === 0) return [];

  // Sample logs from recent runs
  const logSamples: string[] = [];
  for (const run of recentRuns) {
    const logs = db.prepare<{ content: string }, [string]>(`
      SELECT content FROM logs
      WHERE run_id = ? AND stream = 'stdout'
      ORDER BY id DESC LIMIT 20
    `).all(run.id);

    if (logs.length > 0) {
      logSamples.push(
        `--- Run: ${run.issue_title} (${run.iterations} sessions) ---\n` +
        logs.map(l => l.content).reverse().join('\n')
      );
    }
  }

  if (logSamples.length === 0) return [];

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const prompt = `Analyze these agent session logs from project "${project}" and extract reusable patterns and gotchas.

${logSamples.join('\n\n')}

Extract 3-5 SHORT, actionable insights about this project. Examples:
- "Tests require running \`pnpm db:push\` before \`pnpm test\`"
- "This project uses path aliases configured in tsconfig.json"
- "The CI pipeline runs ESLint — fix lint errors before committing"

Return a JSON array of strings. Each insight should be one sentence.
Return ONLY valid JSON, no markdown fences.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const text = response.text?.trim();
    if (!text) return [];

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((s): s is string => typeof s === 'string' && s.length > 10)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function upsertMetric(project: string, metric: string, value: string): void {
  db.prepare(`
    INSERT INTO project_intelligence (project, metric, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project, metric)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(project, metric, value);
}

function getMetric(project: string, metric: string): string | null {
  const row = db.prepare<{ value: string }, [string, string]>(
    'SELECT value FROM project_intelligence WHERE project = ? AND metric = ?'
  ).get(project, metric);
  return row?.value ?? null;
}

function getMetricAge(project: string, metric: string): number {
  const row = db.prepare<{ updated_at: string }, [string, string]>(
    'SELECT updated_at FROM project_intelligence WHERE project = ? AND metric = ?'
  ).get(project, metric);
  if (!row) return Infinity;
  return Date.now() - new Date(row.updated_at + 'Z').getTime();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const INSIGHT_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Update project intelligence metrics after a run completes.
 * Call this from the runner after executeRun finishes.
 */
export async function updateProjectIntelligence(project: string): Promise<void> {
  // Always update quantitative metrics (cheap, pure SQL)
  const stats = computeRunStats(project);
  upsertMetric(project, 'avg_duration_seconds', String(Math.round(stats.avg_duration ?? 0)));
  upsertMetric(project, 'avg_sessions', String(Math.round((stats.avg_iterations ?? 0) * 10) / 10));
  upsertMetric(project, 'success_rate', String(stats.success_rate));
  upsertMetric(project, 'total_runs', String(stats.total_runs));

  const failures = getCommonFailures(project);
  upsertMetric(project, 'common_failures', JSON.stringify(failures));

  // Refresh Gemini insights if stale (expensive, rate-limited)
  const insightAge = getMetricAge(project, 'insights');
  if (insightAge > INSIGHT_REFRESH_MS) {
    const insights = await extractInsights(project);
    if (insights.length > 0) {
      upsertMetric(project, 'insights', JSON.stringify(insights));
    }
  }
}

/**
 * Build a prompt section with project intelligence for injection into agent prompts.
 * Returns null if no intelligence is available.
 */
export function buildIntelligenceSection(project: string): string | null {
  const avgDuration = getMetric(project, 'avg_duration_seconds');
  const avgSessions = getMetric(project, 'avg_sessions');
  const successRate = getMetric(project, 'success_rate');
  const totalRuns = getMetric(project, 'total_runs');
  const insightsRaw = getMetric(project, 'insights');
  const failuresRaw = getMetric(project, 'common_failures');

  if (!totalRuns || parseInt(totalRuns) < 3) return null; // Not enough data

  const sections: string[] = [];
  sections.push('## Project Intelligence');
  sections.push('');
  sections.push('Historical data from previous agent runs on this project:');
  sections.push('');

  const durationMin = avgDuration ? Math.round(parseInt(avgDuration) / 60) : null;
  sections.push(`- **Avg run duration**: ${durationMin ? durationMin + ' min' : 'unknown'}`);
  sections.push(`- **Avg sessions per run**: ${avgSessions ?? 'unknown'}`);
  sections.push(`- **Historical success rate**: ${successRate ?? 'unknown'}% (${totalRuns} runs)`);

  // Insights from Gemini
  if (insightsRaw) {
    try {
      const insights = JSON.parse(insightsRaw) as string[];
      if (insights.length > 0) {
        sections.push('');
        sections.push('### Project-Specific Tips');
        for (const insight of insights) {
          sections.push(`- ${insight}`);
        }
      }
    } catch {}
  }

  // Common failures
  if (failuresRaw) {
    try {
      const failures = JSON.parse(failuresRaw) as string[];
      if (failures.length > 0) {
        sections.push('');
        sections.push('### Common Failure Patterns (avoid these)');
        for (const failure of failures) {
          sections.push(`- ${failure}`);
        }
      }
    } catch {}
  }

  return sections.join('\n');
}
```

### 2. Integrate into runner

**File:** `orchestrator/src/runner.ts`

Add import:
```typescript
import { updateProjectIntelligence, buildIntelligenceSection } from './project-intelligence.ts';
```

#### 2a. Inject intelligence into prompts

In `buildAgentPrompt()`, after the memory injection section and before the design doc section, add:

```typescript
  // 2.8. Project intelligence (NEW)
  if (isFirstSession && projectKey) {
    const intelligence = buildIntelligenceSection(projectKey);
    if (intelligence) sections.push(intelligence);
  }
```

Note: `projectKey` parameter was added by the cross-run-memory-injection task (FAU-52). This task assumes that parameter exists.

#### 2b. Update intelligence after run completion

In `executeRun()`, after the `documentRun` call (around line 1146), add intelligence update:

```typescript
    // Update project intelligence (fire-and-forget)
    updateProjectIntelligence(projectKey).catch((e) =>
      console.warn(`[runner] Project intelligence update failed: ${e instanceof Error ? e.message : e}`),
    );
```

Also add it in the error handler (after `documentRun` for failed runs, around line 1193):

```typescript
    // Update intelligence even for failed runs (failure patterns are valuable)
    updateProjectIntelligence(projectKey).catch((e) =>
      console.warn(`[runner] Project intelligence update failed: ${e instanceof Error ? e.message : e}`),
    );
```

## Testing Strategy

**File:** `orchestrator/src/project-intelligence.test.ts` (new)

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { db } from './db.ts';
import { insertRun, updateRunStatus, insertLog } from './db.ts';
import { updateProjectIntelligence, buildIntelligenceSection } from './project-intelligence.ts';

describe('project-intelligence', () => {
  const project = 'test-intel-project';

  beforeEach(() => {
    // Clean up test data
    db.run('DELETE FROM project_intelligence WHERE project = ?', [project]);
    db.run('DELETE FROM logs WHERE run_id LIKE ?', ['intel-%']);
    db.run('DELETE FROM runs WHERE project = ?', [project]);
  });

  test('buildIntelligenceSection returns null with insufficient data', () => {
    const result = buildIntelligenceSection(project);
    expect(result).toBeNull();
  });

  test('updateProjectIntelligence computes stats from run history', async () => {
    // Insert 5 test runs
    for (let i = 0; i < 5; i++) {
      const id = `intel-${i}`;
      insertRun({
        id, project, issue_id: 'i1', issue_key: 'T-1', issue_title: 'test',
        branch: 'b', worktree_path: '/tmp', status: 'queued',
        is_revision: 0, is_fix: 0, fix_type: null, fix_attempt: 0,
        retry_attempt: 0, pr_number: null, design_path: null,
        issue_repo: null, base_branch: null,
      });
      updateRunStatus(id, i < 4 ? 'success' : 'failed', {
        started_at: new Date(Date.now() - 600_000).toISOString(),
        completed_at: new Date().toISOString(),
        error_summary: i >= 4 ? 'test failure' : undefined,
      });
    }

    await updateProjectIntelligence(project);

    const section = buildIntelligenceSection(project);
    expect(section).not.toBeNull();
    expect(section).toContain('Project Intelligence');
    expect(section).toContain('success rate');
  });

  test('buildIntelligenceSection formats metrics correctly', async () => {
    // Insert enough runs and update intelligence
    for (let i = 0; i < 5; i++) {
      const id = `intel-fmt-${i}`;
      insertRun({
        id, project: project + '-fmt', issue_id: 'i1', issue_key: 'T-1',
        issue_title: 'test', branch: 'b', worktree_path: '/tmp', status: 'queued',
        is_revision: 0, is_fix: 0, fix_type: null, fix_attempt: 0,
        retry_attempt: 0, pr_number: null, design_path: null,
        issue_repo: null, base_branch: null,
      });
      updateRunStatus(id, 'success', {
        started_at: new Date(Date.now() - 300_000).toISOString(),
        completed_at: new Date().toISOString(),
      });
    }

    await updateProjectIntelligence(project + '-fmt');
    const section = buildIntelligenceSection(project + '-fmt');
    expect(section).toContain('Avg run duration');
    expect(section).toContain('Avg sessions per run');
  });
});
```

**Commands:**
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- UI dashboard for project intelligence (can be added to the analytics section later)
- Manual override/editing of intelligence metrics
- Cross-project intelligence sharing (each project is independent)
- Intelligence-based automatic model selection (e.g., use cheaper model for simple projects)
- Real-time intelligence updates during a running session
