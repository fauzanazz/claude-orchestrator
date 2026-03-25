import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { ProjectConfig, ProjectsConfig } from './types.ts';

const required = {
  PROJECTS_CONFIG_PATH: process.env.PROJECTS_CONFIG_PATH,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  GITHUB_USERNAME: process.env.GITHUB_USERNAME,
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}`
  );
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid numeric value for ${name}: "${raw}"`);
  }
  return parseInt(raw, 10);
}

export const config = {
  projectsConfigPath: required.PROJECTS_CONFIG_PATH as string,
  githubWebhookSecret: required.GITHUB_WEBHOOK_SECRET as string,
  githubUsername: required.GITHUB_USERNAME as string,

  claudeCodePath: process.env.CLAUDE_CODE_PATH ?? 'claude',
  logLevel: (() => {
    const raw = process.env.LOG_LEVEL ?? 'info';
    const valid = ['debug', 'info', 'warn', 'error'] as const;
    if (!valid.includes(raw as typeof valid[number])) {
      throw new Error(`Invalid LOG_LEVEL: "${raw}" (must be one of: ${valid.join(', ')})`);
    }
    return raw as typeof valid[number];
  })(),
  defaultModel: process.env.DEFAULT_MODEL ?? null as string | null,
  defaultFixModel: process.env.DEFAULT_FIX_MODEL ?? null as string | null,
  maxConcurrentAgents: parseIntEnv('MAX_CONCURRENT_AGENTS', 2),
  agentTimeoutMs: parseIntEnv('AGENT_TIMEOUT_MS', 7200000),
  maxSessionIterations: parseIntEnv('MAX_SESSION_ITERATIONS', 10),
  sessionTimeoutMs: parseIntEnv('SESSION_TIMEOUT_MS', 1800000),
  autoContinueDelayMs: parseIntEnv('AUTO_CONTINUE_DELAY_MS', 3000),
  pollIntervalMs: parseIntEnv('POLL_INTERVAL_MS', 30000),
  logFlushIntervalMs: parseIntEnv('LOG_FLUSH_INTERVAL_MS', 5000),
  reviewPollIntervalMs: parseIntEnv('REVIEW_POLL_INTERVAL_MS', 120000),
  reviewMinBodyLength: parseIntEnv('REVIEW_MIN_BODY_LENGTH', 10),
  reviewWatchMaxAgeDays: parseIntEnv('REVIEW_WATCH_MAX_AGE_DAYS', 7),
  port: parseIntEnv('PORT', 7400),
  apiToken: process.env.API_TOKEN ?? null,
  maxSSEClients: parseIntEnv('MAX_SSE_CLIENTS', 10),
  maxQueueSize: parseIntEnv('MAX_QUEUE_SIZE', 20),
  maxRetriesPerRun: parseIntEnv('MAX_RETRIES_PER_RUN', 3),
  retryCooldownMs: parseIntEnv('RETRY_COOLDOWN_MS', 60000),

  tunnelName: process.env.TUNNEL_NAME,
  tunnelHostname: process.env.TUNNEL_HOSTNAME,

  notifyPollIntervalMs: parseIntEnv('NOTIFY_POLL_INTERVAL_MS', 120000),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  maxFixRetries: parseIntEnv('MAX_FIX_RETRIES', 3),
  maxRunRetries: parseIntEnv('MAX_RUN_RETRIES', 3),
  runRetryDelayMs: parseIntEnv('RUN_RETRY_DELAY_MS', 30000),
  fixPollIntervalMs: parseIntEnv('FIX_POLL_INTERVAL_MS', 120000),
  fixCooldownMs: parseIntEnv('FIX_COOLDOWN_MS', 300000),

  logRetentionDays: parseIntEnv('LOG_RETENTION_DAYS', 30),
  runRetentionDays: parseIntEnv('RUN_RETENTION_DAYS', 90),
  cleanupIntervalMs: parseIntEnv('CLEANUP_INTERVAL_MS', 86400000), // 24 hours
  maxSnapshots: parseIntEnv('MAX_DB_SNAPSHOTS', 5),

  globalPromptPath: join(import.meta.dir, '..', 'global-prompt.md'),

  // Memory agent (Gemini Flash 2 post-run documentation)
  geminiApiKey: process.env.GEMINI_API_KEY,
  memoryProject: process.env.MEMORY_PROJECT,

  // AI auto-review gate
  autoReview: process.env.AUTO_REVIEW === 'true',
  autoReviewModel: process.env.AUTO_REVIEW_MODEL ?? 'gemini-2.0-flash',
};

// ---------------------------------------------------------------------------
// Project resolution (moved from runner.ts to break import cycle)
// ---------------------------------------------------------------------------

let _projectsCache: ProjectsConfig | null = null;
let _projectsMtime: number = 0;

export function loadProjects(): ProjectsConfig {
  const stat = statSync(config.projectsConfigPath);
  const mtime = stat.mtimeMs;
  if (_projectsCache && mtime === _projectsMtime) {
    return _projectsCache;
  }
  const raw = readFileSync(config.projectsConfigPath, 'utf-8');
  _projectsCache = JSON.parse(raw) as ProjectsConfig;
  _projectsMtime = mtime;
  return _projectsCache;
}

export function resolveProject(
  repo: string,
): { key: string; project: ProjectConfig } | null {
  const projects = loadProjects();

  for (const [key, project] of Object.entries(projects)) {
    if (project.repo === repo) {
      return { key, project };
    }
  }

  return null;
}
