import { config } from './config.ts';

let tunnelProc: import('bun').Subprocess | null = null;

export async function startTunnel(port: number): Promise<void> {
  const tunnelName = config.tunnelName;

  if (!tunnelName) {
    console.log('[tunnel] TUNNEL_NAME not configured — tunnel disabled');
    return;
  }

  const which = Bun.spawnSync(['which', 'cloudflared']);
  if (which.exitCode !== 0) {
    console.warn(
      '[tunnel] cloudflared not found — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
    );
    return;
  }

  console.log(`[tunnel] Starting cloudflared tunnel "${tunnelName}" → http://localhost:${port}`);

  tunnelProc = Bun.spawn(
    ['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`, 'run', tunnelName],
    { stderr: 'pipe' }
  );

  // Read stderr in background and log tunnel connection events
  (async () => {
    const proc = tunnelProc;
    if (!proc || !proc.stderr) return;

    const decoder = new TextDecoder();
    const stderr = proc.stderr;
    if (typeof stderr === 'number') return;
    const reader = stderr.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const line = decoder.decode(value, { stream: true }).trim();
        if (!line) continue;

        if (line.includes('Registered tunnel connection')) {
          const hostname = config.tunnelHostname ?? tunnelName;
          console.log(`[tunnel] Connected — reachable at https://${hostname}`);
        }
      }
    } catch {
      // Process exited; nothing to do
    }
  })();
}

export function stopTunnel(): void {
  if (tunnelProc) {
    tunnelProc.kill();
    tunnelProc = null;
    console.log('[tunnel] Stopped cloudflared tunnel');
  }
}

