# Security: Scoped Agent Permissions

## Context

Security audit finding CRITICAL-1. Every spawned Claude agent runs with `--dangerously-skip-permissions` and `.claude/settings.json` grants `permissions: { allow: ['*'] }`. This means a malicious design doc or compromised Linear issue can achieve full system access — read SSH keys, install backdoors, exfiltrate secrets, etc.

Full containerization (Docker/nsjail) is the long-term solution but is out of scope for this doc. This doc implements the immediate mitigation: scoped permission allowlists per project.

## Requirements

- Add a `allowedTools` field to `ProjectConfig` in `projects.json` for per-project Claude Code permission scoping
- Generate `.claude/settings.json` in each worktree with a scoped allowlist instead of `['*']`
- Provide sensible defaults when `allowedTools` is not specified (safe subset)
- The `--dangerously-skip-permissions` flag remains (required for unattended operation) but the settings.json now restricts what tools are auto-approved

## Implementation

### 1. Update `ProjectConfig` type in `orchestrator/src/types.ts`

Add the `allowedTools` field to the `ProjectConfig` interface (after `description?: string` on line 14):

```typescript
export interface ProjectConfig {
  path?: string;
  repo: string;
  linearTeam: string;
  linearProfile?: string;
  baseBranch: string;
  init?: string[];
  description?: string;
  allowedTools?: string[];  // Claude Code tool/command patterns for settings.json allow list
}
```

### 2. Define default allowlist in `orchestrator/src/git.ts`

Replace the `AGENT_SETTINGS` constant (line 301-305) with a function:

```typescript
const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',

  'Write',
  'Edit',

  'Bash(git *)',
  'Bash(bun *)',
  'Bash(bunx *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(pnpm *)',
  'Bash(yarn *)',
  'Bash(tsc *)',
  'Bash(eslint *)',
  'Bash(prettier *)',
  'Bash(uv *)',
  'Bash(cargo *)',
  'Bash(go *)',
  'Bash(make *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(find *)',
  'Bash(ls *)',
  'Bash(mkdir *)',
  'Bash(cp *)',
  'Bash(mv *)',
  'Bash(rm *)',
  'Bash(touch *)',
  'Bash(echo *)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(sed *)',
  'Bash(awk *)',
  'Bash(sort *)',
  'Bash(uniq *)',
  'Bash(diff *)',
  'Bash(tree *)',
];

function buildAgentSettings(allowedTools?: string[]): object {
  const allow = allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  return {
    permissions: {
      allow,
      deny: [
        'Bash(curl *)',
        'Bash(wget *)',
        'Bash(ssh *)',
        'Bash(scp *)',
        'Bash(nc *)',
        'Bash(ncat *)',
        'Bash(netcat *)',
        'Bash(eval *)',
        'Bash(exec *)',
        'Bash(sudo *)',
        'Bash(su *)',
        'Bash(chmod 777 *)',
        'Bash(open *)',
        'Bash(osascript *)',
      ],
    },
  };
}
```

### 3. Update `writeAgentSettings` in `orchestrator/src/git.ts`

Change the function signature to accept an optional allowlist (line 310):

```typescript
export async function writeAgentSettings(
  worktreePath: string,
  allowedTools?: string[],
): Promise<void> {
  const settingsDir = join(worktreePath, '.claude');
  await mkdir(settingsDir, { recursive: true });

  const settings = buildAgentSettings(allowedTools);

  await Bun.write(
    join(settingsDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
}
```

### 4. Pass `allowedTools` from project config in `orchestrator/src/runner.ts`

In `executeRun()` (runner.ts, around line 535), update the `writeAgentSettings` call:

```typescript
await writeAgentSettings(worktreePath, project.allowedTools);
```

### 5. Update `projects.json` with per-project overrides (optional)

Projects that need additional tools can specify them:

```json
{
  "claude-orchestrator": {
    "path": "/Users/enjat/Github/claude-orchestrator",
    "repo": "fauzanazz/claude-orchestrator",
    "baseBranch": "main",
    "linearTeam": "FAU",
    "allowedTools": [
      "Bash(bun *)",
      "Bash(bunx *)",
      "Bash(git *)",
      "Bash(tsc *)"
    ]
  }
}
```

If `allowedTools` is omitted, the default allowlist is used. This preserves backward compatibility.

## Testing Strategy

- **Unit test**: Create `orchestrator/src/git.test.ts` (or add to existing)
  - `buildAgentSettings()` with no args → returns object with `DEFAULT_ALLOWED_TOOLS` in `permissions.allow`
  - `buildAgentSettings(['Bash(bun *)'])` → returns object with `['Bash(bun *)']` in `permissions.allow`
  - Both cases include the deny list
  - `writeAgentSettings(tmpDir)` → verify `.claude/settings.json` is created with correct content
  - `writeAgentSettings(tmpDir, ['Bash(git *)'])` → verify custom allowlist written

- **Integration test**: Start a run with a project that has `allowedTools` set. Verify the agent's `.claude/settings.json` in the worktree contains the scoped permissions (check file content after `writeAgentSettings` completes).

- **Manual verification**: After deploying, check that an agent run creates a `.claude/settings.json` without `['*']`.

## Out of Scope

- Container-based sandboxing (Docker, nsjail) — future work
- Network-level isolation for agents — future work
- Filesystem chroot/jail — future work
- Monitoring/alerting for permission violations — future work
