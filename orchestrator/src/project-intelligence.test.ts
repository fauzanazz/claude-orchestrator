import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { db, insertRun, updateRunStatus } from './db.ts';
import { updateProjectIntelligence, buildIntelligenceSection } from './project-intelligence.ts';
import type { RunStatus } from './types.ts';

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

function makeRun(id: string, project: string, overrides?: Partial<{
  status: string;
  is_fix: number;
  iterations: number;
  error_summary: string | null;
  started_at: string;
  completed_at: string;
}>) {
  insertRun({
    id,
    project,
    issue_id: `issue-${id}`,
    issue_key: `T-${id}`,
    issue_title: `Test issue ${id}`,
    branch: `agent/test-${id}`,
    worktree_path: '/tmp/test',
    status: 'queued',
    is_revision: 0,
    is_fix: overrides?.is_fix ?? 0,
    fix_type: null,
    fix_attempt: 0,
    retry_attempt: 0,
    pr_number: null,
    agent_pid: null,
    iterations: overrides?.iterations ?? 3,
    error_summary: null,
    pr_url: null,
    design_path: null,
    issue_repo: null,
    base_branch: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
  });

  const status = (overrides?.status ?? 'success') as RunStatus;
  updateRunStatus(id, status, {
    started_at: overrides?.started_at ?? new Date(Date.now() - 600_000).toISOString(),
    completed_at: overrides?.completed_at ?? new Date().toISOString(),
    error_summary: overrides?.error_summary ?? undefined,
  });
}

describe('project-intelligence', () => {
  const project = `test-intel-${Date.now()}`;

  beforeEach(() => {
    db.run('DELETE FROM project_intelligence WHERE project LIKE ?', [`${project}%`]);
    db.run('DELETE FROM runs WHERE project LIKE ?', [`${project}%`]);
  });

  test('buildIntelligenceSection returns null with no data', () => {
    expect(buildIntelligenceSection(project)).toBeNull();
  });

  test('buildIntelligenceSection returns null with fewer than 3 runs', () => {
    makeRun(`${project}-r1`, project);
    makeRun(`${project}-r2`, project);

    // Update intelligence (quantitative only, no Gemini key in tests)
    // Note: we call the sync parts by directly updating
    db.run(
      `INSERT INTO project_intelligence (project, metric, value) VALUES (?, 'total_runs', '2')`,
      [project]
    );

    expect(buildIntelligenceSection(project)).toBeNull();
  });

  test('updateProjectIntelligence computes stats from run history', async () => {
    for (let i = 0; i < 5; i++) {
      makeRun(`${project}-s${i}`, project, {
        status: i < 4 ? 'success' : 'failed',
        error_summary: i >= 4 ? 'test failure: exit code 1' : null,
      });
    }

    await updateProjectIntelligence(project);

    const section = buildIntelligenceSection(project);
    expect(section).not.toBeNull();
    expect(section).toContain('Project Intelligence');
    expect(section).toContain('success rate');
    expect(section).toContain('80%'); // 4/5 = 80%
    expect(section).toContain('5 runs');
  });

  test('buildIntelligenceSection includes common failure patterns', async () => {
    const proj = `${project}-fail`;
    for (let i = 0; i < 3; i++) {
      makeRun(`${proj}-ok${i}`, proj);
    }
    for (let i = 0; i < 3; i++) {
      makeRun(`${proj}-f${i}`, proj, {
        status: 'failed',
        error_summary: 'TypeScript compilation error: TS2307',
      });
    }

    await updateProjectIntelligence(proj);

    const section = buildIntelligenceSection(proj);
    expect(section).not.toBeNull();
    expect(section).toContain('Common Failure Patterns');
    expect(section).toContain('typescript compilation error');
  });

  test('buildIntelligenceSection formats avg duration', async () => {
    const proj = `${project}-dur`;
    for (let i = 0; i < 4; i++) {
      makeRun(`${proj}-d${i}`, proj, {
        started_at: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
        completed_at: new Date().toISOString(),
      });
    }

    await updateProjectIntelligence(proj);

    const section = buildIntelligenceSection(proj);
    expect(section).not.toBeNull();
    expect(section).toContain('Avg run duration');
    expect(section).toContain('min');
  });

  test('fix runs are excluded from stats', async () => {
    const proj = `${project}-fix`;
    for (let i = 0; i < 3; i++) {
      makeRun(`${proj}-n${i}`, proj);
    }
    // Add a fix run — should be excluded
    makeRun(`${proj}-fix1`, proj, { is_fix: 1, status: 'failed', error_summary: 'fix failed' });

    await updateProjectIntelligence(proj);

    const section = buildIntelligenceSection(proj);
    expect(section).not.toBeNull();
    expect(section).toContain('3 runs'); // only 3 non-fix runs
    expect(section).toContain('100%'); // all 3 non-fix succeeded
  });

  test('metric persistence roundtrip', async () => {
    const proj = `${project}-persist`;
    for (let i = 0; i < 4; i++) {
      makeRun(`${proj}-p${i}`, proj);
    }

    await updateProjectIntelligence(proj);

    // Verify metrics exist in DB
    const row = db.prepare<{ value: string }, [string, string]>(
      'SELECT value FROM project_intelligence WHERE project = ? AND metric = ?'
    ).get(proj, 'total_runs');
    expect(row).not.toBeNull();
    expect(parseInt(row!.value)).toBe(4);

    // Update again (should upsert, not duplicate)
    makeRun(`${proj}-p4`, proj);
    await updateProjectIntelligence(proj);

    const row2 = db.prepare<{ value: string }, [string, string]>(
      'SELECT value FROM project_intelligence WHERE project = ? AND metric = ?'
    ).get(proj, 'total_runs');
    expect(parseInt(row2!.value)).toBe(5);
  });
});
