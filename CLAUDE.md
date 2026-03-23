# Claude Orchestrator

A local, single-user system for planning and executing coding tasks using parallel Claude Code agents. A **Planner** (foreground) designs features; an **Orchestrator** (background daemon) executes them by spawning Claude agents per task.

## Tech Stack

- **Runtime**: Bun
- **Framework**: Hono (HTTP + SSE)
- **Database**: SQLite via `bun:sqlite`
- **Language**: TypeScript
- **External CLIs**: `lineark` (Linear), `gh` (GitHub), `cloudflared` (tunnel)

## Development Commands

All commands run from the `orchestrator/` directory.

```bash
bun install          # Install dependencies
bun run dev          # Start with hot reload (recommended for dev)
bun run start        # Start without hot reload
bun test             # Run tests
bunx tsc --noEmit    # Type check
```

Dashboard available at http://localhost:7400 when running.

## Architecture

Entry point: `orchestrator/src/index.ts` → `server.ts`

| Module        | Responsibility                                                         |
|---------------|------------------------------------------------------------------------|
| `server.ts`   | Hono HTTP server, SSE endpoint, webhook handler                        |
| `runner.ts`   | Agent lifecycle: poll Linear → spawn Claude agents → push → create PR  |
| `git.ts`      | Git worktree management, PR creation, rebase                           |
| `db.ts`       | SQLite persistence: runs, logs, reviews, fix tracking                  |
| `prompts.ts`  | Multi-session prompt building (initializer + coding continuation)      |
| `notify.ts`   | PR merge-readiness polling, Slack/macOS notifications                  |
| `tunnel.ts`   | Cloudflared tunnel lifecycle management                                |
| `init.ts`     | Worktree initialization (dependency install per branch)                |
| `config.ts`   | Environment variable configuration                                     |

## Conventions

- Each task runs in its own git worktree (isolated branch per Linear issue)
- Agent sessions are multi-turn: an initializer prompt sets context, continuation prompts drive coding
- The runner polls Linear for new issues and manages the full lifecycle autonomously
- All state (runs, logs, agent output) is persisted in `orchestrator/orchestrator.db`
- Use `plan "description"` CLI (requires symlink setup) to invoke the planner
