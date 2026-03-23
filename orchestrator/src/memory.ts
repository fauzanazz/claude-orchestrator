import { $ } from 'bun';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

  const parsed = parseGeminiJson(text) as GeminiSessionSummary;

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

// ---------------------------------------------------------------------------
// Project documentation update (Features, Modules, Conventions, Architecture)
// ---------------------------------------------------------------------------

const DOC_FILES = ['Features.md', 'Modules.md', 'Architecture.md', 'Conventions.md'] as const;

interface ProjectDocsConfig {
  vaultPath: string;
  project: string;
}

function resolveDocsConfig(worktreePath: string): ProjectDocsConfig | null {
  // Try the worktree's .obsidian-memory.json first, then walk up from orchestrator/src to repo root
  for (const base of [worktreePath, join(import.meta.dir, '..', '..')]) {
    const configPath = join(base, '.obsidian-memory.json');
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (raw.vault && raw.project) {
          // Resolve vault path: check ~/Documents/{vault} (standard Obsidian location)
          const home = process.env.HOME ?? '~';
          const vaultPath = join(home, 'Documents', raw.vault);
          if (existsSync(vaultPath)) {
            return { vaultPath, project: raw.project };
          }
        }
      } catch {}
    }
  }
  return null;
}

function readExistingDocs(docsDir: string): Record<string, string> {
  const docs: Record<string, string> = {};
  for (const file of DOC_FILES) {
    const filePath = join(docsDir, file);
    if (existsSync(filePath)) {
      docs[file] = readFileSync(filePath, 'utf-8');
    }
  }
  return docs;
}

function parseGeminiJson(raw: string): unknown {
  // Strip markdown code fences Gemini sometimes wraps despite responseMimeType
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    // Log truncated response for debugging
    const preview = text.length > 500 ? text.slice(0, 250) + '\n...\n' + text.slice(-250) : text;
    console.error(`[memory] Gemini returned invalid JSON (${text.length} chars). Preview:\n${preview}`);
    throw e;
  }
}

async function callGeminiForDocs(
  run: Run,
  issue: Issue,
  context: RunContext,
  existingDocs: Record<string, string>,
): Promise<Record<string, string>> {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const docsSection = Object.entries(existingDocs)
    .map(([name, content]) => `### ${name}\n\`\`\`markdown\n${content}\n\`\`\``)
    .join('\n\n');

  const prompt = `You are a technical documentation agent. Your job is to UPDATE project documentation based on a completed coding agent run.

## Run Metadata
- Issue: ${issue.key} — ${issue.title}
- Branch: ${run.branch}
- Status: ${run.status}
- PR: ${run.pr_url ?? 'none'}
${run.error_summary ? `- Error: ${run.error_summary}` : ''}

## Design Document
${context.designDoc || '[none]'}

## Git Diff (base...HEAD)
${context.gitDiff || '[none]'}

## Current Documentation
${docsSection}

---

Update the documentation files with information from this run. Rules:
- PRESERVE all existing content — only ADD or UPDATE, never remove existing entries
- PRESERVE frontmatter (--- blocks) exactly as-is
- PRESERVE any <!-- obsidian-memory:auto-start/end --> blocks exactly as-is
- Replace <!-- Agent: ... --> placeholder comments with actual content
- For Features.md: add any new features to the table (Feature | Status | Module | Files | Description)
- For Modules.md: fill in <!-- purpose --> placeholders and add module details
- For Architecture.md: add system overview and key patterns if empty
- For Conventions.md: document patterns, naming, gotchas, and testing patterns observed in the code
- Keep content concise and factual — based only on what the diff and design doc show
- If a doc already has good content for a section, leave it unchanged
- Use wikilinks ([[PageName]]) for cross-references

Return a JSON object where keys are filenames (e.g. "Features.md") and values are the COMPLETE updated file content (including frontmatter). Only include files that actually changed.

Return ONLY valid JSON, no markdown fences.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 65536,
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini docs response truncated (hit output token limit)');
  }

  const text = response.text;
  if (!text) throw new Error('Gemini docs response empty');

  return parseGeminiJson(text) as Record<string, string>;
}

async function updateProjectDocs(
  run: Run,
  issue: Issue,
  context: RunContext,
  worktreePath: string,
): Promise<void> {
  const docsConfig = resolveDocsConfig(worktreePath);
  if (!docsConfig) {
    console.log(`[memory] Skipping docs update — no .obsidian-memory.json found`);
    return;
  }

  const docsDir = join(docsConfig.vaultPath, 'Memory', 'Projects', docsConfig.project, 'Docs');
  if (!existsSync(docsDir)) {
    console.log(`[memory] Skipping docs update — docs dir not found: ${docsDir}`);
    return;
  }

  const existingDocs = readExistingDocs(docsDir);
  if (Object.keys(existingDocs).length === 0) {
    console.log(`[memory] Skipping docs update — no existing doc files found`);
    return;
  }

  const updatedDocs = await callGeminiForDocs(run, issue, context, existingDocs);

  let updated = 0;
  for (const [filename, content] of Object.entries(updatedDocs)) {
    if (!DOC_FILES.includes(filename as typeof DOC_FILES[number])) continue;
    const filePath = join(docsDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    updated++;
  }

  if (updated > 0) {
    console.log(`[memory] Updated ${updated} doc(s) for ${issue.key}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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

  // Update project feature docs with info from this run
  try {
    await updateProjectDocs(run, issue, context, worktreePath);
  } catch (err) {
    console.error(`[memory] Failed to update project docs for ${issue.key}:`, err);
  }
}
