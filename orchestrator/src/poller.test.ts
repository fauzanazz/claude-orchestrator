import { describe, test, expect } from 'bun:test';
import { parseIssueMetadata } from './poller.ts';

describe('parseIssueMetadata', () => {
  // --- Structured format: "design: ...\nbranch: ...\nrepo: ..." ---

  test('parses full structured metadata (design + branch + repo)', () => {
    const desc = 'design: docs/designs/auth.md\nbranch: agent/auth\nrepo: acme/app';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: 'docs/designs/auth.md',
      branch: 'agent/auth',
      repo: 'acme/app',
    });
  });

  test('parses designless metadata (branch + repo only)', () => {
    const desc = 'branch: agent/fix-bug\nrepo: acme/app';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: null,
      branch: 'agent/fix-bug',
      repo: 'acme/app',
    });
  });

  test('handles metadata embedded in larger description', () => {
    const desc = [
      'This task implements the new login flow.',
      '',
      'design: docs/designs/login-flow.md',
      'branch: agent/login-flow',
      'repo: org/frontend',
      '',
      'Some extra notes here.',
    ].join('\n');
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: 'docs/designs/login-flow.md',
      branch: 'agent/login-flow',
      repo: 'org/frontend',
    });
  });

  test('handles extra whitespace around values', () => {
    const desc = 'design:   docs/designs/trim.md  \nbranch:  agent/trim  \nrepo:  acme/app  ';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: 'docs/designs/trim.md',
      branch: 'agent/trim',
      repo: 'acme/app',
    });
  });

  test('returns null when branch is missing', () => {
    const desc = 'design: docs/designs/foo.md\nrepo: acme/app';
    expect(parseIssueMetadata(desc)).toBeNull();
  });

  test('returns null when repo is missing', () => {
    const desc = 'design: docs/designs/foo.md\nbranch: agent/foo';
    expect(parseIssueMetadata(desc)).toBeNull();
  });

  test('returns null for empty description', () => {
    expect(parseIssueMetadata('')).toBeNull();
  });

  test('returns null for description with no metadata', () => {
    expect(parseIssueMetadata('Just a plain description with no metadata')).toBeNull();
  });

  // --- Validation failures ---

  test('returns null when branch contains shell metacharacters', () => {
    const desc = 'branch: agent; rm -rf /\nrepo: acme/app';
    expect(parseIssueMetadata(desc)).toBeNull();
  });

  test('returns null when repo format is invalid', () => {
    const desc = 'branch: agent/foo\nrepo: just-a-name';
    expect(parseIssueMetadata(desc)).toBeNull();
  });

  test('returns null when design path has invalid prefix', () => {
    const desc = 'design: src/evil.md\nbranch: agent/foo\nrepo: acme/app';
    // branch + repo are valid, but designPath validation will throw
    // Since it catches the error and returns null:
    const result = parseIssueMetadata(desc);
    expect(result).toBeNull();
  });

  // --- Prose-style fallback ---

  test('parses prose-style description with branch and repo', () => {
    const desc = 'Please branch agent/new-feature and work in repo: acme/backend';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: null,
      branch: 'agent/new-feature',
      repo: 'acme/backend',
    });
  });

  test('parses prose-style with design doc reference', () => {
    const desc = 'design doc: docs/designs/api-redesign.md\nbranch agent/api-redesign\nrepo: acme/service';
    const result = parseIssueMetadata(desc);
    // Prose fallback should capture branch and repo
    expect(result).not.toBeNull();
    expect(result!.branch).toBe('agent/api-redesign');
    expect(result!.repo).toBe('acme/service');
  });

  // --- Case insensitivity of field names ---

  test('handles case-insensitive field names', () => {
    const desc = 'Design: docs/designs/case.md\nBranch: agent/case\nRepo: acme/app';
    const result = parseIssueMetadata(desc);
    expect(result).toEqual({
      designPath: 'docs/designs/case.md',
      branch: 'agent/case',
      repo: 'acme/app',
    });
  });
});
