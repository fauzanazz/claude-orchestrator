# Token Usage and Cost Tracking

## Context

The orchestrator spawns Claude Code agents but has zero visibility into token consumption or cost. There's no way to know which projects are expensive, which design docs produce efficient runs, or what the daily spend looks like. Claude's `--output-format stream-json` already emits `result` events with token usage data — we just need to capture and persist it.

## Requirements

- Parse token usage from Claude's stream-json `result` events during agent execution
- Accumulate tokens across multiple sessions within a single run
- Persist per-run totals: input tokens, output tokens, cache read tokens, cache creation tokens
- Estimate cost using per-model pricing (configurable table)
- Add `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd` columns to the `runs` table
- Expose cost data via existing `/api/runs` endpoint (fields appear automatically in JSON)
- Add a `/api/cost` endpoint for aggregate cost summaries
- Create a reusable `TokenTracker` class in a new module

## Implementation

### 1. Create token tracker module

**File:** `orchestrator/src/token-tracker.ts` (new)

```typescript
/**
 * Tracks token usage across one or more Claude agent sessions within a run.
 * Parses stream-json result events and accumulates totals.
 */

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface CostEstimate extends TokenUsage {
  cost_usd: number;
  model: string | null;
}

// Pricing per 1M tokens (as of 2025). Update as needed.
// Format: { input, output, cacheRead, cacheCreation } per million tokens
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
};

// Default pricing (Sonnet-level) for unknown models
const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 };

export class TokenTracker {
  private totals: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  private model: string | null = null;

  /**
   * Parse a stream-json line and accumulate token usage if it's a result event.
   * Returns the parsed usage if found, null otherwise.
   */
  parseAndAccumulate(line: string): TokenUsage | null {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line);
    } catch {
      return null;
    }

    if (evt.type !== 'result') return null;

    const usage = evt.usage as Record<string, number> | undefined;
    if (!usage) return null;

    const sessionUsage: TokenUsage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    };

    this.totals.input_tokens += sessionUsage.input_tokens;
    this.totals.output_tokens += sessionUsage.output_tokens;
    this.totals.cache_read_tokens += sessionUsage.cache_read_tokens;
    this.totals.cache_creation_tokens += sessionUsage.cache_creation_tokens;

    // Capture model from result event if available
    if (evt.model && typeof evt.model === 'string') {
      this.model = evt.model;
    }

    return sessionUsage;
  }

  setModel(model: string | null): void {
    if (model) this.model = model;
  }

  getTotals(): TokenUsage {
    return { ...this.totals };
  }

  getModel(): string | null {
    return this.model;
  }

  estimateCost(): CostEstimate {
    const pricing = (this.model && MODEL_PRICING[this.model]) ?? DEFAULT_PRICING;
    const cost =
      (this.totals.input_tokens / 1_000_000) * pricing.input +
      (this.totals.output_tokens / 1_000_000) * pricing.output +
      (this.totals.cache_read_tokens / 1_000_000) * pricing.cacheRead +
      (this.totals.cache_creation_tokens / 1_000_000) * pricing.cacheCreation;

    return {
      ...this.totals,
      cost_usd: Math.round(cost * 10000) / 10000, // 4 decimal places
      model: this.model,
    };
  }
}
```

### 2. Add token columns to runs table

**File:** `orchestrator/src/db.ts`

Add migrations after the existing `retry_attempt` migration (around line 78):

```typescript
// Migrate: add token tracking columns
try { db.run('ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0'); } catch (e: any) {
  if (!String(e?.message).includes('duplicate column')) throw e;
}
try { db.run('ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0'); } catch (e: any) {
  if (!String(e?.message).includes('duplicate column')) throw e;
}
try { db.run('ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0'); } catch (e: any) {
  if (!String(e?.message).includes('duplicate column')) throw e;
}
try { db.run('ALTER TABLE runs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0'); } catch (e: any) {
  if (!String(e?.message).includes('duplicate column')) throw e;
}
try { db.run('ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0'); } catch (e: any) {
  if (!String(e?.message).includes('duplicate column')) throw e;
}
```

Add a function to update token data for a run:

```typescript
export function updateRunTokens(
  id: string,
  tokens: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number },
): void {
  db.prepare(`
    UPDATE runs
    SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?
    WHERE id = ?
  `).run(
    tokens.input_tokens, tokens.output_tokens,
    tokens.cache_read_tokens, tokens.cache_creation_tokens,
    tokens.cost_usd, id,
  );
}
```

Add a cost summary query function:

```typescript
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
```

### 3. Update Run type

**File:** `orchestrator/src/types.ts`

Add token fields to the `Run` interface (after `base_branch`):

```typescript
export interface Run {
  // ... existing fields ...
  base_branch?: string | null;
  // Token tracking
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}
```

### 4. Integrate token tracking into stream output parsing

**File:** `orchestrator/src/runner.ts`

Add import:
```typescript
import { TokenTracker } from './token-tracker.ts';
import { updateRunTokens, getCostSummary } from './db.ts';
```

Modify `executeRun()` to create a `TokenTracker` per run and extract tokens from stream output.

Near the start of `executeRun` (after the worktree setup, around line 870):

```typescript
    const tokenTracker = new TokenTracker();
    const runModel = project.model ?? config.defaultModel;
    tokenTracker.setModel(runModel);
```

Modify the `streamOutput` function to also feed lines to the token tracker. Since `streamOutput` doesn't have access to the tracker, the cleanest approach is to extract tokens from the raw stdout in the session loop.

In the normal run session loop, after `streamOutput` and before checking features (around line 1015):

```typescript
        // Parse result event for token usage (check log buffer for result lines)
        const buffered = logBuffers.get(runId);
        if (buffered) {
          for (const entry of buffered) {
            if (entry.stream === 'stdout' && entry.content.startsWith('result: ')) {
              // The raw line was already parsed by parseAgentEvent into "result: ..."
              // We need the original JSON line. Instead, scan the buffer for result events.
            }
          }
        }
```

Actually, a cleaner approach: modify `streamOutput` to accept an optional callback for raw lines, and let the caller provide a token-parsing callback:

```typescript
async function streamOutput(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  runId: string,
  streamName: 'stdout' | 'stderr',
  onRawLine?: (line: string) => void,  // NEW: callback for raw stream-json lines
): Promise<void> {
  if (!stream || typeof stream === 'number') return;

  const decoder = new TextDecoder();
  const reader = (stream as ReadableStream<Uint8Array>).getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (streamName === 'stderr') {
          bufferLog(runId, streamName, text);
        } else {
          for (const line of text.split('\n').filter(Boolean)) {
            onRawLine?.(line);  // NEW: feed raw line to callback
            const readable = parseAgentEvent(line);
            if (readable) {
              bufferLog(runId, streamName, readable);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

Then in `executeRun`, pass the token tracker as the callback:

For normal runs:
```typescript
        const completion = Promise.all([
          streamOutput(agentProc.stdout, runId, 'stdout', (line) => tokenTracker.parseAndAccumulate(line)),
          streamOutput(agentProc.stderr, runId, 'stderr'),
          agentProc.exited,
        ]).then(() => 'done' as const);
```

For fix runs (same pattern):
```typescript
      const completion = Promise.all([
        streamOutput(agentProc.stdout, runId, 'stdout', (line) => tokenTracker.parseAndAccumulate(line)),
        streamOutput(agentProc.stderr, runId, 'stderr'),
        agentProc.exited,
      ]).then(() => 'done' as const);
```

After the session loop completes (before `hasLocalCommits` check), record tokens:

```typescript
    // Record token usage
    const costEstimate = tokenTracker.estimateCost();
    updateRunTokens(runId, {
      input_tokens: costEstimate.input_tokens,
      output_tokens: costEstimate.output_tokens,
      cache_read_tokens: costEstimate.cache_read_tokens,
      cache_creation_tokens: costEstimate.cache_creation_tokens,
      cost_usd: costEstimate.cost_usd,
    });
    bufferLog(runId, 'system',
      `[runner] Token usage: ${costEstimate.input_tokens} in / ${costEstimate.output_tokens} out ` +
      `(cache: ${costEstimate.cache_read_tokens} read, ${costEstimate.cache_creation_tokens} created) ` +
      `≈ $${costEstimate.cost_usd}`
    );
```

### 5. Add cost API endpoint

**File:** `orchestrator/src/server.ts`

Add import and route:

```typescript
import { getCostSummary } from './db.ts';

// GET /api/cost — token usage and cost summary
app.get('/api/cost', (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10) || 30, 365);
  return c.json(getCostSummary(days));
});
```

## Testing Strategy

**File:** `orchestrator/src/token-tracker.test.ts` (new)

```typescript
import { describe, test, expect } from 'bun:test';
import { TokenTracker } from './token-tracker.ts';

describe('TokenTracker', () => {
  test('parses result event with usage data', () => {
    const tracker = new TokenTracker();
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    });
    const usage = tracker.parseAndAccumulate(line);
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(5000);
    expect(usage!.output_tokens).toBe(2000);
  });

  test('accumulates across multiple sessions', () => {
    const tracker = new TokenTracker();
    tracker.parseAndAccumulate(JSON.stringify({ type: 'result', usage: { input_tokens: 1000, output_tokens: 500 } }));
    tracker.parseAndAccumulate(JSON.stringify({ type: 'result', usage: { input_tokens: 2000, output_tokens: 1000 } }));
    const totals = tracker.getTotals();
    expect(totals.input_tokens).toBe(3000);
    expect(totals.output_tokens).toBe(1500);
  });

  test('ignores non-result events', () => {
    const tracker = new TokenTracker();
    const result = tracker.parseAndAccumulate(JSON.stringify({ type: 'assistant', message: {} }));
    expect(result).toBeNull();
    expect(tracker.getTotals().input_tokens).toBe(0);
  });

  test('estimates cost correctly for sonnet', () => {
    const tracker = new TokenTracker();
    tracker.setModel('claude-sonnet-4-20250514');
    tracker.parseAndAccumulate(JSON.stringify({ type: 'result', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }));
    const estimate = tracker.estimateCost();
    expect(estimate.cost_usd).toBe(4.5); // $3 input + $1.50 output
  });

  test('handles missing usage gracefully', () => {
    const tracker = new TokenTracker();
    const result = tracker.parseAndAccumulate(JSON.stringify({ type: 'result', result: 'ok' }));
    expect(result).toBeNull();
  });

  test('handles invalid JSON gracefully', () => {
    const tracker = new TokenTracker();
    const result = tracker.parseAndAccumulate('not json');
    expect(result).toBeNull();
  });
});
```

**File:** `orchestrator/src/db.test.ts` — add test for `updateRunTokens` and `getCostSummary`.

**Commands:**
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- Dashboard cost charts (the analytics dashboard task can be enhanced later to show cost)
- Real-time cost alerting or budget limits
- Per-session token breakdown (we accumulate totals per run, not per session)
- Automatic model downgrade when costs exceed thresholds
- Historical pricing changes (pricing table is static)
