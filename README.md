# Claude Orchestrator

A local, single-user system for planning and executing coding tasks with parallel Claude Code agents. The planner designs features and decomposes them into scoped issues; the orchestrator picks up those issues and runs autonomous coding agents in isolated git worktrees.

```
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│         Planner (fg)             │  │       Orchestrator (bg)          │
│                                  │  │                                  │
│  Claude Code + system prompt     │  │  Polls Linear for ready issues   │
│  Uses Obsidian CLI for context   │  │  Spawns agents in git worktrees  │
│  Uses lineark to create issues   │  │  Updates issues via lineark      │
│  Can cd into any project         │  │  Listens for GitHub PR reviews   │
│                                  │  │  Manages cloudflared tunnel      │
│                                  │  │  Status board at :7400           │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [lineark](https://github.com/lineark) CLI (Linear integration)
- [Obsidian](https://obsidian.md) + Obsidian CLI (for planner context)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (optional, for GitHub webhook delivery)

## Project Structure

```
planner/
├── PLANNER.md            # System prompt template
├── submit.sh             # Atomic: create branch → commit design → lineark create
├── projects.json         # Registry of local projects
├── skills/
│   └── design.md         # Skill: how to write a design doc
└── plan                  # Entry script — templates paths into prompt

orchestrator/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # Hono HTTP server + SSE + webhook handler
│   ├── runner.ts         # Agent lifecycle: poll → spawn → monitor → PR
│   ├── git.ts            # Worktree and PR management
│   ├── db.ts             # SQLite run/log persistence
│   ├── tunnel.ts         # Cloudflared tunnel management
│   ├── config.ts         # Environment config
│   ├── init.ts           # Worktree initialization
│   └── types.ts          # Shared type definitions
├── board/
│   └── index.html        # Live status dashboard
├── global-prompt.md      # Agent coding conventions
└── .env.example          # Configuration template
```

## Setup

### Orchestrator

```bash
cd orchestrator
cp .env.example .env     # Edit with your values
bun install
bun run dev              # Dev mode with hot reload
# or
bun run start            # Production
```

The status dashboard is available at `http://localhost:7400`.

### Planner

Install the `plan` command globally:

```bash
ln -s /path/to/planner/plan ~/.local/bin/plan
```

Then start a planning session:

```bash
plan "Add retry logic to the webhook handler"
```

## How It Works

1. **Plan** — The planner reads project context from Obsidian and the codebase, writes a scoped design doc, and submits it as a Linear issue in "Ready for Agent" state via `submit.sh`.

2. **Pick up** — The orchestrator polls Linear for issues in "Ready for Agent" state.

3. **Execute** — For each issue, it clones the agent branch into an isolated git worktree, injects the design doc and global prompt, and spawns a Claude Code agent.

4. **Ship** — When the agent finishes, the orchestrator pushes the branch and creates a GitHub PR.

5. **Review** — GitHub PR review webhooks (delivered via cloudflared tunnel) trigger the agent to address review feedback automatically.

## Configuration

Key environment variables (see `.env.example`):

| Variable | Description | Default |
|---|---|---|
| `MAX_CONCURRENT_AGENTS` | Parallel agent limit | `2` |
| `AGENT_TIMEOUT_MS` | Per-agent timeout | `1800000` (30m) |
| `POLL_INTERVAL_MS` | Linear polling interval | `30000` (30s) |
| `PORT` | Dashboard/webhook port | `7400` |
| `TUNNEL_NAME` | Cloudflared tunnel name | _(disabled)_ |

## Linear Setup

Create these custom states in your Linear team before first use:

- **Ready for Agent** — Planner puts issues here
- **In Progress** — Orchestrator picks them up
- **In Review** — PR created, awaiting review
- **Failed** — Agent errored or timed out
