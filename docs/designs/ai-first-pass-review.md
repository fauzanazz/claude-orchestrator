# AI First-Pass Review Gate

## Context

After an agent creates a PR, the orchestrator pushes and waits for human review. But many PRs have obvious issues: missed requirements from the design doc, leftover `console.log` statements, TODO comments, or missing tests. A human reviewer catches these, triggers a revision, and waits again — wasting a full review cycle.

This task adds an automated AI review gate using Gemini Flash 2 (already a dependency for memory). After PR creation, the gate reviews the diff against the design doc. If issues are found, it automatically triggers a revision run with the feedback — before the human ever sees the PR.

## Requirements

- After a successful run creates a PR, run an AI review gate (opt-in via `AUTO_REVIEW` env var, default `false`)
- The review compares the git diff against the design doc requirements
- Checks: requirement coverage, code quality (unused imports, console.logs, TODOs), test presence
- If issues found: auto-trigger a revision run with the AI's feedback as review context
- If clean: proceed normally (human reviews)
- Skip review gate for: fix runs, revision runs (prevent infinite loops), and runs that already have a PR
- Maximum 1 auto-review per run (no recursive auto-reviews)
- Use Gemini Flash 2 (cheap, fast, already in the dependency tree)
- Log review results to the run's log buffer

## Implementation

### 1. Add config flag

**File:** `orchestrator/src/config.ts`

Add to the config object:

```typescript
export const config = {
  // ... existing config ...

  // AI auto-review gate
  autoReview: process.env.AUTO_REVIEW === 'true',
  autoReviewModel: process.env.AUTO_REVIEW_MODEL ?? 'gemini-2.0-flash',
};
```

### 2. Create review gate module

**File:** `orchestrator/src/review-gate.ts` (new)

```typescript
import { $ } from 'bun';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { config } from './config.ts';
import type { Run, Issue } from './types.ts';

export interface ReviewResult {
  pass: boolean;
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'suggestion';
  category: string;
  description: string;
  file?: string;
}

/**
 * Run an AI review gate on a completed agent run.
 * Returns a ReviewResult indicating whether the PR passes or needs revisions.
 */
export async function reviewRun(
  run: Run,
  issue: Issue,
  worktreePath: string,
): Promise<ReviewResult> {
  if (!config.geminiApiKey) {
    return { pass: true, issues: [], summary: 'Skipped: no Gemini API key' };
  }

  // Gather diff
  let diff: string;
  try {
    diff = await $`git -C ${worktreePath} diff ${issue.baseBranch}...HEAD`.text();
  } catch {
    return { pass: true, issues: [], summary: 'Skipped: could not generate diff' };
  }

  if (!diff.trim()) {
    return { pass: true, issues: [], summary: 'No changes to review' };
  }

  // Gather design doc
  let designDoc = '';
  if (issue.designPath) {
    try {
      designDoc = await Bun.file(join(worktreePath, issue.designPath)).text();
    } catch {
      designDoc = '[design doc not found]';
    }
  }

  // Truncate diff if too large (keep first 50K chars)
  const maxDiffChars = 50_000;
  const truncatedDiff = diff.length > maxDiffChars
    ? diff.slice(0, maxDiffChars) + '\n\n[... diff truncated ...]'
    : diff;

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const prompt = `You are a code reviewer for an automated coding system. Review the following PR diff against its design document.

## Design Document
${designDoc || '[No design doc — review for general code quality only]'}

## Git Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

## Review Criteria
1. **Requirement Coverage**: Does the diff implement all requirements from the design doc?
2. **Code Quality**: Are there unused imports, leftover console.log/debugger statements, TODO/FIXME comments, or dead code?
3. **Test Coverage**: If the design doc mentions a testing strategy, are tests present in the diff?
4. **Obvious Bugs**: Any null pointer risks, missing error handling, or logic errors?

## Rules
- Focus on ACTIONABLE issues only. Do not flag style preferences.
- If the implementation looks correct and complete, say so clearly.
- Be concise. One sentence per issue.
- Severity levels: "error" (must fix), "warning" (should fix), "suggestion" (nice to have)

Return a JSON object:
{
  "pass": true/false,
  "summary": "One-sentence overall assessment",
  "issues": [
    { "severity": "error|warning|suggestion", "category": "requirement|quality|testing|bug", "description": "...", "file": "optional/path" }
  ]
}

Set "pass" to false ONLY if there are "error" severity issues. Warnings and suggestions alone should still pass.

Return ONLY valid JSON, no markdown fences.`;

  const response = await ai.models.generateContent({
    model: config.autoReviewModel,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
    },
  });

  const text = response.text;
  if (!text) {
    return { pass: true, issues: [], summary: 'Skipped: empty Gemini response' };
  }

  try {
    const parsed = JSON.parse(text.trim()) as ReviewResult;

    // Validate structure
    if (typeof parsed.pass !== 'boolean' || !Array.isArray(parsed.issues)) {
      return { pass: true, issues: [], summary: 'Skipped: invalid review response structure' };
    }

    // Filter issues to valid severities
    parsed.issues = parsed.issues.filter(
      (i) => ['error', 'warning', 'suggestion'].includes(i.severity) && typeof i.description === 'string',
    );

    // Enforce: pass=false only if there are errors
    parsed.pass = !parsed.issues.some((i) => i.severity === 'error');

    return parsed;
  } catch {
    return { pass: true, issues: [], summary: 'Skipped: failed to parse review response' };
  }
}

/**
 * Format review result as markdown for injection into a revision run's prompt.
 */
export function formatReviewFeedback(result: ReviewResult): string {
  const sections: string[] = [];
  sections.push('## AI Auto-Review Feedback');
  sections.push('');
  sections.push(`**Overall**: ${result.summary}`);
  sections.push('');

  if (result.issues.length === 0) {
    sections.push('No issues found.');
    return sections.join('\n');
  }

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');

  if (errors.length > 0) {
    sections.push('### Errors (must fix)');
    for (const issue of errors) {
      sections.push(`- ${issue.file ? `\`${issue.file}\`: ` : ''}${issue.description}`);
    }
    sections.push('');
  }

  if (warnings.length > 0) {
    sections.push('### Warnings (should fix)');
    for (const issue of warnings) {
      sections.push(`- ${issue.file ? `\`${issue.file}\`: ` : ''}${issue.description}`);
    }
  }

  return sections.join('\n');
}
```

### 3. Integrate review gate into executeRun

**File:** `orchestrator/src/runner.ts`

Add import:
```typescript
import { reviewRun, formatReviewFeedback } from './review-gate.ts';
```

After PR creation in `executeRun()` (around line 1137, after the `commentOnIssue` call but before the final `bufferLog`), add the review gate:

```typescript
    // --- AI Auto-Review Gate ---
    if (
      config.autoReview &&
      !run.is_fix &&
      !run.is_revision &&
      run.retry_attempt === 0 &&
      worktreePath
    ) {
      bufferLog(runId, 'system', '[runner] Running AI auto-review gate...');
      try {
        const reviewResult = await reviewRun(updatedRun ?? run, issue, worktreePath);
        const issueCount = reviewResult.issues.length;
        const errorCount = reviewResult.issues.filter((i) => i.severity === 'error').length;

        bufferLog(runId, 'system',
          `[runner] Auto-review: ${reviewResult.pass ? 'PASS' : 'FAIL'} — ` +
          `${issueCount} issue(s) (${errorCount} error(s)). ${reviewResult.summary}`
        );

        if (!reviewResult.pass && prNum) {
          // Post review feedback as PR comment
          const feedback = formatReviewFeedback(reviewResult);
          commentOnPR(issue.repo, prNum, `### 🤖 AI Auto-Review\n\n${feedback}`);

          // Trigger a revision run with the AI feedback
          const revisionRunId = enqueueRevision(
            updatedRun ?? run,
            prNum,
            issue,
          );
          bufferLog(runId, 'system',
            `[runner] Auto-review failed — enqueued revision ${revisionRunId} with AI feedback`
          );
        }
      } catch (err) {
        bufferLog(runId, 'system',
          `[runner] Auto-review failed (non-fatal): ${err instanceof Error ? err.message : err}`
        );
      }
    }
```

Note: The review gate is skipped for fix runs, revision runs, and retry runs to prevent infinite loops. Only first-attempt, fresh runs get auto-reviewed.

## Testing Strategy

**File:** `orchestrator/src/review-gate.test.ts` (new)

```typescript
import { describe, test, expect } from 'bun:test';
import { formatReviewFeedback, type ReviewResult } from './review-gate.ts';

describe('formatReviewFeedback', () => {
  test('formats errors and warnings as markdown', () => {
    const result: ReviewResult = {
      pass: false,
      summary: 'Missing test coverage',
      issues: [
        { severity: 'error', category: 'testing', description: 'No test file found for new routes', file: 'src/routes/auth.ts' },
        { severity: 'warning', category: 'quality', description: 'console.log left in production code', file: 'src/handler.ts' },
      ],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).toContain('AI Auto-Review');
    expect(formatted).toContain('Errors (must fix)');
    expect(formatted).toContain('No test file found');
    expect(formatted).toContain('Warnings (should fix)');
    expect(formatted).toContain('console.log');
  });

  test('formats passing review', () => {
    const result: ReviewResult = {
      pass: true,
      summary: 'Implementation looks correct and complete',
      issues: [],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).toContain('No issues found');
  });

  test('handles suggestion-only review as pass', () => {
    const result: ReviewResult = {
      pass: true,
      summary: 'Good implementation with minor suggestions',
      issues: [
        { severity: 'suggestion', category: 'quality', description: 'Consider adding JSDoc' },
      ],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).not.toContain('Errors');
  });
});
```

**Commands:**
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- Multiple review rounds (only one auto-review per fresh run; revisions skip the gate)
- Configurable review criteria per project
- Human-in-the-loop approval of AI review before triggering revision
- Dashboard UI for review results
- Using Claude instead of Gemini for the review (Gemini is cheaper for this use case)
- Auto-approve/merge on passing review (separate auto-merge feature)
