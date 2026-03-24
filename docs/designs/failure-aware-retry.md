# Failure-Aware Retry Context

## Context

When a run fails and the orchestrator auto-retries it, the retry agent starts completely cold — it has zero knowledge of what the previous attempt tried or why it failed. This means the retry agent may repeat the exact same failing approach, wasting time and API tokens.

The failed run's data already exists: error summary in the `runs` table, agent logs in the in-memory `logBuffers` map (pre-flush), and any partial git commits in the worktree. This task injects that context into the retry agent's prompt so it can learn from the failure.

## Requirements

- When `run.retry_attempt > 0`, the agent prompt includes a "Previous Attempt Context" section
- The context includes: error summary, last 30 log entries, and an instruction to try a different approach
- Context is gathered from the failed run's in-memory log buffer (available before `flushLogs` in the `finally` block)
- Stored in an in-memory map keyed by retry run ID (acceptable to lose on orchestrator restart)
- No database schema changes
- No new files — all changes within `runner.ts`

## Implementation

### 1. Add retry context map and builder function

**File:** `orchestrator/src/runner.ts`

Add alongside the existing `issueMap` (around line 1235):

```typescript
// Retry context: stores failure context from parent run for injection into retry prompts
const retryContextMap: Map<string, string> = new Map();

function buildRetryContext(failedRun: Run): string {
  const sections: string[] = [];

  sections.push('## Previous Attempt Failed');
  sections.push('');
  sections.push(`The orchestrator is automatically retrying this task because the previous attempt failed.`);
  sections.push(`- **Previous attempt**: ${failedRun.retry_attempt + 1}`);
  sections.push(`- **Error**: ${failedRun.error_summary ?? 'Unknown error'}`);
  sections.push(`- **Sessions completed**: ${failedRun.iterations}`);

  // Read logs from in-memory buffer (not yet flushed to DB at this point)
  const buffered = logBuffers.get(failedRun.id);
  if (buffered && buffered.length > 0) {
    const tail = buffered.slice(-30);
    const logText = tail
      .map((e) => `[${e.stream}] ${e.content}`)
      .join('\n');
    sections.push('');
    sections.push(`### What the previous attempt did (last ${tail.length} log entries)`);
    sections.push('```');
    sections.push(logText);
    sections.push('```');
  }

  sections.push('');
  sections.push('### Instructions for this retry');
  sections.push('');
  sections.push('- Review the error and logs above carefully.');
  sections.push('- **Do NOT repeat the same approach** that caused the failure.');
  sections.push('- If the error was a timeout, focus on the most critical features first and skip exploratory work.');
  sections.push('- If the error was "No commits produced", make sure to actually write code and commit it.');
  sections.push('- If the error was a git or setup issue, try an alternative approach to the setup step.');
  sections.push('- Start by reading `.agent-state/features.json` and `.agent-state/progress.md` if they exist from the previous attempt.');

  return sections.join('\n');
}
```

### 2. Store retry context when enqueuing a retry

**File:** `orchestrator/src/runner.ts`

Modify `enqueueRetry()` (around line 1296) — add one line after the new run ID is generated, before `insertRun`:

```typescript
export function enqueueRetry(
  failedRun: Run,
  issue: Issue,
  delayMs = 0,
): string | null {
  if (failedRun.is_fix) return null;

  const nextAttempt = (failedRun.retry_attempt ?? 0) + 1;
  if (nextAttempt > config.maxRunRetries) return null;

  // Build retry context from the failed run BEFORE logs are flushed
  const retryContext = buildRetryContext(failedRun);

  const newRun: Omit<Run, 'created_at' | 'started_at' | 'completed_at'> = {
    // ... existing fields unchanged ...
    id: ulid(),
    // ... rest unchanged ...
  };

  insertRun(newRun);

  const fullRun = getRun(newRun.id);
  if (!fullRun) return null;

  // Store context for the retry run to read during execution
  retryContextMap.set(newRun.id, retryContext);

  broadcastSSE({ type: 'run_update', run: fullRun });

  if (delayMs > 0) {
    setTimeout(() => {
      enqueueWithIssue(fullRun, issue);
    }, delayMs);
  } else {
    enqueueWithIssue(fullRun, issue);
  }

  return newRun.id;
}
```

### 3. Inject retry context into the agent prompt

**File:** `orchestrator/src/runner.ts`

In `executeRun()`, inside the normal/revision run branch (around line 936, the `else` block for non-fix runs), after building the first `sessionBase` prompt and before building the `SessionPromptContext`:

```typescript
    // ─── Normal/revision run: multi-session loop ───────────────────────
    let reviewFeedback: string | undefined;
    // ... existing review feedback code ...

    const runStartTime = Date.now();
    let isFirstRun = true;
    let previousSummary: string | undefined;

    // Inject retry context for retry runs (retry_attempt > 0)
    const retryContext = retryContextMap.get(runId);
    if (retryContext) {
      retryContextMap.delete(runId); // Clean up after reading
    }

    for (let iteration = 0; iteration < config.maxSessionIterations; iteration++) {
      // ... existing timeout check ...

      let sessionBase = await buildAgentPrompt(issue, worktreePath!, {
        reviewFeedback: isFirstRun ? reviewFeedback : undefined,
        isFirstSession: isFirstRun,
        codebaseSummary,
      });

      // Append retry context on the first session of a retry run
      if (isFirstRun && retryContext) {
        sessionBase += '\n\n---\n\n' + retryContext;
      }

      if (isFirstRun && prInstructions) sessionBase += prInstructions;
      // ... rest of loop unchanged ...
```

### 4. Clean up on run completion

In the `finally` block of `executeRun()` (around line 1198), ensure the retry context is cleaned up:

```typescript
  } finally {
    flushLogs(runId);
    retryContextMap.delete(runId); // Clean up in case it wasn't consumed
    if (projectPath && worktreePath) {
      cleanupWorktree(projectPath, worktreePath).catch(() => {});
    }
  }
```

## Testing Strategy

**File:** `orchestrator/src/runner.test.ts`

Add tests for the new `buildRetryContext` function. Export it for testing.

```typescript
describe('buildRetryContext', () => {
  test('includes error summary from failed run', () => {
    const failedRun = {
      id: 'run-1', retry_attempt: 0, iterations: 2,
      error_summary: 'Agent timed out after 1800000ms',
      // ... other required Run fields
    } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('Agent timed out');
    expect(context).toContain('Previous Attempt Failed');
    expect(context).toContain('Do NOT repeat');
  });

  test('includes log entries if available in buffer', () => {
    const runId = 'retry-test-run';
    logBuffers.set(runId, [
      { stream: 'stdout', content: 'tool: Read(...)' },
      { stream: 'system', content: '[runner] Session 1 exited' },
    ]);
    const failedRun = { id: runId, retry_attempt: 0, iterations: 1, error_summary: 'fail' } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('tool: Read');
    expect(context).toContain('Session 1 exited');
    logBuffers.delete(runId);
  });

  test('handles missing log buffer gracefully', () => {
    const failedRun = { id: 'no-logs', retry_attempt: 1, iterations: 0, error_summary: 'crash' } as Run;
    const context = buildRetryContext(failedRun);
    expect(context).toContain('crash');
    expect(context).not.toContain('log entries');
  });
});
```

**Commands:**
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- Persisting retry context in the database (in-memory is sufficient; lost on restart is acceptable)
- Passing git diff from the failed run (would require worktree to still exist; it's cleaned up)
- Retry context for fix runs (they have their own context via `buildFixPrompt`)
- UI indication in dashboard that a run has retry context (the "Retry N/3" label already exists)
