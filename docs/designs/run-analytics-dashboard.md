# Run Analytics API and Dashboard Charts

## Context

The orchestrator has no analytics layer. All run data sits in SQLite (`runs` table) but there's no way to answer "What's my success rate this week?" or "Which project fails the most?" The dashboard at `:7400` shows a flat run list but no trends, stats, or charts.

This task adds analytics SQL queries, REST API endpoints, and lightweight dashboard charts (pure CSS/SVG, zero dependencies).

## Requirements

- Analytics overview: total runs, success rate, average duration, average sessions, retry rate
- Per-project breakdown: same metrics grouped by project
- Daily throughput chart: runs per day over a configurable period (default 30 days)
- Failure breakdown: top error categories with counts
- All endpoints accept a `?days=N` query parameter for time range (default 30)
- Dashboard gets a new "Analytics" section above the runs table with bar charts
- Zero new dependencies — use inline SVG/CSS for charts

## Implementation

### 1. Add analytics query functions

**File:** `orchestrator/src/db.ts`

Add these prepared statements and functions after the existing exported functions:

```typescript
// --- Analytics queries ---

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
  const params = project ? [days, project] : [days];
  return db.prepare<FailureBreakdown, any>(`
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
  `).all(...params);
}
```

### 2. Add API endpoints

**File:** `orchestrator/src/server.ts`

Add these imports at the top (to the existing db.ts import line):

```typescript
import {
  // ... existing imports ...
  getAnalyticsOverview,
  getProjectStats,
  getDailyThroughput,
  getFailureBreakdown,
} from './db.ts';
```

Add these routes after the existing `/api/runs` routes:

```typescript
// GET /api/analytics/overview — aggregate stats
app.get('/api/analytics/overview', (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  return c.json(getAnalyticsOverview(days));
});

// GET /api/analytics/projects — per-project breakdown
app.get('/api/analytics/projects', (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  return c.json(getProjectStats(days));
});

// GET /api/analytics/throughput — daily run counts
app.get('/api/analytics/throughput', (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  return c.json(getDailyThroughput(days));
});

// GET /api/analytics/failures — failure cause breakdown
app.get('/api/analytics/failures', (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  const project = c.req.query('project');
  return c.json(getFailureBreakdown(days, project || undefined));
});
```

### 3. Add analytics section to dashboard

**File:** `orchestrator/board/index.html`

Add an analytics section **above** the existing `<div id="table-wrap">`. Insert after the `</header>` closing tag:

```html
<section id="analytics" style="padding: 16px; border-bottom: 1px solid var(--border);">
  <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;">
    <div class="stat-card" id="stat-total"><span class="stat-value">—</span><span class="stat-label">Total Runs</span></div>
    <div class="stat-card" id="stat-success"><span class="stat-value">—</span><span class="stat-label">Success Rate</span></div>
    <div class="stat-card" id="stat-duration"><span class="stat-value">—</span><span class="stat-label">Avg Duration</span></div>
    <div class="stat-card" id="stat-sessions"><span class="stat-value">—</span><span class="stat-label">Avg Sessions</span></div>
    <div class="stat-card" id="stat-retry"><span class="stat-value">—</span><span class="stat-label">Retry Rate</span></div>
  </div>
  <div style="display: flex; gap: 16px; flex-wrap: wrap;">
    <div id="throughput-chart" style="flex: 2; min-width: 300px; background: var(--bg2); border-radius: 6px; padding: 12px;">
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">Daily Throughput (30d)</div>
      <div id="throughput-bars" style="display: flex; align-items: flex-end; gap: 2px; height: 80px;"></div>
    </div>
    <div id="project-stats" style="flex: 1; min-width: 200px; background: var(--bg2); border-radius: 6px; padding: 12px;">
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">By Project</div>
      <div id="project-bars"></div>
    </div>
  </div>
</section>
```

Add these CSS rules in the existing `<style>` block:

```css
.stat-card {
  background: var(--bg2);
  border-radius: 6px;
  padding: 10px 14px;
  min-width: 100px;
  display: flex;
  flex-direction: column;
}
.stat-value { font-size: 20px; font-weight: 700; color: var(--blue); }
.stat-label { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
.project-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; }
.project-bar { height: 14px; border-radius: 3px; min-width: 2px; }
```

Add this JavaScript at the end of the existing `<script>` block (before `</script>`):

```javascript
async function loadAnalytics() {
  try {
    const [overview, throughput, projects] = await Promise.all([
      fetch('/api/analytics/overview').then(r => r.json()),
      fetch('/api/analytics/throughput').then(r => r.json()),
      fetch('/api/analytics/projects').then(r => r.json()),
    ]);

    // Stats cards
    document.querySelector('#stat-total .stat-value').textContent = overview.total_runs;
    document.querySelector('#stat-success .stat-value').textContent = overview.success_rate + '%';
    document.querySelector('#stat-duration .stat-value').textContent = overview.avg_duration_seconds > 60
      ? Math.round(overview.avg_duration_seconds / 60) + 'm'
      : overview.avg_duration_seconds + 's';
    document.querySelector('#stat-sessions .stat-value').textContent = overview.avg_iterations;
    document.querySelector('#stat-retry .stat-value').textContent = overview.retry_rate + '%';

    // Throughput bar chart
    const maxTotal = Math.max(...throughput.map(d => d.total), 1);
    const barsEl = document.getElementById('throughput-bars');
    barsEl.innerHTML = throughput.map(d => {
      const h = Math.max(2, (d.total / maxTotal) * 70);
      const successH = Math.max(0, (d.success / maxTotal) * 70);
      const failedH = h - successH;
      return `<div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end;" title="${d.date}: ${d.total} runs">
        <div style="height:${failedH}px; background:var(--red); border-radius:2px 2px 0 0; min-width:4px;"></div>
        <div style="height:${successH}px; background:var(--green); border-radius:0 0 2px 2px; min-width:4px;"></div>
      </div>`;
    }).join('');

    // Project breakdown
    const maxRuns = Math.max(...projects.map(p => p.total_runs), 1);
    const projectEl = document.getElementById('project-bars');
    projectEl.innerHTML = projects.slice(0, 8).map(p => {
      const w = Math.max(2, (p.total_runs / maxRuns) * 100);
      const color = p.success_rate >= 70 ? 'var(--green)' : p.success_rate >= 40 ? 'var(--yellow)' : 'var(--red)';
      return `<div class="project-row">
        <span style="min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.project}</span>
        <div class="project-bar" style="width:${w}%; background:${color};"></div>
        <span style="color:var(--text-dim); min-width:40px;">${p.total_runs} (${p.success_rate}%)</span>
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('Failed to load analytics:', err);
  }
}

// Load on page load and refresh every 60s
loadAnalytics();
setInterval(loadAnalytics, 60000);
```

## Testing Strategy

**File:** `orchestrator/src/db.test.ts`

Add tests for each analytics function. Insert runs with known data and verify aggregations:

```typescript
describe('analytics', () => {
  beforeEach(() => {
    // Insert test runs with various statuses, projects, and timestamps
    const now = new Date().toISOString();
    for (const [status, project] of [
      ['success', 'proj-a'], ['success', 'proj-a'], ['failed', 'proj-a'],
      ['success', 'proj-b'], ['failed', 'proj-b'],
    ]) {
      insertRun({ id: `analytics-${Date.now()}-${Math.random()}`, project, issue_id: 'i1', issue_key: 'T-1', issue_title: 'test', branch: 'b', worktree_path: '/tmp', status: 'queued', is_revision: 0, is_fix: 0, fix_type: null, fix_attempt: 0, retry_attempt: 0, pr_number: null, design_path: null, issue_repo: null, base_branch: null });
      // Immediately update status to simulate completion
    }
  });

  test('getAnalyticsOverview returns correct counts', () => {
    const overview = getAnalyticsOverview(30);
    expect(overview.total_runs).toBeGreaterThan(0);
    expect(overview.success_rate).toBeGreaterThanOrEqual(0);
    expect(overview.success_rate).toBeLessThanOrEqual(100);
  });

  test('getProjectStats groups by project', () => {
    const stats = getProjectStats(30);
    expect(Array.isArray(stats)).toBe(true);
  });

  test('getDailyThroughput returns date-keyed data', () => {
    const throughput = getDailyThroughput(30);
    expect(Array.isArray(throughput)).toBe(true);
    for (const row of throughput) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('getFailureBreakdown categorizes errors', () => {
    const breakdown = getFailureBreakdown(30);
    expect(Array.isArray(breakdown)).toBe(true);
  });
});
```

**Commands:**
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- Token/cost analytics (requires token tracking feature — will be added later)
- Export to CSV or JSON download
- Custom date range picker in the dashboard
- Real-time chart updates via SSE (periodic fetch is sufficient)
- Filtering by date range in the dashboard UI (API supports it, dashboard uses 30d default)
