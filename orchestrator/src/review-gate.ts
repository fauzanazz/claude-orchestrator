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
