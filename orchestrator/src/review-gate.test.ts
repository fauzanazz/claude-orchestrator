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

  test('formats passing review with no issues', () => {
    const result: ReviewResult = {
      pass: true,
      summary: 'Implementation looks correct and complete',
      issues: [],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).toContain('No issues found');
    expect(formatted).not.toContain('Errors');
  });

  test('handles suggestion-only review (no errors/warnings sections)', () => {
    const result: ReviewResult = {
      pass: true,
      summary: 'Good implementation with minor suggestions',
      issues: [
        { severity: 'suggestion', category: 'quality', description: 'Consider adding JSDoc' },
      ],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).not.toContain('Errors');
    expect(formatted).not.toContain('Warnings');
    // Suggestions are not rendered (only errors and warnings are)
    expect(formatted).not.toContain('No issues found');
  });

  test('includes file paths when present', () => {
    const result: ReviewResult = {
      pass: false,
      summary: 'Issues found',
      issues: [
        { severity: 'error', category: 'bug', description: 'Null pointer risk', file: 'src/utils.ts' },
      ],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).toContain('`src/utils.ts`');
    expect(formatted).toContain('Null pointer risk');
  });

  test('omits file path when not present', () => {
    const result: ReviewResult = {
      pass: false,
      summary: 'Issues found',
      issues: [
        { severity: 'error', category: 'requirement', description: 'Missing authentication endpoint' },
      ],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).toContain('- Missing authentication endpoint');
    expect(formatted).not.toContain('`');
  });

  test('includes overall summary', () => {
    const result: ReviewResult = {
      pass: true,
      summary: 'Solid implementation overall',
      issues: [],
    };
    const formatted = formatReviewFeedback(result);
    expect(formatted).toContain('**Overall**: Solid implementation overall');
  });
});
