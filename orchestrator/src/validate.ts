import { normalize } from 'node:path';

/**
 * Validates a design path from issue metadata.
 * Must start with "docs/designs/", contain no ".." segments, and end with ".md".
 * Returns the validated path or throws an error.
 */
export function validateDesignPath(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed.endsWith('.md')) {
    throw new Error(`Invalid designPath: must end with .md — got "${trimmed}"`);
  }

  if (!trimmed.startsWith('docs/designs/')) {
    throw new Error(`Invalid designPath: must start with docs/designs/ — got "${trimmed}"`);
  }

  // Normalize to resolve any ".." or "." segments, then re-check prefix
  const normalized = normalize(trimmed);
  if (normalized.includes('..')) {
    throw new Error(`Invalid designPath: path traversal detected — got "${trimmed}"`);
  }

  if (!normalized.startsWith('docs/designs/')) {
    throw new Error(`Invalid designPath: after normalization, path escapes docs/designs/ — got "${trimmed}"`);
  }

  // Ensure no null bytes or other control characters
  if (/[\x00-\x1f]/.test(trimmed)) {
    throw new Error(`Invalid designPath: contains control characters — got "${trimmed}"`);
  }

  return normalized;
}

/**
 * Validates a branch name from issue metadata.
 * Must match a safe pattern: alphanumeric, hyphens, underscores, forward slashes, and dots.
 */
export function validateBranch(raw: string): string {
  const trimmed = raw.trim();

  if (!/^[\w./-]+$/.test(trimmed)) {
    throw new Error(`Invalid branch: contains disallowed characters — got "${trimmed}"`);
  }

  if (trimmed.includes('..')) {
    throw new Error(`Invalid branch: contains ".." — got "${trimmed}"`);
  }

  if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.lock')) {
    throw new Error(`Invalid branch: malformed branch name — got "${trimmed}"`);
  }

  return trimmed;
}

/**
 * Validates a repo identifier from issue metadata.
 * Must match org/repo pattern with safe characters only.
 */
export function validateRepo(raw: string): string {
  const trimmed = raw.trim();

  if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    throw new Error(`Invalid repo: must be "org/repo" format with safe characters — got "${trimmed}"`);
  }

  return trimmed;
}

/**
 * Validates an init command from project config.
 * Rejects shell metacharacters that could enable injection.
 */
const ALLOWED_INIT_COMMANDS = [
  'bun install',
  'npm ci',
  'npm install',
  'yarn install --frozen-lockfile',
  'pnpm install --frozen-lockfile',
];

export function validateInitCommand(cmd: string): string {
  const trimmed = cmd.trim();

  // Allow known safe commands verbatim
  if (ALLOWED_INIT_COMMANDS.includes(trimmed)) {
    return trimmed;
  }

  // For custom commands, reject shell metacharacters and control characters (including null bytes)
  if (/[\x00-\x1f]|[;&|`$(){}!#<>\\'"*?\[\]]/.test(trimmed)) {
    throw new Error(`Unsafe init command: contains shell metacharacters — got "${trimmed}"`);
  }

  return trimmed;
}

/**
 * Splits an init command string into args for direct spawn (no shell).
 * Only use with already-validated commands.
 */
export function splitCommand(cmd: string): string[] {
  return cmd.trim().split(/\s+/);
}
