import { describe, test, expect } from 'bun:test';
import { parseReviewFeedback } from './agent-prompts.ts';

describe('parseReviewFeedback', () => {
  test('extracts reviewer name and body from reviews', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Please fix the bug' },
      ],
      comments: [],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('alice');
    expect(result).toContain('changes_requested');
    expect(result).toContain('Please fix the bug');
  });

  test('extracts comments', () => {
    const json = JSON.stringify({
      reviews: [],
      comments: [
        { author: { login: 'bob' }, body: 'Nice work but check line 42' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('bob');
    expect(result).toContain('Nice work but check line 42');
  });

  test('skips empty approved reviews', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'APPROVED', body: '' },
      ],
      comments: [],
    });
    expect(parseReviewFeedback(json)).toBeUndefined();
  });

  test('skips empty commented reviews', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'COMMENTED', body: '' },
      ],
      comments: [],
    });
    expect(parseReviewFeedback(json)).toBeUndefined();
  });

  test('returns undefined for invalid JSON', () => {
    expect(parseReviewFeedback('not json')).toBeUndefined();
  });

  test('returns undefined when no actionable content', () => {
    const json = JSON.stringify({ reviews: [], comments: [] });
    expect(parseReviewFeedback(json)).toBeUndefined();
  });

  test('handles missing author gracefully', () => {
    const json = JSON.stringify({
      reviews: [
        { state: 'CHANGES_REQUESTED', body: 'Fix this' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('unknown');
    expect(result).toContain('Fix this');
  });

  test('combines multiple reviews with separators', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Fix A' },
        { author: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Fix B' },
      ],
      comments: [],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('alice');
    expect(result).toContain('bob');
    expect(result).toContain('Fix A');
    expect(result).toContain('Fix B');
    expect(result).toContain('---');
  });

  test('combines reviews and comments', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Review note' },
      ],
      comments: [
        { author: { login: 'bob' }, body: 'Inline comment' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('Review note');
    expect(result).toContain('Inline comment');
  });

  test('skips empty comment bodies', () => {
    const json = JSON.stringify({
      reviews: [],
      comments: [
        { author: { login: 'alice' }, body: '' },
        { author: { login: 'bob' }, body: 'Actual comment' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('bob');
    expect(result).toContain('Actual comment');
    // alice's empty comment should be skipped
    expect(result).not.toContain('alice');
  });

  test('renders _No comment body_ for non-empty-but-approved review with no body', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: '' },
      ],
    });
    const result = parseReviewFeedback(json);
    expect(result).toContain('_No comment body_');
  });
});
