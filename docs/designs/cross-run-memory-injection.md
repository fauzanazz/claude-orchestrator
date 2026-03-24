# Cross-Run Memory Injection

## Context

The orchestrator writes session summaries to Obsidian after every run (via Gemini Flash 2 → `obsidian-memory save-session`), but agent prompts never READ from that memory. Each agent starts completely cold — it doesn't know what past agents learned about the project, what patterns they discovered, or what approaches they tried.

This creates a recurring pattern where agents waste their first session "discovering" the codebase structure, test commands, and conventions that previous agents already documented. By injecting relevant memory into the prompt, agents start with project knowledge from day one.

## Requirements

- Before building the agent prompt, search Obsidian memory for relevant project context
- Inject a "Project Memory" section into the prompt with: recent session summaries, key decisions, and conventions
- Memory injection is best-effort: if Obsidian or `obsidian-memory` is unavailable, skip silently
- Total injected memory is capped at 4000 characters to avoid bloating the prompt
- Works for any project that has had previous orchestrator runs (memory exists in the vault)
- No new dependencies

## Implementation

### 1. Add memory read functions

**File:** `orchestrator/src/memory.ts`

Add these functions after the existing `documentRun` export:

```typescript
// ---------------------------------------------------------------------------
// Memory read-side: inject past context into agent prompts
// ---------------------------------------------------------------------------

const MEMORY_MAX_CHARS = 4000;

/**
 * Read relevant project memory from Obsidian for injection into agent prompts.
 * Returns a formatted markdown section, or null if no relevant memory found.
 */
export async function readProjectMemory(
  projectKey: string,
  opts?: { issueTitle?: string; issueKey?: string },
): Promise<string | null> {
  // Check obsidian-memory availability
  try {
    await $`which obsidian-memory`.quiet();
  } catch {
    return null;
  }

  const sections: string[] = [];
  let totalChars = 0;

  // 1. Search for recent sessions mentioning this project
  try {
    const result = await $`obsidian-memory search ${projectKey}`.quiet().text();
    const trimmed = result.trim();
    if (trimmed.length > 50) {
      const truncated = trimmed.slice(0, Math.floor(MEMORY_MAX_CHARS * 0.6));
      sections.push(`### Recent Activity for "${projectKey}"\n\n${truncated}`);
      totalChars += truncated.length;
    }
  } catch {
    // obsidian-memory search failed — continue without project context
  }

  // 2. Search for issue-specific context if provided
  if (opts?.issueTitle && totalChars < MEMORY_MAX_CHARS) {
    try {
      const remaining = MEMORY_MAX_CHARS - totalChars;
      const query = opts.issueTitle.slice(0, 80); // Truncate long titles for search
      const result = await $`obsidian-memory search ${query}`.quiet().text();
      const trimmed = result.trim();
      if (trimmed.length > 50 && !sectionsContain(sections, trimmed)) {
        const truncated = trimmed.slice(0, Math.min(trimmed.length, remaining));
        sections.push(`### Related Context\n\n${truncated}`);
        totalChars += truncated.length;
      }
    } catch {
      // Search failed — continue without issue context
    }
  }

  if (sections.length === 0) return null;

  return [
    '## Project Memory (from past agent sessions)',
    '',
    'The following context was gathered from previous agent sessions working on this project.',
    'Use it to avoid re-discovering patterns, conventions, and project structure.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Check if any existing section already contains the new content (dedup).
 */
function sectionsContain(sections: string[], newContent: string): boolean {
  const sample = newContent.slice(0, 200);
  return sections.some((s) => s.includes(sample));
}
```

### 2. Integrate memory reading into prompt building

**File:** `orchestrator/src/runner.ts`

Add import at the top of the file:

```typescript
import { documentRun, readProjectMemory } from './memory.ts';
```

Modify `buildAgentPrompt()` (around line 523). Add a `projectKey` option and inject memory between the codebase summary and the design doc sections:

```typescript
export async function buildAgentPrompt(
  issue: Issue,
  worktreePath: string,
  opts?: {
    reviewFeedback?: string;
    isFirstSession?: boolean;
    codebaseSummary?: string;
    projectKey?: string; // NEW: for memory injection
  },
): Promise<string> {
  const { reviewFeedback, isFirstSession = true, codebaseSummary, projectKey } = opts ?? {};
  const sections: string[] = [];

  // 1. Global prompt
  const globalPrompt = await fileExistsAndRead(config.globalPromptPath);
  if (globalPrompt) sections.push(globalPrompt.trim());

  // 2. CLAUDE.md from worktree
  const claudeMd = await fileExistsAndRead(join(worktreePath, 'CLAUDE.md'));
  if (claudeMd) sections.push(claudeMd.trim());

  // 2.5. Codebase summary
  if (codebaseSummary) sections.push(codebaseSummary);

  // 2.7. Project memory (NEW) — inject on first session only
  if (isFirstSession && projectKey) {
    try {
      const memory = await readProjectMemory(projectKey, {
        issueTitle: issue.title,
        issueKey: issue.key,
      });
      if (memory) sections.push(memory);
    } catch (err) {
      console.warn(`[runner] Memory injection failed for ${projectKey}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. Design doc (existing code, unchanged)
  // ... rest of function unchanged ...
```

### 3. Pass projectKey from executeRun to buildAgentPrompt

**File:** `orchestrator/src/runner.ts`

In `executeRun()`, wherever `buildAgentPrompt` is called (two places: the fix run path and the normal run path), add `projectKey`:

In the normal run loop (around line 966):
```typescript
      let sessionBase = await buildAgentPrompt(issue, worktreePath!, {
        reviewFeedback: isFirstRun ? reviewFeedback : undefined,
        isFirstSession: isFirstRun,
        codebaseSummary,
        projectKey: projectKey,  // NEW
      });
```

In the fix run path (around line 789, inside `buildFixPrompt`):
```typescript
  const basePrompt = await buildAgentPrompt(issue, worktreePath, {
    codebaseSummary,
    projectKey,  // NEW — pass through
  });
```

Also update `buildFixPrompt` signature to accept `projectKey`:
```typescript
async function buildFixPrompt(
  issue: Issue,
  worktreePath: string,
  fixType: FixType,
  errorContext: string,
  attempt: number,
  codebaseSummary?: string,
  projectKey?: string,  // NEW
): Promise<string> {
```

And the call site in executeRun for fix runs (around line 895):
```typescript
      let fixPrompt = await buildFixPrompt(
        issue, worktreePath, run.fix_type as FixType,
        errorContext, run.fix_attempt, codebaseSummary,
        projectKey,  // NEW
      );
```

Note: `projectKey` is already available in `executeRun` as the parameter name. Verify the variable name matches — it's currently called `projectKey` in the function signature.

## Testing Strategy

**File:** `orchestrator/src/memory.test.ts`

Add tests for the new `readProjectMemory` function:

```typescript
describe('readProjectMemory', () => {
  test('returns null when obsidian-memory is not installed', async () => {
    // This test will naturally return null in CI where obsidian-memory is not available
    const result = await readProjectMemory('nonexistent-project');
    // Should return null without throwing
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('returns null for empty project key', async () => {
    const result = await readProjectMemory('');
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('caps output at MEMORY_MAX_CHARS', async () => {
    const result = await readProjectMemory('claude-orchestrator');
    if (result) {
      expect(result.length).toBeLessThanOrEqual(5000); // 4000 content + header overhead
    }
  });
});

describe('sectionsContain', () => {
  // Import and test the dedup helper
  test('detects duplicate content', () => {
    // This is a unit test for the helper — needs to be exported or tested inline
  });
});
```

**Integration verification**: After deployment, check that agent prompts for retry runs include the "Project Memory" section by reviewing logs:
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- Writing to memory (already implemented in `documentRun`)
- Memory consolidation or cleanup
- Per-file memory injection (e.g., "here's what past agents said about `src/db.ts`")
- Configurable memory injection toggle (always inject if available; it's best-effort)
- Memory injection on continuation sessions (only first session — continuations have `.agent-state/progress.md`)
