# Multi-Session Loop for executeRun

## Context

Currently, each orchestrator run spawns a single `claude --print` session that must complete the entire design doc implementation in one context window. For complex design docs with multiple requirements, a single session can run out of context or lose focus. This upgrade implements the auto-claude "loop" pattern: multiple fresh sessions with file-based state handoff, where each session picks up where the last one left off.

## Requirements

- Each run spawns multiple sequential Claude Code sessions instead of one
- First session uses an "initializer" prompt (orient, plan, create feature list, start implementing)
- Subsequent sessions use a "coding" prompt (read state files, continue implementing)
- 3-second configurable delay between sessions
- State handoff via `.agent-state/features.json` and `.agent-state/progress.md` in the worktree
- `.agent-state/` is gitignored so the agent can't accidentally commit state files
- Loop terminates when: all features pass, max iterations (10) hit, or total run timeout exceeded
- Per-session timeout (30 min) kills that session but continues the loop
- After the loop, check for commits — push + PR if commits exist, fail if none
- Iteration count tracked in the database and broadcast via SSE

## Implementation

### 1. Config — `orchestrator/src/config.ts`

Add three new env vars to the `config` object (after `agentTimeoutMs`):

```typescript
maxSessionIterations: parseInt(process.env.MAX_SESSION_ITERATIONS ?? '10', 10),
sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS ?? '1800000', 10), // 30 min per session
autoContinueDelayMs: parseInt(process.env.AUTO_CONTINUE_DELAY_MS ?? '3000', 10),
```

`agentTimeoutMs` (existing, default 30 min) becomes the **total run envelope** across all sessions. Increase its default to `7200000` (2 hours) since the loop is expected to run longer:

```typescript
agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS ?? '7200000', 10),  // was 1800000
```

### 2. Types — `orchestrator/src/types.ts`

Add `iterations` to the `Run` interface (after `agent_pid`):

```typescript
iterations: number;            // how many sessions have completed for this run
```

Add a new SSE event variant (extend the `SSEEvent` union):

```typescript
export type SSEEvent =
  | { type: 'run_update'; run: Run }
  | { type: 'log'; runId: string; stream: string; content: string }
  | { type: 'iteration'; runId: string; current: number; max: number; allDone: boolean };
```

### 3. Database — `orchestrator/src/db.ts`

**Migration:** Add `iterations` column. Use a safe check pattern since bun:sqlite doesn't have IF NOT EXISTS for columns:

```typescript
try {
  db.run(`ALTER TABLE runs ADD COLUMN iterations INTEGER NOT NULL DEFAULT 0`);
} catch {
}
```

**New prepared statement and function:**

```typescript
const stmtUpdateRunIterations = db.prepare<void, [number, string]>(
  `UPDATE runs SET iterations = ? WHERE id = ?`
);

export function updateRunIterations(id: string, iterations: number): void {
  stmtUpdateRunIterations.run(iterations, id);
}
```

**Update `stmtInsertRun`:** No change needed — the DEFAULT 0 handles new inserts.

### 4. New file — `orchestrator/src/prompts.ts`

This file contains session-mode prompt builders and feature-list utilities.

```typescript

import { join } from 'node:path';

export interface FeatureEntry {
  name: string;
  description: string;
  passes: boolean;
}

export interface SessionPromptContext {
  basePrompt: string;
  issueKey: string;
}

export function buildInitializerPrompt(ctx: SessionPromptContext): string
```

**`buildInitializerPrompt(ctx: SessionPromptContext): string`**

Returns `ctx.basePrompt` + the following markdown section appended:

```markdown
---

## Session Mode: Initializer

This is your FIRST session on this task. You have never seen this codebase before.

Follow these steps in order:

1. **Read the design document** above carefully. Understand every requirement.
2. **Explore the codebase** — read the project structure, key files, and existing patterns.
3. **Create `.agent-state/features.json`** with this exact structure:
   ```json
   [
     { "name": "short-kebab-name", "description": "What to implement", "passes": false },
     ...
   ]
   ```
   Extract each distinct requirement from the design document as a separate feature entry.
4. **Start implementing** — pick the first feature(s) and write the code.
5. **Run tests** to verify your changes work and don't break existing functionality.
6. **Commit your work** with conventional commit messages referencing the issue key.
7. **Update `.agent-state/features.json`** — set `passes: true` for any completed features.
8. **Write `.agent-state/progress.md`** before finishing, summarizing:
   - What you accomplished
   - What's left to do
   - Any decisions made or blockers encountered

Do as much as you can in this session. The next session will pick up where you left off.
```

---

```typescript
export function buildCodingPrompt(ctx: SessionPromptContext): string
```

**`buildCodingPrompt(ctx: SessionPromptContext): string`**

Returns `ctx.basePrompt` + the following markdown section appended:

```markdown
---

## Session Mode: Coding (Continuation)

This is a CONTINUATION session. Previous session(s) already worked on this task.
You have NO memory of previous sessions — all context is in the files below.

Follow these steps in order:

1. **Read `.agent-state/features.json`** to see which features are done (`passes: true`) and which remain.
2. **Read `.agent-state/progress.md`** for context from the last session.
3. **Run `git log --oneline -20`** to see what was committed recently.
4. **Pick the next incomplete feature** (`passes: false`) and implement it.
5. **Run tests** to verify your changes work and don't break existing functionality.
6. **Commit your work** with conventional commit messages referencing the issue key.
7. **Update `.agent-state/features.json`** — set `passes: true` for completed features.
8. **Update `.agent-state/progress.md`** with:
   - What you accomplished this session
   - What's left to do
   - Any decisions made or blockers encountered

Do as much as you can in this session. If features remain, another session will continue after you.
```

---

```typescript
export async function readFeatureList(worktreePath: string): Promise<FeatureEntry[] | null>
```

Reads `join(worktreePath, '.agent-state', 'features.json')` using `Bun.file().text()`. Parses as JSON. Returns the parsed `FeatureEntry[]` if valid (array, each entry has `name`, `description`, `passes`). Returns `null` if file doesn't exist, is empty, or fails to parse.

---

```typescript
export function isAllFeaturesDone(features: FeatureEntry[] | null): boolean
```

Returns `true` only if `features` is non-null, has length > 0, and every entry has `passes === true`. Returns `false` otherwise.

### 5. Agent state setup — `orchestrator/src/git.ts`

Add a new exported function at the end of the file:

```typescript
export async function setupAgentState(worktreePath: string): Promise<void>
```

**Implementation:**

1. Create directory: `await mkdir(join(worktreePath, '.agent-state'), { recursive: true })`
2. Read existing `.gitignore` from worktree (or empty string if none exists)
3. If `.gitignore` doesn't already contain `.agent-state`, append:
   ```
   \n# Agent orchestrator state (auto-generated)\n.agent-state/\n
   ```
4. Write the updated `.gitignore` back

Uses `Bun.file()` for reads and `Bun.write()` for writes. No git commands needed.

### 6. Commit check utility — `orchestrator/src/git.ts`

Add another exported function:

```typescript
export async function hasLocalCommits(worktreePath: string): Promise<boolean>
```

**Implementation:** Run `git -C <worktreePath> log @{upstream}..HEAD --oneline` via the existing `spawn()` helper. Return `true` if stdout is non-empty (has at least one line), `false` otherwise. If the command fails (e.g., no upstream), fall back to checking `git log --oneline -1` to see if HEAD moved.

### 7. Loop refactor — `orchestrator/src/runner.ts`

**New imports** at top of file:

```typescript
import {
  buildInitializerPrompt,
  buildCodingPrompt,
  readFeatureList,
  isAllFeaturesDone,
  type SessionPromptContext,
} from './prompts.ts';
import { setupAgentState, hasLocalCommits } from './git.ts';  // add to existing import
import { updateRunIterations } from './db.ts';                 // add to existing import
```

**Refactor `executeRun`** (lines ~337-503). The function keeps the same signature. Here's the new structure:

```typescript
export async function executeRun(
  run: Run,
  project: ProjectConfig,
  projectKey: string,
  issue: Issue,
): Promise<void> {
  const runId = run.id;
  let worktreePath: string | null = null;
  let projectPath: string | null = null;

  try {
    updateLinearStatus(issue.key, 'In Progress');
    updateRunStatus(runId, 'running', { started_at: new Date().toISOString() });
    bufferLog(runId, 'system', `[runner] Starting run ${runId} for ${issue.key}`);

    projectPath = await ensureProjectLocal(project, projectKey);
    bufferLog(runId, 'system', `[runner] Project path: ${projectPath}`);

    const slug = ulid().slice(-6).toLowerCase();
    worktreePath = await setupWorktree(projectPath, issue.branch, issue.key, slug);
    bufferLog(runId, 'system', `[runner] Worktree: ${worktreePath}`);

    await writeAgentSettings(worktreePath);
    await initWorktree(worktreePath, project.init, runId, bufferLog);

    await setupAgentState(worktreePath);

    let reviewFeedback: string | undefined;
    let prInstructions = '';

    if (run.pr_number) {
      bufferLog(runId, 'system', `[runner] Fetching review comments for PR #${run.pr_number}`);
      const ghProc = Bun.spawn(
        ['gh', 'pr', 'view', String(run.pr_number), '--repo', issue.repo, '--json', 'reviews,comments'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [ghOut] = await Promise.all([new Response(ghProc.stdout).text(), ghProc.exited]);
      reviewFeedback = ghOut.trim() || undefined;
      prInstructions =
        `\n\n## PR Instructions\n\n` +
        `This is a revision of PR #${run.pr_number}. ` +
        `After committing your changes, the orchestrator will push and update the existing PR automatically. ` +
        `Use \`gh pr review\` to understand reviewer feedback and address all requested changes.`;
    }

    const basePrompt = (await buildAgentPrompt(issue, worktreePath, reviewFeedback)) + prInstructions;
    const ctx: SessionPromptContext = { basePrompt, issueKey: issue.key };

    const runStartTime = Date.now();
    let isFirstRun = true;
    let iteration = 0;

    for (; iteration < config.maxSessionIterations; iteration++) {
      const elapsed = Date.now() - runStartTime;
      if (elapsed > config.agentTimeoutMs) {
        bufferLog(runId, 'system', `[runner] Total run timeout (${config.agentTimeoutMs}ms) reached after ${iteration} session(s)`);
        break;
      }

      const prompt = isFirstRun
        ? buildInitializerPrompt(ctx)
        : buildCodingPrompt(ctx);
      isFirstRun = false;

      bufferLog(runId, 'system', `[runner] Starting session ${iteration + 1}/${config.maxSessionIterations}`);

      const agentProc = Bun.spawn(
        [config.claudeCodePath, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', prompt],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' },
      );

      updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

      const sessionTimeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), config.sessionTimeoutMs),
      );

      const completion = Promise.all([
        streamOutput(agentProc.stdout, runId, 'stdout'),
        streamOutput(agentProc.stderr, runId, 'stderr'),
        agentProc.exited,
      ]).then(() => 'done' as const);

      const result = await Promise.race([completion, sessionTimeout]);

      if (result === 'timeout') {
        bufferLog(runId, 'system', `[runner] Session ${iteration + 1} timed out after ${config.sessionTimeoutMs}ms — killing`);
        agentProc.kill();
      } else {
        const exitCode = agentProc.exitCode ?? 0;
        bufferLog(runId, 'system', `[runner] Session ${iteration + 1} exited with code ${exitCode}`);
      }

      updateRunIterations(runId, iteration + 1);

      broadcastSSE({ type: 'iteration', runId, current: iteration + 1, max: config.maxSessionIterations, allDone: false });

      const features = await readFeatureList(worktreePath!);
      if (isAllFeaturesDone(features)) {
        bufferLog(runId, 'system', `[runner] All features complete after ${iteration + 1} session(s)`);
        broadcastSSE({ type: 'iteration', runId, current: iteration + 1, max: config.maxSessionIterations, allDone: true });
        break;
      }

      if (iteration < config.maxSessionIterations - 1) {
        bufferLog(runId, 'system', `[runner] Waiting ${config.autoContinueDelayMs}ms before next session`);
        await new Promise((resolve) => setTimeout(resolve, config.autoContinueDelayMs));
      }
    }

    bufferLog(runId, 'system', `[runner] Loop finished after ${iteration + 1} session(s)`);

    const hasCommits = await hasLocalCommits(worktreePath!);

    if (!hasCommits) {
      throw new Error(`No commits made after ${iteration + 1} session(s) — nothing to push`);
    }

    bufferLog(runId, 'system', `[runner] Pushing branch ${issue.branch}`);
    await pushFromWorktree(worktreePath!, issue.branch);

    let prUrl: string;
    if (run.pr_number) {
      prUrl = `https://github.com/${issue.repo}/pull/${run.pr_number}`;
      bufferLog(runId, 'system', `[runner] Updated existing PR: ${prUrl}`);
    } else {
      prUrl = await createPR({
        repo: issue.repo,
        base: issue.baseBranch,
        head: issue.branch,
        title: `[${issue.key}] ${issue.title}`,
        body: `Automated implementation for ${issue.key}.\n\nDesign: \`${issue.designPath}\``,
        reviewer: config.githubUsername,
      });
      bufferLog(runId, 'system', `[runner] Created PR: ${prUrl}`);
    }

    updateRunStatus(runId, 'success', {
      pr_url: prUrl,
      completed_at: new Date().toISOString(),
    });
    updateLinearStatus(issue.key, 'In Review');
    commentOnIssue(issue.key, `PR ready for review: ${prUrl}`);

    bufferLog(runId, 'system', `[runner] Run ${runId} completed successfully after ${iteration + 1} session(s)`);

    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    bufferLog(runId, 'system', `[runner] Run ${runId} failed: ${errorMessage}`);
    updateRunStatus(runId, 'failed', {
      error_summary: errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    });
    updateLinearStatus(issue.key, 'Failed');
    commentOnIssue(issue.key, `Agent run failed: ${errorMessage.slice(0, 200)}`);
    const updatedRun = getRun(runId);
    if (updatedRun) broadcastSSE({ type: 'run_update', run: updatedRun });

  } finally {
    flushLogs(runId);
    if (projectPath && worktreePath) {
      cleanupWorktree(projectPath, worktreePath).catch(() => {});
    }
  }
}
```

### Summary of all file changes

| File | Action | What changes |
|------|--------|-------------|
| `src/config.ts` | Modify | Add 3 env vars, bump `agentTimeoutMs` default to 2h |
| `src/types.ts` | Modify | Add `iterations` to `Run`, add `iteration` SSE event |
| `src/db.ts` | Modify | Add `iterations` column migration, add `updateRunIterations()` |
| `src/prompts.ts` | **Create** | `buildInitializerPrompt()`, `buildCodingPrompt()`, `readFeatureList()`, `isAllFeaturesDone()` |
| `src/git.ts` | Modify | Add `setupAgentState()`, `hasLocalCommits()` |
| `src/runner.ts` | Modify | Refactor `executeRun()` to multi-session loop, add imports |

## Testing Strategy

1. **Unit tests for `src/prompts.ts`** — create `src/prompts.test.ts`:
   - `readFeatureList`: valid JSON → returns array; invalid JSON → returns null; missing file → returns null
   - `isAllFeaturesDone`: all passes → true; partial → false; null → false; empty array → false
   - `buildInitializerPrompt`: output contains base prompt + "Session Mode: Initializer"
   - `buildCodingPrompt`: output contains base prompt + "Session Mode: Coding"

2. **Unit tests for new `src/git.ts` functions** — add to existing or create `src/git.test.ts`:
   - `setupAgentState`: creates `.agent-state/` dir, appends to `.gitignore`, idempotent on second call
   - `hasLocalCommits`: returns true when commits exist ahead of upstream, false otherwise

3. **Manual integration test**:
   - Run `bun run dev`, trigger a real run from Linear
   - Verify in logs: "Starting session 1/10", "Starting session 2/10", etc.
   - Verify `.agent-state/` is created and gitignored in worktree
   - Verify `features.json` is created by the initializer session
   - Verify loop exits early when all features pass
   - Verify PR is created after loop completes

## Out of Scope

- **Spec update mode** — no `is_spec_update` prompt. Design docs are immutable during a run.
- **Dashboard iteration UI** — the HTML board doesn't render iteration progress yet. Logs and SSE events are sufficient for now.
- **External prompt templates** — prompts are inline in `src/prompts.ts`, not editable `.md` files.
- **Parallel sessions** — sessions run sequentially. Parallel feature implementation is a separate design.
- **Configurable per-project iteration limits** — all runs use the same global `MAX_SESSION_ITERATIONS`.
