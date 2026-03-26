import { GoogleGenAI } from '@google/genai';
import { config } from './config.ts';
import { db } from './db.ts';

// Schema is defined in db.ts alongside other table definitions.

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

  const recentRuns = db.prepare<{ id: string; issue_title: string; iterations: number }, [string]>(`
    SELECT id, issue_title, iterations
    FROM runs
    WHERE project = ? AND status IN ('success', 'merged') AND is_fix = 0
    ORDER BY created_at DESC
    LIMIT 3
  `).all(project);

  if (recentRuns.length === 0) return [];

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
        logs.map((l: { content: string }) => l.content).reverse().join('\n')
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
  const totalRuns = getMetric(project, 'total_runs');
  if (!totalRuns || parseInt(totalRuns) < 3) return null;

  const avgDuration = getMetric(project, 'avg_duration_seconds');
  const avgSessions = getMetric(project, 'avg_sessions');
  const successRate = getMetric(project, 'success_rate');
  const insightsRaw = getMetric(project, 'insights');
  const failuresRaw = getMetric(project, 'common_failures');

  const sections: string[] = [];
  sections.push('## Project Intelligence');
  sections.push('');
  sections.push('Historical data from previous agent runs on this project:');
  sections.push('');

  const durationMin = avgDuration ? Math.round(parseInt(avgDuration) / 60) : null;
  sections.push(`- **Avg run duration**: ${durationMin ? durationMin + ' min' : 'unknown'}`);
  sections.push(`- **Avg sessions per run**: ${avgSessions ?? 'unknown'}`);
  sections.push(`- **Historical success rate**: ${successRate ?? 'unknown'}% (${totalRuns} runs)`);

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
