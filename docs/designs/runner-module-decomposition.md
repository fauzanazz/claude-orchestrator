# Runner Module Decomposition

## Context

`orchestrator/src/runner.ts` is 1,898 lines and handles everything: Linear polling, prompt construction, agent spawning/streaming, queue management, review polling, fix detection, proactive rebasing, retry logic, and the main loop. This makes targeted changes risky, code review difficult, and testing granular behavior hard.

By the time this task runs, 6 prior tasks will have added more code to runner.ts (retry context, memory injection, token tracking, review gate, project intelligence). The file will be even larger. This refactor splits it into focused modules with clear boundaries while preserving all existing behavior.

## Requirements

- Split `runner.ts` into 5-6 focused modules with single responsibilities
- All existing tests must pass without changes to test assertions (only import paths change)
- All existing functionality is preserved — this is a **pure refactor**, zero behavior changes
- Each new module exports the functions that other modules or `server.ts` need
- `runner.ts` remains as a thin orchestration layer that wires modules together
- No new dependencies

## Implementation

### Target module structure

```
orchestrator/src/
  runner.ts            # Thin orchestrator: startRunner(), tick(), main loop (≤200 lines)
  scheduler.ts         # NEW: queue, enqueue*, tick dispatch, concurrency (≤200 lines)
  agent.ts             # NEW: spawn, stream, timeout, signal handling (≤300 lines)
  poller.ts            # NEW: pollLinear, pollReviews, pollFixable, proactiveRebase (≤400 lines)
  prompt-builder.ts    # NEW: buildAgentPrompt, buildFixPrompt, buildRulesSection (≤300 lines)
  linear.ts            # NEW: runLineark, updateLinearStatus, commentOnIssue, parseIssueMetadata (≤150 lines)
  prompts.ts           # UNCHANGED: session mode templates (buildInitializerPrompt, buildCodingPrompt)
```

### 1. Create `orchestrator/src/linear.ts`

Extract all Linear/GitHub CLI interaction functions:

```typescript
// Functions to move from runner.ts:
export async function runLineark(args: string[]): Promise<string>;
export async function fetchLinearParent(issueId: string): Promise<{ id: string; identifier: string } | null>;
export async function pollLinear(): Promise<LinearIssue[]>;
export function parseIssueMetadata(description: string): ParsedIssueMetadata | null;
export function updateLinearStatus(key: string, state: string): void;
export function commentOnIssue(key: string, message: string): void;
export function commentOnPR(repo: string, prNumber: number, body: string): void;
export async function reconstructIssueFromRun(run: Run): Promise<Issue>;
export function clearParentStateCache(): void;
// Also move: isParentDone, getIssueState, parentStateCache, loadProjects, resolveProject
```

Imports this module needs:
```typescript
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { hasAnyRunForIssue } from './db.ts';
import { validateDesignPath, validateBranch, validateRepo } from './validate.ts';
import { LinearIssueListSchema, LinearIssueDetailSchema } from './schemas.ts';
import type { LinearIssue, ParsedIssueMetadata, Issue, ProjectConfig, ProjectsConfig, Run } from './types.ts';
```

### 2. Create `orchestrator/src/prompt-builder.ts`

Extract all prompt assembly functions:

```typescript
// Functions to move from runner.ts:
export function parseReviewFeedback(rawJson: string): string | undefined;
export async function generateCodebaseSummary(worktreePath: string): Promise<string>;
export function buildRulesSection(issue: Issue, isRevision: boolean): string;
export async function buildAgentPrompt(issue: Issue, worktreePath: string, opts?: { ... }): Promise<string>;
export async function buildFixPrompt(issue: Issue, worktreePath: string, fixType: FixType, errorContext: string, attempt: number, codebaseSummary?: string, projectKey?: string): Promise<string>;
// Also move: fileExistsAndRead, buildPreviousSessionSummary, buildRetryContext
```

Imports:
```typescript
import { join } from 'node:path';
import { config } from './config.ts';
import { readProjectMemory } from './memory.ts';
import { buildIntelligenceSection } from './project-intelligence.ts';
import { logBuffers } from './agent.ts'; // for buildRetryContext, buildPreviousSessionSummary
import type { Issue, Run, FixType } from './types.ts';
```

### 3. Create `orchestrator/src/agent.ts`

Extract agent process management:

```typescript
// Functions to move from runner.ts:
export function buildSpawnArgs(prompt: string, model?: string | null): string[];
export function parseAgentEvent(line: string): string | null;
export async function streamOutput(stream: ReadableStream<Uint8Array> | ..., runId: string, streamName: 'stdout' | 'stderr', onRawLine?: (line: string) => void): Promise<void>;
export async function readAgentSignal(worktreePath: string): Promise<AgentSignal | null>;
export async function fetchCIFailureLogs(repo: string, branch: string): Promise<string>;

// Also move: log buffering infrastructure
export const logBuffers: Map<string, Array<{ stream: string; content: string }>>;
export function bufferLog(runId: string, stream: string, content: string): void;
export function flushLogs(runId: string): void;
export function flushAllLogs(): void;

// Also move: AgentSignal type/interface, clearAgentSignal, getAgentConclusion
```

Imports:
```typescript
import { join } from 'node:path';
import { config } from './config.ts';
import { insertLog } from './db.ts';
import { GHRunListSchema } from './schemas.ts';
import type { SSEEvent } from './types.ts';
```

Note: The SSE broadcaster hook (`_sseHandler`, `onSSE`, `broadcastSSE`) stays in `agent.ts` since it's tightly coupled with log buffering.

### 4. Create `orchestrator/src/scheduler.ts`

Extract queue management:

```typescript
// Functions to move from runner.ts:
export function enqueue(run: Run): boolean;
export function enqueueWithIssue(run: Run, issue: Issue): boolean;
export function enqueueRevision(originalRun: Run, prNumber: number, issue: Issue): string;
export function enqueueRetry(failedRun: Run, issue: Issue, delayMs?: number): string | null;
export function enqueueFix(originalRun: Run, prNumber: number, issue: Issue, fixType: FixType, attempt: number): string;
export async function tick(): Promise<void>;
export function beginShutdown(): void;
export function isShuttingDown(): boolean;
export function getRunningCount(): number;

// Also move: queue array, running counter, shuttingDown flag, issueMap, retryContextMap
```

Imports:
```typescript
import { monotonicFactory } from 'ulid';
import { config } from './config.ts';
import { insertRun, getRun, updateRunStatus, getIssueForRun, hasActiveRunForIssue } from './db.ts';
import { broadcastSSE, logBuffers } from './agent.ts';
import { buildRetryContext } from './prompt-builder.ts';
import { executeRun } from './runner.ts';  // circular? see note below
import { resolveProject } from './linear.ts';
import type { Run, Issue, FixType, SSEEvent } from './types.ts';
```

**Circular dependency note**: `scheduler.tick()` calls `executeRun()` from runner.ts, and runner.ts imports scheduler functions. Break the cycle by having `runner.ts` pass `executeRun` to the scheduler via an initializer function:

```typescript
// In scheduler.ts:
let _executeRun: ((run: Run, project: ProjectConfig, key: string, issue: Issue) => Promise<void>) | null = null;

export function initScheduler(executor: typeof _executeRun): void {
  _executeRun = executor;
}

// In tick():
_executeRun!(run, resolved.project, resolved.key, issueData)
```

```typescript
// In runner.ts:
import { initScheduler } from './scheduler.ts';

export function startRunner(): void {
  initScheduler(executeRun);
  // ... rest of startRunner
}
```

### 5. Slim down `orchestrator/src/runner.ts`

After extraction, runner.ts contains only:

```typescript
import { config } from './config.ts';
import { markStaleRunsFailed, getRunsByStatus, snapshotDatabase, getDatabaseSize, deleteOldLogs, deleteOldRuns, deleteOldProcessedReviews, deleteOldNotifiedPRs, vacuumDatabase } from './db.ts';
import { onSSE, flushAllLogs, bufferLog, logBuffers } from './agent.ts';
import { enqueue, enqueueWithIssue, tick, beginShutdown, getRunningCount, isShuttingDown, initScheduler } from './scheduler.ts';
import { pollLinear, parseIssueMetadata, updateLinearStatus, commentOnIssue, commentOnPR, reconstructIssueFromRun, resolveProject, loadProjects } from './linear.ts';
import { buildAgentPrompt, generateCodebaseSummary, buildFixPrompt, parseReviewFeedback, buildRulesSection } from './prompt-builder.ts';
import { buildSpawnArgs, streamOutput, readAgentSignal, fetchCIFailureLogs } from './agent.ts';
// ... etc

// Re-export everything that server.ts and tests need
export { onSSE, startRunner, enqueueRevision, enqueueWithIssue, reconstructIssueFromRun, loadProjects, beginShutdown, getRunningCount, flushAllLogs };

// executeRun stays here (it's the core orchestration logic that ties everything together)
export async function executeRun(...) { ... }

// startRunner stays here (main loop setup)
export function startRunner(): void { ... }

// pollReviews stays here or moves to poller.ts
// pollFixable stays here or moves to poller.ts
// proactiveRebaseSiblings stays here or moves to poller.ts
// runCleanup stays here
```

### 6. Update imports in `orchestrator/src/server.ts`

Replace runner.ts imports with the specific module imports:

```typescript
import { onSSE, beginShutdown, getRunningCount, flushAllLogs } from './agent.ts';
import { startRunner, enqueueRevision, enqueueWithIssue, reconstructIssueFromRun } from './runner.ts';
import { loadProjects } from './linear.ts';
import { enqueue } from './scheduler.ts';
```

Or, if runner.ts re-exports everything, keep the import from runner.ts unchanged. The re-export approach is simpler and avoids breaking existing imports.

### 7. Update test imports

**File:** `orchestrator/src/runner.test.ts`

Update imports to point to the new modules. If runner.ts re-exports, no changes needed. Otherwise:

```typescript
import { buildSpawnArgs, readAgentSignal } from './agent.ts';
import { parseReviewFeedback } from './prompt-builder.ts';
import { parseIssueMetadata } from './linear.ts';
```

## Testing Strategy

This is a pure refactor — the primary test is that ALL existing tests pass without modification to test assertions.

```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

If any test imports directly from `runner.ts`, update those imports. If runner.ts re-exports, tests may not need changes.

**Verification checklist:**
1. `bun test` — all existing tests pass
2. `bunx tsc --noEmit` — no type errors
3. `bun run dev` — orchestrator starts without errors
4. Each new module file is under 400 lines
5. `runner.ts` is under 300 lines (ideally ~200)
6. No circular import errors at runtime

## Out of Scope

- Behavior changes of any kind (this is strictly a structural refactor)
- New tests for individual modules (existing test coverage is preserved)
- Splitting `db.ts` (it's 400+ lines but cohesive — not a priority)
- Splitting `server.ts` (reasonable size at ~300 lines)
- Splitting `notify.ts` (reasonable size at ~300 lines)
- Moving `memory.ts` internals (already a focused module)
