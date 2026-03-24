import { Hono } from 'hono';
import { join } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ulid } from 'ulid';
import type { SSEEvent, RunStatus } from './types.ts';
import { config } from './config.ts';
import {
  db, listRuns, getLogsForRun, getRun, getRunByBranch, insertRun,
  isReviewProcessed, markReviewProcessed,
  countQueuedForIssue, getLatestRunTimeForIssue, countTotalQueued,
  getAnalyticsOverview, getProjectStats, getDailyThroughput, getFailureBreakdown,
} from './db.ts';
import {
  onSSE,
  startRunner,
  enqueueRevision,
  enqueueWithIssue,
  reconstructIssueFromRun,
  loadProjects,
  beginShutdown,
  getRunningCount,
  flushAllLogs,
} from './runner.ts';
import { startTunnel, stopTunnel } from './tunnel.ts';

// ---------------------------------------------------------------------------
// GitHub webhook signature verification
// ---------------------------------------------------------------------------

async function verifyGitHubSignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected =
    'sha256=' +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const encoder = new TextEncoder();
  const sigBuf = encoder.encode(signature);
  const expectedBuf = encoder.encode(expected);
  if (sigBuf.byteLength !== expectedBuf.byteLength) {
    // Lengths differ — still perform a constant-time comparison against
    // expected to avoid leaking length information via timing.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(sigBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// SSE management
// ---------------------------------------------------------------------------

const sseClients: Set<ReadableStreamDefaultController> = new Set();

export function broadcastSSE(event: SSEEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const encoder = new TextEncoder();
  for (const controller of sseClients) {
    try {
      controller.enqueue(encoder.encode(data));
    } catch {
      // Client disconnected — remove from set
      sseClients.delete(controller);
    }
  }
}

// SSE heartbeat — keeps connections alive, lets clients detect dead connections
setInterval(() => {
  const heartbeat = new TextEncoder().encode(': heartbeat\n\n');
  for (const controller of sseClients) {
    try {
      controller.enqueue(heartbeat);
    } catch {
      sseClients.delete(controller);
    }
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const startTime = Date.now();

// ---------------------------------------------------------------------------
// API token — read from env or generate an ephemeral one on startup
// ---------------------------------------------------------------------------

let apiToken: string | null = config.apiToken;
if (!apiToken) {
  apiToken = randomBytes(32).toString('hex');
  const tokenPath = join(import.meta.dir, '..', '.api-token');
  try {
    writeFileSync(tokenPath, apiToken + '\n', { mode: 0o600 });
    console.log(`[server] Generated ephemeral API token → ${tokenPath}`);
  } catch (err) {
    console.warn(`[server] Could not write API token to ${tokenPath}: ${err}`);
    console.log(`[server] Ephemeral API token: ${apiToken}`);
  }
  console.log(`[server] Set API_TOKEN env var to persist across restarts`);
}

// ---------------------------------------------------------------------------
// Path sanitization helper — strip absolute paths from error messages
// ---------------------------------------------------------------------------

function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/\/[^\s:'"]+/g, (match) => {
    const parts = match.split('/');
    return parts.length > 2 ? `<path>/${parts[parts.length - 1]}` : match;
  });
}

export const app = new Hono();

// ---------------------------------------------------------------------------
// Tunnel guard — only /webhook/* is reachable through the Cloudflare tunnel.
// Everything else (dashboard, API, SSE) is localhost-only.
// Cloudflared injects `Cf-Connecting-Ip` on every proxied request.
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  if (c.req.header('cf-connecting-ip') && !c.req.path.startsWith('/webhook/')) {
    return c.text('Not Found', 404);
  }
  return next();
});

// ---------------------------------------------------------------------------
// Bearer token authentication — all endpoints except /webhook/*, /health,
// and localhost-only requests (no cf-connecting-ip = not from tunnel).
// The tunnel guard above already blocks non-webhook external access,
// so localhost requests (e.g. dashboard) can skip auth.
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/webhook/') || path === '/health' || path === '/') {
    return next();
  }

  // Localhost requests (not proxied through tunnel) skip auth —
  // the tunnel guard already ensures only /webhook/* is externally reachable.
  if (!c.req.header('cf-connecting-ip')) {
    return next();
  }

  const authHeader = c.req.header('authorization');
  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: 'Invalid Authorization header format' }, 401);
  }

  const token = match[1];
  const encoder = new TextEncoder();
  const tokenBuf = encoder.encode(token);
  const expectedBuf = encoder.encode(apiToken!);

  if (tokenBuf.byteLength !== expectedBuf.byteLength) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return c.json({ error: 'Invalid token' }, 403);
  }

  if (!timingSafeEqual(tokenBuf, expectedBuf)) {
    return c.json({ error: 'Invalid token' }, 403);
  }

  return next();
});

// GET /health — liveness/readiness probe (localhost-only via tunnel guard)
app.get('/health', (c) => {
  let dbStatus: 'ok' | 'error' = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }
  return c.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    db: dbStatus,
    maxRunRetries: config.maxRunRetries,
    maxFixRetries: config.maxFixRetries,
  });
});

// GET /api/projects — list project names with descriptions
app.get('/api/projects', (c) => {
  const projects = loadProjects();
  const result: Record<string, { repo: string; description?: string }> = {};
  for (const [key, proj] of Object.entries(projects)) {
    result[key] = { repo: proj.repo, description: proj.description };
  }
  return c.json(result);
});

// GET /api/runs — list runs with optional ?status=, ?project=, ?limit=, ?offset= params
app.get('/api/runs', (c) => {
  const status = c.req.query('status') as RunStatus | undefined;
  const project = c.req.query('project');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const runs = listRuns({ status, project, limit, offset });
  return c.json(runs);
});

// GET /api/runs/:id/logs — get logs for a run with optional ?limit= and ?offset= params
app.get('/api/runs/:id/logs', (c) => {
  const id = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '1000', 10) || 1000, 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const logs = getLogsForRun(id, limit, offset);
  return c.json(logs);
});

// POST /api/runs/:id/retry — re-enqueue a failed run
app.post('/api/runs/:id/retry', async (c) => {
  const id = c.req.param('id');
  const original = getRun(id);

  if (!original) {
    return c.json({ error: 'Run not found' }, 404);
  }

  if (original.status !== 'failed') {
    return c.json({ error: 'Only failed runs can be retried' }, 400);
  }

  // Rate limiting guards
  const totalQueued = countTotalQueued();
  if (totalQueued >= config.maxQueueSize) {
    return c.json(
      { error: `Queue full (${totalQueued}/${config.maxQueueSize}). Wait for runs to complete.` },
      429,
    );
  }

  const queuedForIssue = countQueuedForIssue(original.issue_id);
  if (queuedForIssue >= config.maxRetriesPerRun) {
    return c.json(
      { error: `Too many queued retries for this issue (${queuedForIssue}/${config.maxRetriesPerRun})` },
      429,
    );
  }

  const latestTime = getLatestRunTimeForIssue(original.issue_id, original.id);
  if (latestTime) {
    const elapsed = Date.now() - new Date(latestTime + 'Z').getTime();
    if (elapsed < config.retryCooldownMs) {
      const waitSec = Math.ceil((config.retryCooldownMs - elapsed) / 1000);
      return c.json(
        { error: `Retry cooldown: wait ${waitSec}s before retrying this run` },
        429,
      );
    }
  }

  let issue;
  try {
    issue = await reconstructIssueFromRun(original);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: sanitizeErrorMessage(msg) }, 500);
  }

  const newId = ulid();
  const newRun = {
    id: newId,
    project: original.project,
    issue_id: original.issue_id,
    issue_key: original.issue_key,
    issue_title: original.issue_title,
    branch: original.branch,
    worktree_path: original.worktree_path,
    status: 'queued' as RunStatus,
    is_revision: original.is_revision,
    is_fix: original.is_fix ?? 0,
    fix_type: original.fix_type ?? null,
    fix_attempt: original.fix_attempt ?? 0,
    retry_attempt: 0,
    pr_number: original.pr_number,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
    design_path: original.design_path ?? null,
    issue_repo: original.issue_repo ?? null,
    base_branch: original.base_branch ?? null,
  };

  insertRun(newRun);

  const fullRun = getRun(newId);
  if (fullRun) {
    enqueueWithIssue(fullRun, issue);
    broadcastSSE({ type: 'run_update', run: fullRun });
  }

  return c.json({ id: newId });
});

// GET /api/analytics/overview — aggregate stats
app.get('/api/analytics/overview', (c) => {
  const days = Math.min(Math.max(1, parseInt(c.req.query('days') ?? '30', 10) || 30), 365);
  return c.json(getAnalyticsOverview(days));
});

// GET /api/analytics/projects — per-project breakdown
app.get('/api/analytics/projects', (c) => {
  const days = Math.min(Math.max(1, parseInt(c.req.query('days') ?? '30', 10) || 30), 365);
  return c.json(getProjectStats(days));
});

// GET /api/analytics/throughput — daily run counts
app.get('/api/analytics/throughput', (c) => {
  const days = Math.min(Math.max(1, parseInt(c.req.query('days') ?? '30', 10) || 30), 365);
  return c.json(getDailyThroughput(days));
});

// GET /api/analytics/failures — failure cause breakdown
app.get('/api/analytics/failures', (c) => {
  const days = Math.min(Math.max(1, parseInt(c.req.query('days') ?? '30', 10) || 30), 365);
  const project = c.req.query('project');
  return c.json(getFailureBreakdown(days, project || undefined));
});

// GET /api/events — SSE endpoint (capped to config.maxSSEClients)
app.get('/api/events', (_c) => {
  if (sseClients.size >= config.maxSSEClients) {
    return new Response(JSON.stringify({ error: 'Too many SSE connections' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let ctrl: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      sseClients.add(controller);
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
    },
    cancel() {
      sseClients.delete(ctrl);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// POST /webhook/github — GitHub PR review webhook handler
app.post('/webhook/github', async (c) => {
  const body = await c.req.text();
  const signature = c.req.header('x-hub-signature-256') ?? null;
  const event = c.req.header('x-github-event');

  const valid = await verifyGitHubSignature(body, signature, config.githubWebhookSecret);
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  if (event !== 'pull_request_review') {
    return c.json({ ok: true, skipped: true });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const action = payload.action as string | undefined;
  const review = payload.review as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;

  if (action !== 'submitted' || !review) {
    return c.json({ ok: true, skipped: true });
  }

  const reviewState = ((review.state as string) ?? '').toLowerCase();
  const reviewBody = ((review.body as string) ?? '').trim();
  const reviewId = review.id as string | undefined;
  const reviewAuthor = (review.user as Record<string, unknown>)?.login as string | undefined;

  // Skip self-reviews to prevent loops
  if (reviewAuthor === config.githubUsername) {
    return c.json({ ok: true, skipped: true, reason: 'self-review' });
  }

  // Determine if this review is actionable
  const isActionable =
    reviewState === 'changes_requested' ||
    (reviewState === 'commented' && reviewBody.length >= config.reviewMinBodyLength);

  if (!isActionable) {
    return c.json({ ok: true, skipped: true, reason: 'not actionable' });
  }

  // Deduplicate
  if (reviewId && isReviewProcessed(reviewId)) {
    return c.json({ ok: true, skipped: true, reason: 'already processed' });
  }

  const head = pullRequest?.head as Record<string, unknown> | undefined;
  const branch = head?.ref as string | undefined;
  const prNumber = pullRequest?.number as number | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repo = repository?.full_name as string | undefined;

  if (!branch || !prNumber || !repo) {
    return c.json({ error: 'Missing pull_request.head.ref, number, or repository' }, 400);
  }

  const run = getRunByBranch(branch);
  if (!run) {
    return c.json({ error: `No run found for branch: ${branch}` }, 404);
  }

  // Reconstruct Issue data
  let issue;
  try {
    issue = await reconstructIssueFromRun(run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to reconstruct issue: ${sanitizeErrorMessage(msg)}` }, 500);
  }

  const revisionRunId = enqueueRevision(run, prNumber, issue);

  // Mark review as processed
  if (reviewId) {
    markReviewProcessed(reviewId, prNumber, repo, revisionRunId);
  }

  return c.json({ ok: true, revisionRunId });
});

// GET / — serve the status board HTML
app.get('/', (_c) => {
  const htmlPath = join(import.meta.dir, '..', 'board', 'index.html');
  const file = Bun.file(htmlPath);
  return new Response(file);
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export function startServer(): void {
  // Register broadcastSSE with the runner so it can emit SSE events
  onSSE(broadcastSSE);

  // Start the runner loop
  startRunner();

  // Start tunnel if configured
  startTunnel(config.port);

  // Start Hono HTTP server
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,
    fetch: app.fetch.bind(app),
  });

  console.log(`[server] Listening on http://localhost:${config.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[server] Shutting down gracefully...');
    beginShutdown();

    // Wait for running agents (max 60 seconds)
    const maxWait = 60_000;
    const start = Date.now();
    while (getRunningCount() > 0 && Date.now() - start < maxWait) {
      console.log(`[server] Waiting for ${getRunningCount()} running agent(s)...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    if (getRunningCount() > 0) {
      console.log(`[server] ${getRunningCount()} agent(s) still running after timeout — forcing exit`);
    }

    // Flush remaining logs
    flushAllLogs();

    // Stop tunnel
    stopTunnel();

    // Stop HTTP server
    server.stop();

    // Close database
    db.close();

    console.log('[server] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
