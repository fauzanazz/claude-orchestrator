import { describe, test, expect } from 'bun:test';
import {
  LinearIssueSummarySchema,
  LinearIssueListSchema,
  LinearIssueDetailSchema,
  GHPRListSchema,
  GHPRViewSchema,
  GHPRReviewPollSchema,
  GHRunListSchema,
} from './schemas.ts';

// ---------------------------------------------------------------------------
// Linear schemas
// ---------------------------------------------------------------------------

describe('LinearIssueSummarySchema', () => {
  test('parses valid summary', () => {
    const result = LinearIssueSummarySchema.safeParse({
      identifier: 'ENG-42',
      title: 'Fix bug',
      state: 'Ready for Agent',
    });
    expect(result.success).toBe(true);
    expect(result.data!.identifier).toBe('ENG-42');
  });

  test('allows extra fields via passthrough', () => {
    const result = LinearIssueSummarySchema.safeParse({
      identifier: 'ENG-1',
      title: 'T',
      state: 'Done',
      priority: 3,
      assignee: 'alice',
    });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).priority).toBe(3);
  });

  test('rejects missing identifier', () => {
    const result = LinearIssueSummarySchema.safeParse({ title: 'No id' });
    expect(result.success).toBe(false);
  });

  test('rejects wrong type for identifier', () => {
    const result = LinearIssueSummarySchema.safeParse({ identifier: 123 });
    expect(result.success).toBe(false);
  });
});

describe('LinearIssueListSchema', () => {
  test('parses array of summaries', () => {
    const result = LinearIssueListSchema.safeParse([
      { identifier: 'A-1', state: 'Ready for Agent' },
      { identifier: 'A-2', title: 'Task 2' },
    ]);
    expect(result.success).toBe(true);
    expect(result.data!.length).toBe(2);
  });

  test('rejects non-array', () => {
    const result = LinearIssueListSchema.safeParse({ identifier: 'A-1' });
    expect(result.success).toBe(false);
  });
});

describe('LinearIssueDetailSchema', () => {
  test('parses valid detail', () => {
    const result = LinearIssueDetailSchema.safeParse({
      id: 'ulid-123',
      identifier: 'ENG-42',
      title: 'Fix bug',
      description: 'design: docs/designs/fix.md\nbranch: agent/fix\nrepo: org/repo',
    });
    expect(result.success).toBe(true);
    expect(result.data!.id).toBe('ulid-123');
    expect(result.data!.description).toBe('design: docs/designs/fix.md\nbranch: agent/fix\nrepo: org/repo');
  });

  test('defaults description to empty string when missing', () => {
    const result = LinearIssueDetailSchema.safeParse({
      id: 'ulid-123',
      identifier: 'ENG-42',
      title: 'No desc',
    });
    expect(result.success).toBe(true);
    expect(result.data!.description).toBe('');
  });

  test('allows extra fields via passthrough', () => {
    const result = LinearIssueDetailSchema.safeParse({
      id: 'x',
      identifier: 'ENG-1',
      title: 'T',
      url: 'https://linear.app/...',
    });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).url).toBe('https://linear.app/...');
  });

  test('rejects missing required fields', () => {
    expect(LinearIssueDetailSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(LinearIssueDetailSchema.safeParse({ identifier: 'A-1' }).success).toBe(false);
    expect(LinearIssueDetailSchema.safeParse({ title: 'T' }).success).toBe(false);
  });

  test('rejects wrong types', () => {
    const result = LinearIssueDetailSchema.safeParse({
      id: 123,
      identifier: 'ENG-1',
      title: 'T',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub PR schemas
// ---------------------------------------------------------------------------

describe('GHPRListSchema', () => {
  test('parses valid PR list', () => {
    const result = GHPRListSchema.safeParse([{ number: 1 }, { number: 42 }]);
    expect(result.success).toBe(true);
    expect(result.data!.length).toBe(2);
  });

  test('rejects item with missing number', () => {
    const result = GHPRListSchema.safeParse([{ title: 'no number' }]);
    expect(result.success).toBe(false);
  });

  test('rejects item with wrong type for number', () => {
    const result = GHPRListSchema.safeParse([{ number: '42' }]);
    expect(result.success).toBe(false);
  });
});

describe('GHPRViewSchema', () => {
  const validPR = {
    number: 1,
    title: 'feat: add thing',
    url: 'https://github.com/org/repo/pull/1',
    headRefName: 'feature-branch',
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    commits: [{ committedDate: '2026-03-23T00:00:00Z' }],
    reviews: [{
      submittedAt: '2026-03-23T01:00:00Z',
      state: 'APPROVED',
      author: { login: 'reviewer' },
      body: 'LGTM',
    }],
    comments: [{ createdAt: '2026-03-23T02:00:00Z', author: { login: 'bot' } }],
  };

  test('parses full valid PR view', () => {
    const result = GHPRViewSchema.safeParse(validPR);
    expect(result.success).toBe(true);
    expect(result.data!.number).toBe(1);
    expect(result.data!.statusCheckRollup.length).toBe(1);
  });

  test('defaults optional arrays to empty when missing', () => {
    const result = GHPRViewSchema.safeParse({
      number: 1,
      title: 'T',
      url: 'https://...',
      headRefName: 'main',
    });
    expect(result.success).toBe(true);
    expect(result.data!.statusCheckRollup).toEqual([]);
    expect(result.data!.commits).toEqual([]);
    expect(result.data!.reviews).toEqual([]);
    expect(result.data!.comments).toEqual([]);
    expect(result.data!.mergeable).toBe('UNKNOWN');
    expect(result.data!.reviewDecision).toBe('');
  });

  test('allows null reviewDecision', () => {
    const result = GHPRViewSchema.safeParse({
      ...validPR,
      reviewDecision: null,
    });
    expect(result.success).toBe(true);
    expect(result.data!.reviewDecision).toBeNull();
  });

  test('allows null conclusion in status checks', () => {
    const result = GHPRViewSchema.safeParse({
      ...validPR,
      statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS', conclusion: null }],
    });
    expect(result.success).toBe(true);
    expect(result.data!.statusCheckRollup[0].conclusion).toBeNull();
  });

  test('rejects missing required fields', () => {
    expect(GHPRViewSchema.safeParse({ number: 1 }).success).toBe(false);
    expect(GHPRViewSchema.safeParse({ title: 'T' }).success).toBe(false);
  });

  test('rejects wrong type for number', () => {
    const result = GHPRViewSchema.safeParse({ ...validPR, number: '1' });
    expect(result.success).toBe(false);
  });
});

describe('GHPRReviewPollSchema', () => {
  test('parses valid review poll data', () => {
    const result = GHPRReviewPollSchema.safeParse({
      state: 'OPEN',
      reviews: [{
        id: 'r-1',
        state: 'CHANGES_REQUESTED',
        body: 'Please fix',
        author: { login: 'reviewer' },
      }],
    });
    expect(result.success).toBe(true);
    expect(result.data!.reviews.length).toBe(1);
    expect(result.data!.reviews[0].id).toBe('r-1');
  });

  test('defaults reviews to empty array when missing', () => {
    const result = GHPRReviewPollSchema.safeParse({ state: 'OPEN' });
    expect(result.success).toBe(true);
    expect(result.data!.reviews).toEqual([]);
  });

  test('allows missing state', () => {
    const result = GHPRReviewPollSchema.safeParse({ reviews: [] });
    expect(result.success).toBe(true);
    expect(result.data!.state).toBeUndefined();
  });

  test('defaults review fields', () => {
    const result = GHPRReviewPollSchema.safeParse({
      state: 'OPEN',
      reviews: [{}],
    });
    expect(result.success).toBe(true);
    expect(result.data!.reviews[0].state).toBe('');
    expect(result.data!.reviews[0].body).toBe('');
  });
});

describe('GHRunListSchema', () => {
  test('parses valid run list', () => {
    const result = GHRunListSchema.safeParse([
      { databaseId: 123, name: 'CI' },
      { databaseId: 456, name: 'Deploy' },
    ]);
    expect(result.success).toBe(true);
    expect(result.data!.length).toBe(2);
    expect(result.data![0].databaseId).toBe(123);
  });

  test('rejects missing databaseId', () => {
    const result = GHRunListSchema.safeParse([{ name: 'CI' }]);
    expect(result.success).toBe(false);
  });

  test('rejects missing name', () => {
    const result = GHRunListSchema.safeParse([{ databaseId: 123 }]);
    expect(result.success).toBe(false);
  });

  test('rejects wrong types', () => {
    const result = GHRunListSchema.safeParse([{ databaseId: '123', name: 'CI' }]);
    expect(result.success).toBe(false);
  });
});
