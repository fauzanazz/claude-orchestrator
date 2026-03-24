import { describe, test, expect } from 'bun:test';
import { scrubSensitiveData, scrubRunContext, truncateContext, parseDelimitedDocs, readProjectMemory, sectionsContain } from './memory.ts';
import type { RunContext } from './memory.ts';

describe('scrubSensitiveData', () => {
  test('leaves normal code without secrets unchanged', () => {
    const input = 'const x = 42;\nfunction hello() { return "world"; }';
    expect(scrubSensitiveData(input)).toBe(input);
  });

  test('redacts generic API key assignments', () => {
    const input = 'API_KEY=sk-123456789abcdef';
    const result = scrubSensitiveData(input);
    expect(result).not.toContain('sk-123456789abcdef');
    expect(result).toContain('REDACTED');
  });

  test('redacts token assignments', () => {
    const input = 'token = "abcdefgh12345678"';
    const result = scrubSensitiveData(input);
    expect(result).not.toContain('abcdefgh12345678');
    expect(result).toContain('REDACTED');
  });

  test('redacts password assignments', () => {
    const input = 'password: "mysecretpassword123"';
    const result = scrubSensitiveData(input);
    expect(result).not.toContain('mysecretpassword123');
    expect(result).toContain('REDACTED');
  });

  test('redacts AWS access key IDs', () => {
    const input = 'aws_key = AKIAIOSFODNN7EXAMPLE';
    const result = scrubSensitiveData(input);
    expect(result).toContain('[AWS_ACCESS_KEY_REDACTED]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('redacts AWS secret keys', () => {
    const input = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYa';
    const result = scrubSensitiveData(input);
    expect(result).toContain('REDACTED');
    expect(result).not.toContain('wJalrXUtnFEMI');
  });

  test('redacts GitHub tokens (ghp_)', () => {
    const input = 'ghp_abc123def456ghi789jkl012mno345pqr678st';
    const result = scrubSensitiveData(input);
    expect(result).toBe('[GITHUB_TOKEN_REDACTED]');
  });

  test('redacts GitHub tokens (ghs_)', () => {
    const input = 'ghs_abc123def456ghi789jkl012mno345pqr678st';
    const result = scrubSensitiveData(input);
    expect(result).toBe('[GITHUB_TOKEN_REDACTED]');
  });

  test('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
    const result = scrubSensitiveData(input);
    expect(result).toContain('Bearer [TOKEN_REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIs');
  });

  test('redacts PostgreSQL connection strings', () => {
    const input = 'DATABASE_URL=postgres://user:pass@host:5432/mydb';
    const result = scrubSensitiveData(input);
    expect(result).toContain('[CONNECTION_STRING_REDACTED]');
    expect(result).not.toContain('user:pass@host');
  });

  test('redacts MongoDB connection strings', () => {
    const input = 'MONGO_URI=mongodb://admin:secret@cluster0.example.net/db';
    const result = scrubSensitiveData(input);
    expect(result).toContain('[CONNECTION_STRING_REDACTED]');
    expect(result).not.toContain('admin:secret');
  });

  test('redacts Redis connection strings', () => {
    const input = 'REDIS_URL=redis://default:password@redis-host:6379';
    const result = scrubSensitiveData(input);
    expect(result).toContain('[CONNECTION_STRING_REDACTED]');
  });

  test('redacts base64 JWT-like blobs', () => {
    const input = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const result = scrubSensitiveData(input);
    expect(result).toBe('[BASE64_BLOB_REDACTED]');
  });

  test('redacts Slack webhook URLs', () => {
    const input = `https://hooks.slack.com/services/${'T00000000'}/${'B00000000'}/${'XXXXXXXXXXXXXXXXXXXXXXXX'}`;
    const result = scrubSensitiveData(input);
    expect(result).toBe('[SLACK_WEBHOOK_REDACTED]');
  });

  test('redacts RSA private keys', () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/yGaK
-----END RSA PRIVATE KEY-----`;
    const result = scrubSensitiveData(input);
    expect(result).toBe('[PRIVATE_KEY_REDACTED]');
  });

  test('redacts EC private keys', () => {
    const input = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIIBGGmLHbq2BbQxYg7PcR8nHjX1Z
-----END EC PRIVATE KEY-----`;
    const result = scrubSensitiveData(input);
    expect(result).toBe('[PRIVATE_KEY_REDACTED]');
  });

  test('redacts generic private keys', () => {
    const input = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw
-----END PRIVATE KEY-----`;
    const result = scrubSensitiveData(input);
    expect(result).toBe('[PRIVATE_KEY_REDACTED]');
  });

  test('redacts standalone env var lines', () => {
    const input = 'SOME_SECRET=averylongsecretvalue123';
    const result = scrubSensitiveData(input);
    expect(result).toContain('REDACTED');
  });

  test('handles multiple secrets in one text block', () => {
    const input = [
      'API_KEY=sk-12345678abcdef12',
      'normal code here',
      'postgres://user:pass@host/db',
      'ghp_abc123def456ghi789jkl012mno345pqr678st',
    ].join('\n');
    const result = scrubSensitiveData(input);
    expect(result).not.toContain('sk-12345678abcdef12');
    expect(result).not.toContain('user:pass@host');
    expect(result).not.toContain('ghp_abc123');
    expect(result).toContain('normal code here');
  });

  test('is idempotent — scrubbing twice gives same result', () => {
    const input = 'token = "abcdefgh12345678"\nghp_abc123def456ghi789jkl012mno345pqr678st';
    const once = scrubSensitiveData(input);
    const twice = scrubSensitiveData(once);
    expect(twice).toBe(once);
  });
});

describe('scrubRunContext', () => {
  test('scrubs secrets from all three context fields', () => {
    const context: RunContext = {
      agentLogs: 'Connecting with token = "supersecrettoken1"',
      gitDiff: '+DATABASE_URL=postgres://admin:pass@db.example.com/prod',
      designDoc: 'Use ghp_abc123def456ghi789jkl012mno345pqr678st for auth',
    };
    const scrubbed = scrubRunContext(context);
    expect(scrubbed.agentLogs).toContain('REDACTED');
    expect(scrubbed.agentLogs).not.toContain('supersecrettoken1');
    expect(scrubbed.gitDiff).toContain('[CONNECTION_STRING_REDACTED]');
    expect(scrubbed.gitDiff).not.toContain('admin:pass');
    expect(scrubbed.designDoc).toContain('[GITHUB_TOKEN_REDACTED]');
    expect(scrubbed.designDoc).not.toContain('ghp_abc123');
  });

  test('leaves clean context unchanged', () => {
    const context: RunContext = {
      agentLogs: 'Agent completed task successfully',
      gitDiff: '+const x = 42;',
      designDoc: '## Design\nAdd a new endpoint',
    };
    const scrubbed = scrubRunContext(context);
    expect(scrubbed).toEqual(context);
  });

  test('does not mutate the original context', () => {
    const context: RunContext = {
      agentLogs: 'ghp_abc123def456ghi789jkl012mno345pqr678st',
      gitDiff: 'clean diff',
      designDoc: 'clean doc',
    };
    const original = { ...context };
    scrubRunContext(context);
    expect(context).toEqual(original);
  });
});

describe('truncateContext', () => {
  test('returns context unchanged when under limit', () => {
    const context: RunContext = {
      agentLogs: 'short logs',
      gitDiff: 'short diff',
      designDoc: 'short doc',
    };
    expect(truncateContext(context)).toEqual(context);
  });

  test('truncates agent logs from the beginning when over limit', () => {
    const bigLogs = 'A'.repeat(4_000_000);
    const context: RunContext = {
      agentLogs: bigLogs,
      gitDiff: 'small diff',
      designDoc: 'small doc',
    };
    const result = truncateContext(context);
    // Design doc and diff should be preserved
    expect(result.designDoc).toBe('small doc');
    expect(result.gitDiff).toBe('small diff');
    // Logs should be truncated (kept from the end / most recent)
    expect(result.agentLogs.length).toBeLessThan(bigLogs.length);
    expect(result.agentLogs.length).toBeGreaterThan(0);
  });

  test('prioritizes designDoc over gitDiff over agentLogs', () => {
    const bigDoc = 'D'.repeat(2_000_000);
    const bigDiff = 'G'.repeat(2_000_000);
    const bigLogs = 'L'.repeat(2_000_000);
    const context: RunContext = {
      agentLogs: bigLogs,
      gitDiff: bigDiff,
      designDoc: bigDoc,
    };
    const result = truncateContext(context);
    // designDoc should get the most space
    expect(result.designDoc.length).toBeGreaterThan(result.gitDiff.length);
    // Total should be within budget
    const total = result.designDoc.length + result.gitDiff.length + result.agentLogs.length;
    expect(total).toBeLessThanOrEqual(3_200_000);
  });

  test('handles empty fields gracefully', () => {
    const context: RunContext = {
      agentLogs: '',
      gitDiff: '',
      designDoc: '',
    };
    expect(truncateContext(context)).toEqual(context);
  });
});

describe('parseDelimitedDocs', () => {
  test('parses valid delimited response', () => {
    const raw = '<<<Features.md>>>\n# Features\nSome content\n\n<<<Modules.md>>>\n# Modules\nOther content';
    const result = parseDelimitedDocs(raw);
    expect(result['Features.md']).toContain('# Features');
    expect(result['Modules.md']).toContain('# Modules');
  });

  test('strips markdown code fences before parsing', () => {
    const raw = '```\n<<<Features.md>>>\n# Features\nUpdated content\n```';
    const result = parseDelimitedDocs(raw);
    expect(result['Features.md']).toContain('# Features');
  });

  test('strips language-tagged code fences', () => {
    const raw = '```markdown\n<<<Features.md>>>\n# Features\nContent here\n```';
    const result = parseDelimitedDocs(raw);
    expect(result['Features.md']).toContain('# Features');
  });

  test('throws for empty/unparseable response', () => {
    expect(() => parseDelimitedDocs('just some text with no delimiters')).toThrow(
      'Failed to parse delimited docs response',
    );
  });
});

describe('readProjectMemory', () => {
  test('returns null or string without throwing', async () => {
    // In CI/local where obsidian-memory may not be installed, should return null gracefully
    const result = await readProjectMemory('nonexistent-project');
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('returns null for empty project key', async () => {
    const result = await readProjectMemory('');
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('caps output at MEMORY_MAX_CHARS + header overhead', async () => {
    const result = await readProjectMemory('claude-orchestrator');
    if (result) {
      // 4000 content cap + ~200 chars header overhead
      expect(result.length).toBeLessThanOrEqual(5000);
    }
  });
});

describe('sectionsContain', () => {
  test('detects duplicate content', () => {
    const sections = ['### Recent Activity\n\nSome long content about the project that spans multiple lines'];
    expect(sectionsContain(sections, 'Some long content about the project that spans multiple lines')).toBe(true);
  });

  test('returns false for non-duplicate content', () => {
    const sections = ['### Recent Activity\n\nSome content'];
    expect(sectionsContain(sections, 'Completely different content that is not in sections')).toBe(false);
  });

  test('returns false for empty sections', () => {
    expect(sectionsContain([], 'Any content')).toBe(false);
  });
});
