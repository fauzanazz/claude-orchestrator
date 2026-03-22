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

export const config = {
  projectsConfigPath: required.PROJECTS_CONFIG_PATH as string,
  githubWebhookSecret: required.GITHUB_WEBHOOK_SECRET as string,
  githubUsername: required.GITHUB_USERNAME as string,

  claudeCodePath: process.env.CLAUDE_CODE_PATH ?? 'claude',
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS ?? '2', 10),
  agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS ?? '1800000', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10),
  logFlushIntervalMs: parseInt(process.env.LOG_FLUSH_INTERVAL_MS ?? '5000', 10),
  reviewPollIntervalMs: parseInt(process.env.REVIEW_POLL_INTERVAL_MS ?? '120000', 10),
  reviewMinBodyLength: parseInt(process.env.REVIEW_MIN_BODY_LENGTH ?? '10', 10),
  reviewWatchMaxAgeDays: parseInt(process.env.REVIEW_WATCH_MAX_AGE_DAYS ?? '7', 10),
  port: parseInt(process.env.PORT ?? '7400', 10),

  tunnelName: process.env.TUNNEL_NAME,
  tunnelHostname: process.env.TUNNEL_HOSTNAME,

  notifyPollIntervalMs: parseInt(process.env.NOTIFY_POLL_INTERVAL_MS ?? '120000', 10),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  maxFixRetries: parseInt(process.env.MAX_FIX_RETRIES ?? '3', 10),
  fixPollIntervalMs: parseInt(process.env.FIX_POLL_INTERVAL_MS ?? '120000', 10),

  globalPromptPath: join(import.meta.dir, '..', 'global-prompt.md'),
};
