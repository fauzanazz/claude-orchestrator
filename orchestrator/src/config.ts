import { join } from 'path';

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

  tunnelName: process.env.TUNNEL_NAME,
  tunnelHostname: process.env.TUNNEL_HOSTNAME,

  notifyPollIntervalMs: parseInt(process.env.NOTIFY_POLL_INTERVAL_MS ?? '120000', 10),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  maxFixRetries: parseInt(process.env.MAX_FIX_RETRIES ?? '3', 10),
  maxRunRetries: parseIntEnv('MAX_RUN_RETRIES', 3),
  runRetryDelayMs: parseIntEnv('RUN_RETRY_DELAY_MS', 30000),
  fixPollIntervalMs: parseInt(process.env.FIX_POLL_INTERVAL_MS ?? '120000', 10),

  globalPromptPath: join(import.meta.dir, '..', 'global-prompt.md'),
};
