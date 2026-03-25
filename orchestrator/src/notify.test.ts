import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  truncateForNotification,
  sanitizeForSlack,
  sendMacOSNotification,
} from './notify.ts';

// ---------------------------------------------------------------------------
// truncateForNotification
// ---------------------------------------------------------------------------

describe('truncateForNotification', () => {
  test('returns short text unchanged', () => {
    expect(truncateForNotification('hello', 100)).toBe('hello');
  });

  test('returns text at exact max length unchanged', () => {
    const text = 'a'.repeat(100);
    expect(truncateForNotification(text, 100)).toBe(text);
  });

  test('truncates long text with ellipsis', () => {
    const text = 'a'.repeat(200);
    const result = truncateForNotification(text, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });

  test('empty string returns empty', () => {
    expect(truncateForNotification('', 100)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// sanitizeForSlack
// ---------------------------------------------------------------------------

describe('sanitizeForSlack', () => {
  test('escapes ampersands', () => {
    expect(sanitizeForSlack('a & b')).toBe('a &amp; b');
  });

  test('escapes angle brackets', () => {
    expect(sanitizeForSlack('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  test('escapes all special chars together', () => {
    expect(sanitizeForSlack('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
  });

  test('neutralizes @everyone injection', () => {
    const result = sanitizeForSlack('<@everyone> look!');
    expect(result).toBe('&lt;@everyone&gt; look!');
  });

  test('returns plain text unchanged', () => {
    expect(sanitizeForSlack('normal text')).toBe('normal text');
  });
});

// ---------------------------------------------------------------------------
// sendMacOSNotification — argument safety
// ---------------------------------------------------------------------------

describe('sendMacOSNotification', () => {
  let spawnCalls: Array<[string[], Record<string, unknown>]>;
  const originalSpawn = Bun.spawn;
  const originalSpawnSync = Bun.spawnSync;

  beforeEach(() => {
    spawnCalls = [];
    // @ts-expect-error — mock override
    Bun.spawn = (args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push([args, opts]);
      return { exitCode: 0, stdout: null, stderr: null, exited: Promise.resolve(0) };
    };
    // Mock spawnSync so terminal-notifier is "not found" → osascript fallback
    // @ts-expect-error — mock override
    Bun.spawnSync = () => ({ exitCode: 1, stdout: null, stderr: null });
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    Bun.spawnSync = originalSpawnSync;
  });

  test('escapes double quotes in title and body', () => {
    sendMacOSNotification('title with "quotes"', 'body "here"', 'https://github.com/o/r/pull/1');
    const osascriptCall = spawnCalls.find(([args]) => args[0] === 'osascript');
    expect(osascriptCall).toBeDefined();
    const script = osascriptCall![0][2];
    expect(script).toContain('title with \\"quotes\\"');
    expect(script).toContain('body \\"here\\"');
  });

  test('escapes backslashes before quotes', () => {
    sendMacOSNotification('back\\slash', 'body\\test', 'https://github.com/o/r/pull/1');
    const osascriptCall = spawnCalls.find(([args]) => args[0] === 'osascript');
    const script = osascriptCall![0][2];
    expect(script).toContain('back\\\\slash');
    expect(script).toContain('body\\\\test');
  });

  test('does not execute $() subshell injection', () => {
    sendMacOSNotification('$(whoami)', '$(id)', 'https://github.com/o/r/pull/1');
    const osascriptCall = spawnCalls.find(([args]) => args[0] === 'osascript');
    expect(osascriptCall).toBeDefined();
    // The args array approach means $() is a literal string to osascript, not shell-interpreted
    const script = osascriptCall![0][2];
    expect(script).toContain('$(whoami)');
    expect(script).toContain('$(id)');
  });

  test('does not execute backtick injection', () => {
    sendMacOSNotification('`whoami`', 'body', 'https://github.com/o/r/pull/1');
    const osascriptCall = spawnCalls.find(([args]) => args[0] === 'osascript');
    const script = osascriptCall![0][2];
    expect(script).toContain('`whoami`');
  });

  test('opens valid GitHub PR URL', () => {
    sendMacOSNotification('title', 'body', 'https://github.com/owner/repo/pull/1');
    const openCall = spawnCalls.find(([args]) => args[0] === 'open');
    expect(openCall).toBeDefined();
    expect(openCall![0][1]).toBe('https://github.com/owner/repo/pull/1');
  });

  test('rejects javascript: URL scheme', () => {
    sendMacOSNotification('title', 'body', 'javascript:alert(1)');
    const openCall = spawnCalls.find(([args]) => args[0] === 'open');
    expect(openCall).toBeUndefined();
  });

  test('rejects non-GitHub URL', () => {
    sendMacOSNotification('title', 'body', 'https://evil.com/malware');
    const openCall = spawnCalls.find(([args]) => args[0] === 'open');
    expect(openCall).toBeUndefined();
  });

  test('rejects GitHub URL with extra path segments', () => {
    sendMacOSNotification('title', 'body', 'https://github.com/owner/repo/pull/1/files');
    const openCall = spawnCalls.find(([args]) => args[0] === 'open');
    expect(openCall).toBeUndefined();
  });

  test('truncates long title', () => {
    const longTitle = 'a'.repeat(200);
    sendMacOSNotification(longTitle, 'body', 'https://github.com/o/r/pull/1');
    const osascriptCall = spawnCalls.find(([args]) => args[0] === 'osascript');
    const script = osascriptCall![0][2];
    // Title should be truncated to 100 chars (97 + '...')
    expect(script).toContain('a'.repeat(97) + '...');
  });

  test('truncates long body', () => {
    const longBody = 'b'.repeat(300);
    sendMacOSNotification('title', longBody, 'https://github.com/o/r/pull/1');
    const osascriptCall = spawnCalls.find(([args]) => args[0] === 'osascript');
    const script = osascriptCall![0][2];
    // Body should be truncated to 200 chars (197 + '...')
    expect(script).toContain('b'.repeat(197) + '...');
  });
});
