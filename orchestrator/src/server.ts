import { Hono } from 'hono';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { SSEEvent, RunStatus } from './types.ts';
import { config } from './config.ts';
import { listRuns, getLogsForRun, getRun, getRunByBranch, insertRun, isReviewProcessed, markReviewProcessed } from './db.ts';
import {
  onSSE,
  startRunner,
  enqueueRevision,
  enqueueWithIssue,
  reconstructIssueFromRun,
  loadProjects,
} from './runner.ts';
import { startTunnel } from './tunnel.ts';

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
  return signature === expected;
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

// GET /api/projects — list project names with descriptions
app.get('/api/projects', (c) => {
  const projects = loadProjects();
  const result: Record<string, { repo: string; description?: string }> = {};
  for (const [key, proj] of Object.entries(projects)) {
    result[key] = { repo: proj.repo, description: proj.description };
  }
  return c.json(result);
});

// GET /api/runs — list runs with optional ?status= and ?project= filters
app.get('/api/runs', (c) => {
  const status = c.req.query('status') as RunStatus | undefined;
  const project = c.req.query('project');
  const runs = listRuns({ status, project });
  return c.json(runs);
});

// GET /api/runs/:id/logs — get logs for a run
app.get('/api/runs/:id/logs', (c) => {
  const id = c.req.param('id');
  const logs = getLogsForRun(id);
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

  let issue;
  try {
    issue = await reconstructIssueFromRun(original);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
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
    pr_number: original.pr_number,
    agent_pid: null,
    iterations: 0,
    error_summary: null,
    pr_url: null,
  };

  insertRun(newRun);

  const fullRun = getRun(newId);
  if (fullRun) {
    enqueueWithIssue(fullRun, issue);
    broadcastSSE({ type: 'run_update', run: fullRun });
  }

  return c.json({ id: newId });
});

// GET /api/events — SSE endpoint
app.get('/api/events', (_c) => {
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
    return c.json({ error: `Failed to reconstruct issue: ${msg}` }, 500);
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
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  console.log(`[server] Listening on http://localhost:${config.port}`);
}
