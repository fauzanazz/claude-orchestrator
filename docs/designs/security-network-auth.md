# Security: Network Hardening & API Authentication

## Context

Security audit findings MEDIUM-2 (tunnel guard spoofable header), MEDIUM-4 (no API authentication), MEDIUM-5 (unbounded SSE connections), and LOW-3 (error messages leak paths). This doc bundles these into a single network security hardening pass.

## Requirements

- Bind the HTTP server explicitly to `127.0.0.1` (not the default `0.0.0.0`)
- Add bearer token authentication for all API endpoints (excluding webhook, which uses HMAC)
- Cap the number of concurrent SSE connections
- Sanitize internal paths from API error responses
- Auth token generated on first run or read from `API_TOKEN` env var

## Implementation

### 1. Explicit localhost binding in `orchestrator/src/server.ts`

In `startServer()` (line 342), change the `Bun.serve` call:

```typescript
const server = Bun.serve({
  hostname: '127.0.0.1',  // Explicit — never bind to 0.0.0.0
  port: config.port,
  fetch: app.fetch,
});
```

### 2. Add API token configuration in `orchestrator/src/config.ts`

Add after line 44 (after `port`):

```typescript
apiToken: process.env.API_TOKEN ?? null,
maxSSEClients: parseIntEnv('MAX_SSE_CLIENTS', 10),
```

### 3. Generate token on startup if not configured

In `orchestrator/src/server.ts`, add a token initialization block before the Hono app creation (before line 93):

```typescript
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

let apiToken: string | null = config.apiToken;
if (!apiToken) {
  apiToken = randomBytes(32).toString('hex');
  const tokenPath = join(import.meta.dir, '..', '.api-token');
  writeFileSync(tokenPath, apiToken + '\n', { mode: 0o600 });
  console.log(`[server] Generated ephemeral API token → ${tokenPath}`);
  console.log(`[server] Set API_TOKEN env var to persist across restarts`);
}
```

The token is written to `orchestrator/.api-token` with `0600` permissions (owner-only read/write) instead of being logged to stdout, preventing credential leakage through process manager logs while keeping the token accessible to authorized users.

### 4. Add auth middleware in `orchestrator/src/server.ts`

Add a new middleware after the tunnel guard (after line 106):

```typescript
