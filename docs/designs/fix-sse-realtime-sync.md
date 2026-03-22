# Fix Web UI Real-Time SSE Sync

## Context

The orchestrator dashboard (`board/index.html`) uses Server-Sent Events (SSE) to display live
run updates. Currently, new queue entries and status transitions do not appear without a manual
page refresh. Four bugs in the SSE pipeline cause this:

1. No state reconciliation after SSE reconnect — missed events are permanently lost
2. No SSE heartbeat — connections silently die, frontend shows stale "Connected" state
3. Missing broadcast for queued→running transition in `executeRun`
4. ReadableStream `cancel` callback receives wrong parameter, leaking dead controllers

## Requirements

- New runs appear in the dashboard within seconds of being enqueued, without manual refresh
- Status transitions (queued → running → success/failed) update live via SSE
- If the SSE connection drops, the dashboard recovers automatically and shows current state
- The "Connected" indicator accurately reflects whether events are actually flowing
- No new API endpoints, no polling fallback, no SSE event ID replay

## Implementation

### Fix 1: SSE heartbeat (server.ts)

Add a 15-second heartbeat interval that sends an SSE comment to all connected clients. This
keeps connections alive through proxies/firewalls and lets the frontend detect dead connections.

**File**: `orchestrator/src/server.ts`

Add after the `broadcastSSE` function (after line 61):

```typescript
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
```

No config change needed — 15s is hardcoded (not user-facing behavior).

### Fix 2: Fix ReadableStream cancel callback (server.ts)

The `cancel` callback in the SSE endpoint receives the cancel `reason`, not the controller.
The controller must be captured from the `start` closure scope.

**File**: `orchestrator/src/server.ts`

Replace the SSE endpoint (lines 191–210) with:

```typescript
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
```

Key change: `ctrl` is captured in closure scope from `start()`, then used in `cancel()`.

### Fix 3: Broadcast queued→running transition (runner.ts)

**File**: `orchestrator/src/runner.ts`

In the `executeRun` function, after the status is updated to `'running'` (currently line 350),
add a broadcast:

```typescript
updateRunStatus(runId, 'running', { started_at: new Date().toISOString() });

// Broadcast the running transition to SSE clients
const runningRun = getRun(runId);
if (runningRun) broadcastSSE({ type: 'run_update', run: runningRun });
```

Insert these 3 lines immediately after the existing `updateRunStatus(runId, 'running', ...)` call
(around line 350). Also do the same after the second `updateRunStatus(runId, 'running', { agent_pid: ... })`
call (around line 411):

```typescript
updateRunStatus(runId, 'running', { agent_pid: agentProc.pid });

// Broadcast PID update
const pidRun = getRun(runId);
if (pidRun) broadcastSSE({ type: 'run_update', run: pidRun });
```

### Fix 4: Re-fetch runs after SSE reconnect (board/index.html)

**File**: `orchestrator/board/index.html`

In the `connectSSE()` function, modify the `open` event handler to re-fetch all runs after
reconnection. This ensures any events missed during the disconnect window are recovered.

Replace the `open` handler (around line 480–483):

```javascript
es.addEventListener('open', () => {
  setConnected(true);
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  // Re-fetch full state to recover any events missed during disconnect
  fetchRuns();
});
```

The change is adding `fetchRuns()` at the end. This is called on every SSE open, including the
initial connection (which is harmless — it races with the initial `fetchRuns()` call and both
calls to `upsertRun` are idempotent since they use `runs.set(run.id, run)` keyed by ID).

## Testing Strategy

### Manual testing steps (primary)

1. Start the orchestrator: `cd orchestrator && bun run src/index.ts`
2. Open `http://localhost:7400` in a browser
3. Open browser DevTools → Network tab, filter by EventStream
4. Verify the SSE connection shows `: connected` followed by `: heartbeat` every ~15s
5. Create a test Linear issue in "Ready for Agent" state with valid metadata
6. Verify the new run appears in the dashboard without refreshing
7. Verify the status changes from Queued → Running → Success/Failed live
8. Kill the server, wait 5s, restart — verify the dashboard reconnects and shows current state
9. In DevTools Console, run `sseSource.close()` to simulate a disconnect — verify it reconnects
   and re-fetches runs (check Network tab for a new `/api/runs` request)

### Verify heartbeat

In DevTools → Network → select the EventStream request → EventStream tab:
- Should see `: heartbeat` comments arriving every ~15s
- If no events arrive for >20s, the connection is dead

### Verify cancel cleanup

1. Open dashboard in two tabs
2. Close one tab
3. Check server logs — no errors when broadcasting next event
4. The closed tab's controller should be removed from `sseClients`

## Out of Scope

- SSE event IDs (`id:` field) and server-side replay buffer for missed events
- Periodic polling fallback as belt-and-suspenders
- Dashboard UI changes beyond the SSE fix (no new columns, filters, etc.)
- Changes to the Linear polling interval or webhook handling
