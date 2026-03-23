import { $ } from 'bun';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { config } from './config.ts';
import { getLogsForRun } from './db.ts';
import type { Run, Issue } from './types.ts';

export interface RunContext {
  agentLogs: string;
  gitDiff: string;
  designDoc: string;
}

interface GeminiSessionSummary {
  summary: string;
  decisions: string[];
  files: string[];
  blockers: string[];
  next: string[];
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

// ~900K tokens ≈ 3.6M chars. Leave headroom.
const MAX_CONTEXT_CHARS = 3_200_000;

export async function gatherRunContext(run: Run, issue: Issue, worktreePath: string): Promise<RunContext> {
  // Agent logs from DB (up to 5000 entries)
  const logs = getLogsForRun(run.id, 5000);
  const agentLogs = logs.map((l) => `[${l.stream}] ${l.content}`).join('\n');

  // Git diff from worktree (base branch vs HEAD)
  let gitDiff = '';
  try {
    const result = await $`git -C ${worktreePath} diff ${issue.baseBranch}...HEAD`.text();
    gitDiff = result;
  } catch {
    gitDiff = '[git diff unavailable]';
  }

  // Design doc from worktree
  let designDoc = '';
  if (issue.designPath) {
    try {
      designDoc = await Bun.file(join(worktreePath, issue.designPath)).text();
    } catch {
      designDoc = '[design doc not found]';
    }
  }

  return { agentLogs, gitDiff, designDoc };
}

export function truncateContext(context: RunContext): RunContext {
  const metadataReserve = 2000;
  const totalLen = context.designDoc.length + context.gitDiff.length + context.agentLogs.length;

  if (totalLen + metadataReserve <= MAX_CONTEXT_CHARS) return context;

  const budget = MAX_CONTEXT_CHARS - metadataReserve;

  // Priority: designDoc > gitDiff > agentLogs (truncate logs from beginning)
  const designDoc = context.designDoc.slice(0, Math.min(context.designDoc.length, budget));
  const afterDesign = budget - designDoc.length;

  const gitDiff = context.gitDiff.slice(0, Math.min(context.gitDiff.length, afterDesign));
  const afterDiff = afterDesign - gitDiff.length;

  // Keep the most recent logs (tail)
  const agentLogs = afterDiff > 0
    ? context.agentLogs.slice(-afterDiff)
    : '';

  return { agentLogs, gitDiff, designDoc };
}

async function callGemini(run: Run, issue: Issue, context: RunContext): Promise<GeminiSessionSummary> {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const prompt = `You are a technical documentation agent. Analyze the following completed coding agent run and produce a structured session summary.

## Run Metadata
- Issue: ${issue.key} — ${issue.title}
- Branch: ${run.branch}
- Status: ${run.status}
- Sessions: ${run.iterations}
- PR: ${run.pr_url ?? 'none'}
${run.error_summary ? `- Error: ${run.error_summary}` : ''}

## Design Document
${context.designDoc || '[none]'}

## Git Diff (base...HEAD)
${context.gitDiff || '[none]'}

## Agent Logs
${context.agentLogs || '[none]'}

---

Return a JSON object with these fields:
- "summary": 2-3 sentence summary of what happened in this run
- "decisions": array of key technical decisions made (empty array if none)
- "files": array of key files created or modified
- "blockers": array of open blockers or issues (empty array if none)
- "next": array of follow-up items or remaining work (empty array if none)

Return ONLY valid JSON, no markdown fences.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned empty response');

  const parsed = JSON.parse(text) as GeminiSessionSummary;

  // Basic validation
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.decisions)) {
    throw new Error('Gemini response missing required fields');
  }

  return parsed;
}

async function saveToObsidian(run: Run, issue: Issue, summary: GeminiSessionSummary): Promise<void> {
  const args = [
    'obsidian-memory', 'save-session',
    '--agent', 'claude-orchestrator',
    '--summary', `[${issue.key}] ${summary.summary}`,
  ];

  if (summary.decisions.length > 0) {
    args.push('--decisions', ...summary.decisions);
  }
  if (summary.files.length > 0) {
    args.push('--files', ...summary.files);
  }
  if (summary.blockers.length > 0) {
    args.push('--blockers', ...summary.blockers);
  }
  if (summary.next.length > 0) {
    args.push('--next', ...summary.next);
  }

  await $`${args}`.quiet();
  console.log(`[memory] Saved session summary for ${issue.key} (run ${run.id})`);

  // Generate project docs from codebase
  await $`obsidian-memory document`.quiet();
  console.log(`[memory] Generated project documentation for ${issue.key}`);
}

export async function documentRun(run: Run, issue: Issue, worktreePath: string): Promise<void> {
  if (!config.geminiApiKey) {
    console.log(`[memory] Skipping documentation — GEMINI_API_KEY not set`);
    return;
  }

  // Check obsidian-memory availability
  try {
    await $`which obsidian-memory`.quiet();
  } catch {
    console.log(`[memory] Skipping documentation — obsidian-memory CLI not found`);
    return;
  }

  const rawContext = await gatherRunContext(run, issue, worktreePath);
  const truncated = truncateContext(rawContext);
  const context = scrubRunContext(truncated);

  const summary = await callGemini(run, issue, context);
  await saveToObsidian(run, issue, summary);
}
