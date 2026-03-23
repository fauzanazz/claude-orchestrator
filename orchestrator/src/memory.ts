import type { Run, Issue } from './types.ts';

export interface RunContext {
  agentLogs: string;
  gitDiff: string;
  designDoc: string;
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(?:api[_-]?key|token|secret|password|passwd|credential)[\s]*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi, replacement: '[SECRET_REDACTED]' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[AWS_ACCESS_KEY_REDACTED]' },
  { pattern: /(?:aws)?[_-]?secret[_-]?(?:access)?[_-]?key[\s]*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, replacement: '[AWS_SECRET_REDACTED]' },
  { pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g, replacement: '[GITHUB_TOKEN_REDACTED]' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, replacement: 'Bearer [TOKEN_REDACTED]' },
  { pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/gi, replacement: '[CONNECTION_STRING_REDACTED]' },
  { pattern: /(?:eyJ|YWNj)[A-Za-z0-9+/=]{50,}/g, replacement: '[BASE64_BLOB_REDACTED]' },
  { pattern: /https:\/\/hooks\.slack\.com\/services\/[^\s'"]+/gi, replacement: '[SLACK_WEBHOOK_REDACTED]' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { pattern: /^[A-Z_]{3,}=(?!.*(?:\/\/|REDACTED)).{8,}$/gm, replacement: '[ENV_VAR_REDACTED]' },
];

export function scrubSensitiveData(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function scrubRunContext(context: RunContext): RunContext {
  return {
    agentLogs: scrubSensitiveData(context.agentLogs),
    gitDiff: scrubSensitiveData(context.gitDiff),
    designDoc: scrubSensitiveData(context.designDoc),
  };
}

export async function documentRun(run: Run, issue: Issue, worktreePath: string): Promise<void> {
  // TODO: Implement gatherRunContext() and truncateContext() when Gemini SDK is added.
  // The scrubbing pipeline is ready — when context gathering is implemented, use:
  //   const rawContext = await gatherRunContext(run, issue, worktreePath);
  //   const truncated = truncateContext(rawContext);
  //   const context = scrubRunContext(truncated);
  //   await sendToGemini(context);
  console.log(`[memory] documentRun called for run ${run.id} (${issue.key}) — Gemini integration pending`);
}
