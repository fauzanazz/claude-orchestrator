import { Hono } from 'hono';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { SSEEvent, RunStatus } from './types.ts';
import { config } from './config.ts';
import { listRuns, getLogsForRun, getRun, getRunByBranch, insertRun } from './db.ts';
import {
  onSSE,
  startRunner,
  enqueueRevision,
  enqueueWithIssue,
  parseIssueMetadata,
  resolveProject,
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

  // Read the issue from Linear to reconstruct full Issue metadata
  const readProc = Bun.spawn(
    ['lineark', 'issues', 'read', original.issue_key, '--format', 'json'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [readOut, readExit] = await Promise.all([
    new Response(readProc.stdout).text(),
    readProc.exited,
  ]);

  if (readExit !== 0) {
    return c.json({ error: `Failed to read issue ${original.issue_key} from Linear` }, 500);
  }

  let linearIssue: Record<string, unknown>;
  try {
    linearIssue = JSON.parse(readOut);
  } catch {
    return c.json({ error: 'Failed to parse Linear issue' }, 500);
  }

  const meta = parseIssueMetadata((linearIssue.description as string) ?? '');
  if (!meta) {
    return c.json({ error: 'Could not parse issue metadata from description' }, 400);
  }

  const resolved = resolveProject(meta.repo);
  if (!resolved) {
    return c.json({ error: `Project not found for repo: ${meta.repo}` }, 400);
  }

  const issue = {
    id: linearIssue.id as string,
    key: original.issue_key,
    title: original.issue_title,
    description: linearIssue.description as string,
    designPath: meta.designPath,
    branch: meta.branch,
    repo: meta.repo,
    baseBranch: resolved.project.baseBranch,
  };

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
    pr_number: original.pr_number,
    agent_pid: null,
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
  const stream = new ReadableStream({
    start(controller) {
      sseClients.add(controller);
      // Send an initial comment to establish the connection
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
    },
    cancel(controller) {
      sseClients.delete(controller as ReadableStreamDefaultController);
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

  if (
    action !== 'submitted' ||
    !review ||
    (review.state as string | undefined) !== 'changes_requested'
  ) {
    return c.json({ ok: true, skipped: true });
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

  enqueueRevision(run, prNumber);

  return c.json({ ok: true });
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
