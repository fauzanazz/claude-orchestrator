# Agent Orchestrator + Planner Design (v2)

## The Two Processes

```
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│         Planner (fg)             │  │       Orchestrator (bg)          │
│                                  │  │                                  │
│  Claude Code + system prompt     │  │  Polls lineark for ready issues  │
│  Uses obsidian CLI for context   │  │  Spawns agents in git worktrees  │
│  Uses lineark to create issues   │  │  Updates issues via lineark     │
│  Can cd into any project         │  │  Listens for GitHub PR reviews   │
│                                  │  │  Manages cloudflared tunnel      │
│                                  │  │  Status board at :7400          │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

**Planner** — Claude Code with a system prompt. No custom MCP tools needed. Claude Code already has bash — it calls `obsidian` and `lineark` CLIs directly. A `submit` shell script handles branch creation, design doc commit, and Linear issue creation atomically with retry.

**Orchestrator** — Bun daemon. Polls `lineark` for issues in "Ready" state. Spawns coding agents in isolated git worktrees with scoped permissions. Listens for GitHub PR review webhooks to handle the review→changes cycle. Updates issue state via `lineark`. Auto-starts a `cloudflared` tunnel for webhook delivery.

### Known Gotchas

- **Obsidian CLI requires Obsidian to be running.** It's a remote control, not a headless tool. If Obsidian isn't open, the first CLI call auto-launches it. Keep Obsidian open during planning sessions.
- **This system is single-user, local-only.** No multi-team routing, no auth on the status board. One person, one machine.
- **Linear states must be configured.** Each Linear team needs these custom states: "Ready for Agent", "In Progress", "In Review", "Failed". These are not default Linear states — create them before first use.

---

## Planner

### What It Is

Not a custom tool. Just Claude Code configured for planning.

The planner is: **a system prompt + a shell script + a project registry.** Claude Code does the rest natively via bash.

### Architecture

```
planner/
├── PLANNER.md            # System prompt template
├── submit.sh             # Atomic: create branch → commit design → lineark create
├── projects.json         # Registry of local projects
├── skills/
│   └── design.md         # Skill: how to write a design doc
└── plan                  # Entry script — templates paths into prompt
```

### Entry Script (plan)

```bash
#!/usr/bin/env bash
PLANNER_DIR="$(dirname "$(realpath "$0")")"

# Template paths into system prompt
PROMPT=$(sed \
  -e "s|\\\$PLANNER_DIR|$PLANNER_DIR|g" \
  -e "s|\\\$PROJECTS_JSON|$PLANNER_DIR/projects.json|g" \
  "$PLANNER_DIR/PLANNER.md")

# Inline the design skill
SKILL=$(cat "$PLANNER_DIR/skills/design.md")
PROMPT="${PROMPT//<DESIGN_SKILL>/$SKILL}"

exec claude --system-prompt "$PROMPT" "$@"
```

Install globally: `ln -s /path/to/planner/plan ~/.local/bin/plan`

### System Prompt (PLANNER.md)

```markdown
You are a software architect and planner. You design features and
write implementation plans. You do NOT write implementation code.

## Your tools (all via bash)

### Obsidian — your knowledge base
Note: Obsidian must be running for CLI commands to work.

- `obsidian search query="keyword" format=json` — search vault
- `obsidian search query="keyword" format=json vault="VaultName"` — specific vault
- `obsidian read file="path/to/note.md"` — read a note
- `obsidian files sort=modified limit=10 format=json` — recent notes
- `obsidian tags counts` — see all tags

Pull context from Obsidian before designing. Your notes have
architecture decisions, conventions, and past designs.

### lineark — task management
- `lineark usage` — full CLI reference (under 1000 tokens)
- `lineark issues list --state "Ready for Agent"` — check agent queue
- `lineark issues search "auth" -l 5` — find related issues
- `lineark issues list --mine` — your issues

Run `lineark usage` on first use to learn the exact output schema
and available flags before relying on specific field names.

### Projects
Read the project registry:
  cat $PROJECTS_JSON

To work with a project, cd into it and explore:
  cd /home/belle/projects/legalipro
  tree src/middleware
  cat README.md

### Submitting a design
When a design is ready, use the submit script:
  cat <<'EOF' | $PLANNER_DIR/submit.sh <project-key> <slug> <title> [priority]
  <design doc content from stdin>
  EOF

This atomically:
1. Creates branch agent/{slug} from latest main (in a temp worktree — safe if you have dirty state)
2. Writes the design doc to docs/designs/{slug}.md on that branch
3. Pushes the branch
4. Creates a Linear issue in "Ready for Agent" state
All steps retry with exponential backoff. If a step fails after
retries, earlier steps are rolled back.

### Detecting base branch
By default, submit.sh targets `main`. If a project uses a different
default branch (e.g. `master`, `develop`), it reads the `baseBranch`
field from projects.json. If the base branch doesn't exist on remote,
the script will error and ask you to verify.

## How to write a design doc
<DESIGN_SKILL>

## Rules
- Pull context from Obsidian before designing.
- cd into the project and read code before designing.
- One design doc = one issue = ~30 min of coding work.
- Be specific: file paths, function signatures, data shapes.
  The coding agent reads your doc cold with no other context.
- You can work across multiple projects in one session.
- Run `lineark usage` on first use to learn the full CLI.
- Run `obsidian help` on first use to learn vault commands.
```

### Submit Script (submit.sh)

Design docs live on the agent branch, not main. The flow:
1. Create a temporary worktree from latest base branch (never touches your working tree)
2. Write + commit the design doc on branch `agent/{slug}`
3. Push the branch
4. Remove the temporary worktree
5. Create Linear issue

If any step fails after retries, all previous steps are rolled back.

```bash
#!/usr/bin/env bash
set -euo pipefail

PLANNER_DIR="$(dirname "$(realpath "$0")")"
PROJECTS="$PLANNER_DIR/projects.json"

PROJECT_KEY="$1"
SLUG="$2"
TITLE="$3"
PRIORITY="${4:-3}"

# --- Resolve project config ---
PROJECT_PATH=$(jq -r --arg k "$PROJECT_KEY" '.[$k].path' "$PROJECTS")
TEAM=$(jq -r --arg k "$PROJECT_KEY" '.[$k].linearTeam' "$PROJECTS")
PROFILE=$(jq -r --arg k "$PROJECT_KEY" '.[$k].linearProfile // empty' "$PROJECTS")
BASE_BRANCH=$(jq -r --arg k "$PROJECT_KEY" '.[$k].baseBranch // "main"' "$PROJECTS")
REPO=$(jq -r --arg k "$PROJECT_KEY" '.[$k].repo' "$PROJECTS")

if [ "$PROJECT_PATH" = "null" ]; then
  echo "Error: project '$PROJECT_KEY' not found in projects.json" >&2
  exit 1
fi

cd "$PROJECT_PATH"

# --- Verify base branch exists ---
if ! git ls-remote --heads origin "$BASE_BRANCH" | grep -q "$BASE_BRANCH"; then
  echo "Error: base branch '$BASE_BRANCH' not found on remote for $PROJECT_KEY." >&2
  echo "Available branches:" >&2
  git ls-remote --heads origin | awk '{print "  " $2}' | sed 's|refs/heads/||' >&2
  echo "Update 'baseBranch' in projects.json and retry." >&2
  exit 1
fi

BRANCH="agent/${SLUG}"
DESIGN_PATH="docs/designs/${SLUG}.md"
DESIGN_CONTENT=$(cat)  # read from stdin

# --- Retry helper ---
retry() {
  local max_attempts=3
  local delay=2
  local attempt=1
  while [ $attempt -le $max_attempts ]; do
    if "$@"; then return 0; fi
    echo "Attempt $attempt/$max_attempts failed. Retrying in ${delay}s..." >&2
    sleep $delay
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
  return 1
}

# --- Rollback state tracking ---
WORKTREE_PATH=""
BRANCH_CREATED=false
PUSHED=false

rollback() {
  echo "Rolling back..." >&2
  if [ "$PUSHED" = true ]; then
    git push origin --delete "$BRANCH" 2>/dev/null || true
  fi
  if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
    git worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true
  fi
  if [ "$BRANCH_CREATED" = true ]; then
    git branch -D "$BRANCH" 2>/dev/null || true
  fi
  exit 1
}

# --- Step 1: Fetch latest base branch ---
retry git fetch origin "$BASE_BRANCH" || { echo "Error: failed to fetch $BASE_BRANCH" >&2; exit 1; }

# --- Step 2: Create temporary worktree on new branch (never touches working tree) ---
WORKTREE_PATH="${PROJECT_PATH}/.worktrees/submit-${SLUG}"
git worktree add -b "$BRANCH" "$WORKTREE_PATH" "origin/$BASE_BRANCH" || {
  echo "Error: failed to create worktree for $BRANCH" >&2; exit 1;
}
BRANCH_CREATED=true

# --- Step 3: Write + commit design doc in worktree ---
mkdir -p "$(dirname "${WORKTREE_PATH}/${DESIGN_PATH}")"
echo "$DESIGN_CONTENT" > "${WORKTREE_PATH}/${DESIGN_PATH}"
git -C "$WORKTREE_PATH" add "$DESIGN_PATH"
git -C "$WORKTREE_PATH" commit -m "docs: design for ${SLUG}" || { rollback; }

# --- Step 4: Push branch ---
retry git -C "$WORKTREE_PATH" push -u origin "$BRANCH" || {
  echo "Error: failed to push $BRANCH" >&2; rollback;
}
PUSHED=true

# --- Step 5: Remove temporary worktree (branch stays) ---
git worktree remove "$WORKTREE_PATH" 2>/dev/null || true
WORKTREE_PATH=""

# --- Step 6: Create Linear issue ---
PROFILE_FLAG=""
[ -n "$PROFILE" ] && PROFILE_FLAG="--profile $PROFILE"

DESCRIPTION="design: ${DESIGN_PATH}
branch: ${BRANCH}
repo: ${REPO}"

ISSUE_KEY=$(retry lineark issues create "$TITLE" \
  --team "$TEAM" \
  -p "$PRIORITY" \
  -s "Ready for Agent" \
  --description "$DESCRIPTION" \
  --format json \
  $PROFILE_FLAG | jq -r '.identifier') || {
    echo "Error: failed to create Linear issue after retries" >&2
    echo "Branch $BRANCH was pushed. Create the issue manually or re-run." >&2
    exit 1
  }

echo "✓ Branch created: ${BRANCH}"
echo "✓ Design committed: ${DESIGN_PATH}"
echo "✓ Issue created: ${ISSUE_KEY} (Ready for Agent)"
```

**Why submit.sh uses a temporary worktree:**
- **Never touches your working tree** — safe even with uncommitted changes or a detached HEAD
- No stash/restore dance, no risk of losing work
- Worktree is removed after push — zero disk footprint
- Same mechanism the orchestrator uses, so the pattern is consistent

**Why design docs live on the agent branch, not main:**
- No push-to-main required (works with branch protection)
- Design doc travels with the code — review both in the same PR
- If the agent fails and you abandon the issue, no orphan doc on main
- Worktree created from the branch already has the design doc

### Project Registry (projects.json)

```json
{
  "legalipro": {
    "path": "/home/belle/projects/legalipro",
    "repo": "belle/legalipro",
    "linearTeam": "ENG",
    "linearProfile": "legali",
    "baseBranch": "main",
    "init": ["bun install", "cp .env.example .env"],
    "description": "AI-powered legal intelligence platform"
  },
  "lea": {
    "path": "/home/belle/projects/lea",
    "repo": "belle/lea-app",
    "linearTeam": "LEA",
    "linearProfile": "legali",
    "baseBranch": "main",
    "description": "Domestic violence survivor support app"
  },
  "claude-remote": {
    "repo": "belle/claude-remote",
    "linearTeam": "PERSONAL",
    "baseBranch": "main",
    "description": "Self-hosted PWA for Claude Code CLI"
  }
}
```

**Field reference:**

| Field | Required | Purpose |
|---|---|---|
| `repo` | Yes | GitHub `owner/repo`. Used for PR creation. If `path` is absent, orchestrator clones from this. |
| `path` | No | Absolute local path. If absent, orchestrator clones `repo` into `~/.local/share/agent-orchestrator/repos/{key}`. |
| `baseBranch` | Yes | Branch to fork agent branches from. Verified at startup. |
| `linearTeam` | Yes | Linear team identifier for issue creation. |
| `linearProfile` | No | lineark auth profile (multi-workspace support). |
| `init` | No | Commands to run in a fresh worktree before the agent starts. If absent, auto-detect from lockfile. |
| `description` | No | Human-readable, used in status board. |

**Project resolution from issue:** The issue description contains `repo: belle/legalipro`. The orchestrator matches this against `projects.json` entries by `repo` field (unique key). This avoids ambiguity when multiple projects share a Linear team.

### Example Session

```
$ plan

You: I need to add rate limiting to the legalipro API.
     Check my obsidian notes, I think I researched this.

Claude: $ obsidian search query="rate limiting" format=json
  Found 2 results: engineering/rate-limiting-research.md, projects/legalipro/api-decisions.md

Claude: $ obsidian read file="engineering/rate-limiting-research.md"
  Your notes say: token bucket, Redis-backed, 100 req/min per user...

Claude: $ cd /home/belle/projects/legalipro && tree src/middleware
  src/middleware/
  ├── auth.ts
  ├── cors.ts
  └── logging.ts

Claude: $ cat src/middleware/auth.ts
  Reading existing middleware pattern...

Claude: $ lineark issues search "rate limit" -l 5 --team ENG
  No existing issues found.

Claude: Here's my proposed design: [design doc]

You: Check what we decided about response headers in the API conventions.

Claude: $ obsidian search query="API conventions legalipro" format=json
Claude: $ obsidian read file="projects/legalipro/api-conventions.md"
  Conventions say: include X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset

Claude: Updated the design with proper headers.

You: Ship it.

Claude: $ cat <<'EOF' | /home/belle/.config/planner/submit.sh legalipro rate-limit-middleware "Add token bucket rate limiting" 2
  [full design doc]
  EOF

  ✓ Branch created: agent/rate-limit-middleware
  ✓ Design committed: docs/designs/rate-limit-middleware.md
  ✓ Issue created: ENG-57 (Ready for Agent)

You: Now switch to claude-remote, I need to add...
```

---

## Orchestrator

### What It Does

1. Polls Linear via `lineark` for issues in "Ready for Agent" state
2. Creates worktree from the agent branch (which already has the design doc)
3. Runs environment init (install dependencies)
4. Writes a scoped `.claude/settings.json` into the worktree with granular permissions
5. Builds a hierarchical prompt: global → project (`CLAUDE.md`) → local (design doc)
6. Spawns Claude Code (no `--dangerously-skip-permissions` — permissions come from settings file)
7. On success: pushes, creates PR (auto-assigns you as reviewer), updates Linear
8. On timeout (30 min): kills the agent, marks failed
9. Listens for GitHub PR review webhooks — if changes requested, queues a revision run that uses `gh` CLI to read the full review

### Architecture

```
orchestrator/
├── src/
│   ├── server.ts    # Hono: status API + SSE + board + GitHub webhook
│   ├── runner.ts    # Poll lineark, spawn agents, manage queue
│   ├── git.ts       # Worktree lifecycle, branch ops, PR creation
│   ├── init.ts      # Per-project environment setup (install deps, etc.)
│   ├── tunnel.ts    # cloudflared lifecycle management
│   ├── db.ts        # SQLite: runs + logs
│   ├── config.ts    # Env validation
│   └── types.ts     # Shared types
├── board/
│   └── index.html   # Status board: vanilla HTML + SSE
├── global-prompt.md # Global agent instructions (conventions, commit style)
├── package.json
└── .env
```

Eight source files. `tunnel.ts` manages the `cloudflared` tunnel process. `global-prompt.md` is the base layer of the agent prompt hierarchy.

### Agent Prompt Hierarchy

The agent receives a composed prompt built from three layers, most general to most specific:

```
┌─────────────────────────────────────┐
│  1. Global Prompt (global-prompt.md)│  Shared across all projects.
│     Commit conventions, code style, │  Lives in orchestrator/.
│     general rules, test discipline  │
├─────────────────────────────────────┤
│  2. Project Prompt (CLAUDE.md)      │  Per-project conventions.
│     Tech stack, lint/test commands, │  Lives in project repo root.
│     architecture patterns           │  Read from worktree if present.
├─────────────────────────────────────┤
│  3. Local Prompt (design doc)       │  This specific task.
│     Issue details, file paths,      │  Written by planner, committed
│     function signatures, data shapes│  to agent branch.
└─────────────────────────────────────┘
```

**Composition in runner.ts:**

```typescript
const buildAgentPrompt = async (
  issue: Issue,
  worktreePath: string,
  globalPromptPath: string,
  reviewFeedback?: string
): Promise<string> => {
  const globalPrompt = await Bun.file(globalPromptPath).text();

  const claudeMdPath = join(worktreePath, 'CLAUDE.md');
  const projectPrompt = await Bun.file(claudeMdPath).exists()
    ? await Bun.file(claudeMdPath).text()
    : '';

  const designDocPath = join(worktreePath, issue.designPath);
  const designDoc = await Bun.file(designDocPath).text();

  const sections = [
    globalPrompt,
    projectPrompt && `## Project Conventions\n${projectPrompt}`,
    `## Issue: ${issue.key} — ${issue.title}\n\n${issue.description}`,
    `## Design Document\n${designDoc}`,
    reviewFeedback && `## Review Feedback (address ALL of these)\n${reviewFeedback}`,
    buildRulesSection(issue, !!reviewFeedback),
  ].filter(Boolean);

  return sections.join('\n\n---\n\n');
};

const buildRulesSection = (issue: Issue, isRevision: boolean): string => `
## Rules
- You are in an isolated worktree on branch: ${issue.branch}
- Dependencies are already installed
- Run tests before finishing
- Commit with conventional commits referencing ${issue.key}
- Do not modify files outside the scope of this issue
- Do NOT create or switch branches — you're already on the right one
${isRevision ? `- Address every review comment
- Do NOT force-push or rewrite history` : ''}
`;
```

If a project has no `CLAUDE.md`, the layer is simply skipped — no empty section injected.

### Agent Permissions

Instead of `--dangerously-skip-permissions`, each agent worktree gets a scoped `.claude/settings.json` written before spawn:

```typescript
const AGENT_PERMISSIONS = {
  permissions: {
    allow: [
      // Read-only file inspection
      "Bash(cat:*)", "Bash(ls:*)", "Bash(head:*)", "Bash(tail:*)",
      "Bash(wc:*)", "Bash(sort:*)", "Bash(grep:*)", "Bash(tr:*)",
      "Bash(find:*)", "Bash(tree:*)",
      // Safe utilities
      "Bash(date:*)", "Bash(echo:*)", "Bash(mkdir:*)",
      // Git (no push — orchestrator handles push)
      "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)",
      "Bash(git log:*)", "Bash(git diff:*)", "Bash(git tag:*)",
      // Test/lint (project-specific — extend via CLAUDE.md)
      "Bash(bun test:*)", "Bash(bun run:*)",
      "Bash(npm test:*)", "Bash(npm run:*)",
      "Bash(npx:*)",
    ]
  }
};

const writeAgentSettings = async (worktreePath: string) => {
  const settingsDir = join(worktreePath, '.claude');
  await mkdir(settingsDir, { recursive: true });
  await Bun.write(
    join(settingsDir, 'settings.json'),
    JSON.stringify(AGENT_PERMISSIONS, null, 2)
  );
};
```

The agent can read files, run tests, and commit — but cannot push, delete branches, run arbitrary network commands, or `rm -rf`. The orchestrator handles push after the agent exits successfully.

### How It Talks to Linear

Every Linear interaction is a `lineark` CLI call. The exact output schema is deferred — run `lineark usage` and inspect actual JSON output before hardcoding field names.

```typescript
// Types are provisional — verify field names against `lineark usage` output
interface LinearIssue {
  [key: string]: unknown; // Schema deferred until lineark check
}

// Parse lineark JSON output with validation at the boundary
const parseIssues = (raw: string): LinearIssue[] => {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Expected array from lineark');
  return parsed;
};

// Poll for ready issues (skip issues without "design:" in description)
const poll = async (): Promise<LinearIssue[]> => {
  const proc = Bun.spawn(
    ['lineark', 'issues', 'list', '--state', 'Ready for Agent', '--format', 'json'],
    { stdout: 'pipe' }
  );
  const raw = await new Response(proc.stdout).text();
  const issues = parseIssues(raw);
  // TODO: replace 'description' with actual field name from lineark schema
  return issues.filter((i: any) => String(i.description ?? '').includes('design:'));
};

// Move to "In Progress"
const start = (key: string) => Bun.spawn(
  ['lineark', 'issues', 'update', key, '-s', 'In Progress']
);

// Move to "In Review" + comment with PR link
const done = (key: string, prUrl: string) => {
  Bun.spawn(['lineark', 'issues', 'update', key, '-s', 'In Review']);
  Bun.spawn(['lineark', 'issues', 'comment', key,
    `✅ Agent completed. PR: ${prUrl}`]);
};

// Mark failed + comment with error
const fail = (key: string, error: string) => {
  Bun.spawn(['lineark', 'issues', 'update', key, '-s', 'Failed']);
  Bun.spawn(['lineark', 'issues', 'comment', key,
    `❌ Agent failed.\n\n\`\`\`\n${error}\n\`\`\``]);
};
```

No API keys in the orchestrator config for Linear — `lineark` handles auth via its own profile system.

### Polling vs Webhooks (for Linear)

Polling is simpler for a local daemon:
- No Cloudflare Tunnel needed for Linear
- No webhook signature verification
- `lineark issues list` every 30s is trivial load
- Tradeoff: 0-30s latency on pickup (acceptable)

### Environment Init (init.ts)

A fresh worktree has no `node_modules`, no build artifacts, no `.env`. Before spawning the agent, the orchestrator runs project-specific init.

```typescript
// Default init: detect package manager and install
const detectInit = async (worktreePath: string): Promise<string[]> => {
  const commands: string[] = [];

  if (await exists(join(worktreePath, 'bun.lockb')) ||
      await exists(join(worktreePath, 'bun.lock'))) {
    commands.push('bun install');
  } else if (await exists(join(worktreePath, 'package-lock.json'))) {
    commands.push('npm ci');
  } else if (await exists(join(worktreePath, 'yarn.lock'))) {
    commands.push('yarn install --frozen-lockfile');
  } else if (await exists(join(worktreePath, 'pnpm-lock.yaml'))) {
    commands.push('pnpm install --frozen-lockfile');
  }

  return commands;
};

// Run init commands sequentially
const initWorktree = async (
  worktreePath: string,
  projectInit: string[] | undefined,
  runId: string
) => {
  const commands = projectInit ?? await detectInit(worktreePath);
  for (const cmd of commands) {
    appendLog(runId, 'system', `[init] ${cmd}`);
    const proc = Bun.spawn(['sh', '-c', cmd], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Init failed: ${cmd}`);
  }
};
```

If `init` is present in `projects.json`, use those commands. Otherwise, auto-detect from lockfile.

**If init fails** (e.g., missing `.env` with real secrets), the run fails and you see it on the status board. This is expected — it means the project needs manual setup before agents can work on it. Fix the `.env`, retry.

### Git Worktrees (git.ts)

Each agent runs in an isolated worktree. Since `submit.sh` already created the branch and pushed the design doc, the orchestrator creates the worktree from that existing remote branch.

```
Project repo (main working tree — planner reads this, never touched by agents):
  /home/belle/projects/legalipro/

Agent worktrees (one per active run, auto-cleaned):
  /home/belle/projects/legalipro/.worktrees/agent-eng-57-rate-limit/
  /home/belle/projects/legalipro/.worktrees/agent-eng-58-add-cache/
```

**Auto-clone for projects without `path`:**

If `projects.json` has no `path` for a project, the orchestrator clones the repo on first use:

```typescript
const ensureProjectLocal = async (project: ProjectConfig, key: string): Promise<string> => {
  if (project.path) return project.path;

  const repoDir = join(
    homedir(), '.local', 'share', 'agent-orchestrator', 'repos', key
  );
  if (!await exists(repoDir)) {
    await spawn(['git', 'clone', `git@github.com:${project.repo}.git`, repoDir]);
  }
  return repoDir;
};
```

**Lifecycle per agent run:**

```typescript
// 1. Ensure project is local (clone if needed)
const projectPath = await ensureProjectLocal(project, projectKey);

// 2. Fetch the branch that submit.sh created
spawn(['git', '-C', projectPath, 'fetch', 'origin', branch]);

// 3. Nuke any stale worktree at this path (crash recovery)
const worktreePath = join(projectPath, '.worktrees', `agent-${issueKey}-${slug}`);
if (await exists(worktreePath)) {
  spawn(['git', '-C', projectPath, 'worktree', 'remove', '--force', worktreePath]);
}

// 4. Create worktree from the existing remote branch
spawn(['git', '-C', projectPath, 'worktree', 'add',
  '--track', '-b', `local/${branch}`,    // local tracking branch
  worktreePath,                           // worktree directory
  `origin/${branch}`                      // existing remote branch
]);
// The design doc is already here — it was committed by submit.sh

// 5. Write agent permissions
await writeAgentSettings(worktreePath);

// 6. Run environment init (install deps, etc.)
await initWorktree(worktreePath, project.init, runId);

// 7. Build hierarchical prompt
const prompt = await buildAgentPrompt(issue, worktreePath, GLOBAL_PROMPT_PATH);

// 8. Agent runs entirely inside the worktree (with timeout)
const agentProc = spawn([CLAUDE_CODE_PATH, '--print',
  '--message', prompt], {
  cwd: worktreePath,
});

const result = await Promise.race([
  agentProc.exited,
  sleep(AGENT_TIMEOUT_MS).then(() => 'timeout' as const),
]);

if (result === 'timeout') {
  agentProc.kill();
  throw new Error(`Agent timed out after ${AGENT_TIMEOUT_MS / 60000} minutes`);
}

// 9. On success: push from worktree, create PR
spawn(['git', '-C', worktreePath, 'push', 'origin', `local/${branch}:${branch}`]);

// GitHub REST API → create PR
const prUrl = await createPR({
  repo: project.repo,
  base: project.baseBranch,
  head: branch,
  title: `${issue.key}: ${issue.title}`,
  body: `Resolves ${issue.key}\n\nDesign: \`${issue.designPath}\``,
  reviewers: [GITHUB_USERNAME],  // auto-assign you
  draft: false,
});

// 10. Cleanup: remove worktree (branch stays for the PR)
spawn(['git', '-C', projectPath, 'worktree', 'remove', worktreePath]);
```

**Base branch detection:**

```typescript
const getBaseBranch = (project: ProjectConfig): string => {
  const base = project.baseBranch ?? 'main';
  // Verify it exists (run once at startup per project)
  const result = Bun.spawnSync(
    ['git', '-C', project.path, 'ls-remote', '--heads', 'origin', base]
  );
  if (!result.stdout.toString().includes(base)) {
    throw new Error(
      `Base branch '${base}' not found for ${project.key}. ` +
      `Update baseBranch in projects.json.`
    );
  }
  return base;
};
```

**Add to each project's `.gitignore`:**
```
.worktrees/
```

### Runner (runner.ts)

```
Poll loop (every 30s):
  lineark issues list --state "Ready for Agent" --format json
    │
    ▼
  Filter: only issues with "design:" in description
  For each issue not already in DB (UNIQUE on issue_id):
    │
    ├─ Parse from description:
    │   design: docs/designs/slug.md
    │   branch: agent/slug
    │   repo: owner/repo
    ├─ Resolve project by matching repo field against projects.json
    ├─ INSERT OR IGNORE into runs (status: queued)
    └─ Add to queue (skip if INSERT was ignored = duplicate)
    
Tick loop (every 5s):
  If running < MAX_CONCURRENT_AGENTS:
    │
    ├─ Dequeue next run
    ├─ lineark issues update {key} -s "In Progress"
    ├─ Ensure project local (clone if no path)
    ├─ git fetch origin {branch}
    ├─ Nuke stale worktree if exists (force remove)
    ├─ git worktree add → creates .worktrees/agent-{key}-{slug}
    │   (branch already exists with design doc from submit.sh)
    ├─ Write .claude/settings.json (scoped permissions)
    ├─ Run initWorktree (install deps, setup env)
    ├─ Build hierarchical prompt (global → project → design doc)
    ├─ Spawn Claude Code (no --dangerously-skip-permissions)
    │     claude --print --message "{prompt}" (cwd: worktree path)
    ├─ Race against 30 min timeout
    ├─ Capture stdout/stderr → buffer → flush to logs table → SSE broadcast
    │
    └─ On exit:
        ├─ exit 0 → git push (from worktree) → create PR (auto-assign reviewer)
        │           → remove worktree → lineark update → "In Review"
        ├─ timeout → kill process → remove worktree → lineark update → "Failed"
        └─ exit 1 → remove worktree → lineark update → "Failed" + error comment
```

### PR Review Cycle (GitHub Webhook)

When you review a PR and request changes, the orchestrator re-runs the agent with your feedback. The webhook is a **trigger only** — it does not parse the review body. The revision agent uses `gh` CLI to read the full review including inline comments.

**Setup:** In GitHub repo settings → Webhooks, add:
- URL: `https://{tunnel-hostname}/webhook/github` (auto-provisioned, see Tunnel section)
- Events: Pull request reviews
- Secret: `GITHUB_WEBHOOK_SECRET`

**Flow:**

```
You review PR in Zed/GitHub → Request Changes with comment
    │
    ▼
GitHub webhook → POST /webhook/github
    │
    ▼
Orchestrator:
  1. Verify webhook signature (HMAC-SHA256)
  2. Check: is this a "changes_requested" review on a PR we created?
  3. Find the run by branch name
  4. Create new run (status: queued, is_revision: 1)
     with the PR URL stored for the agent to read
  5. New agent run starts in a fresh worktree from the same branch
     (which now has the agent's previous commits)
  6. Agent's revision prompt tells it to read review via gh CLI:
       gh pr view {pr_number} --comments --json reviews
       gh api repos/{owner}/{repo}/pulls/{pr_number}/comments
     This gets both top-level review body AND inline file comments
  7. Agent addresses feedback → pushes → PR updates automatically
```

**Why the agent reads the review instead of the webhook parsing it:**
- Inline/file-level comments require a separate GitHub API call (`GET /pulls/{pr}/comments`)
- Review threads, suggested changes, and conversation context are complex to parse
- The AI is better at interpreting and prioritizing review feedback than a regex parser
- `gh` CLI is already authenticated on the machine

**Revision agent prompt:**

```typescript
const buildRevisionPrompt = async (
  issue: Issue,
  worktreePath: string,
  globalPromptPath: string,
  prNumber: number,
  repo: string
): Promise<string> => {
  const reviewFeedback = `
Read the full PR review including inline comments using these commands:
  gh pr view ${prNumber} --repo ${repo} --json reviews,comments
  gh api repos/${repo}/pulls/${prNumber}/comments

Review the git log to understand previous work:
  git log --oneline origin/${issue.baseBranch}..HEAD

Address ALL review feedback. Do not skip inline comments.
`;

  return buildAgentPrompt(issue, worktreePath, globalPromptPath, reviewFeedback);
};
```

**server.ts webhook handler:**

```typescript
app.post('/webhook/github', async (c) => {
  const signature = c.req.header('x-hub-signature-256');
  const body = await c.req.text();

  if (!verifyGitHubSignature(body, signature, GITHUB_WEBHOOK_SECRET)) {
    return c.text('Invalid signature', 401);
  }

  const event = c.req.header('x-github-event');
  if (event !== 'pull_request_review') return c.text('Ignored', 200);

  const payload = JSON.parse(body);
  if (payload.action !== 'submitted') return c.text('Ignored', 200);
  if (payload.review.state !== 'changes_requested') return c.text('Ignored', 200);

  const branch = payload.pull_request.head.ref;
  const prNumber = payload.pull_request.number;
  const repo = payload.repository.full_name;
  const run = getRunByBranch(branch);
  if (!run) return c.text('Not our PR', 200);

  // Enqueue revision run — agent will read review via gh CLI
  enqueueRevision(run, prNumber, repo);

  return c.text('Queued', 200);
});
```

**State transitions for revision:**

```
Original: queued → running → success → "In Review"
                                            │
                          PR review: changes requested
                                            │
                                            ▼
Revision: queued → running → success → "In Review" (again)
                      │
                      └─ failed → "Failed" + error comment
```

The Linear issue stays in "In Review" during the revision cycle. The orchestrator just spawns a new run. You can see revision history in the status board (same issue key, multiple runs).

### Cloudflare Tunnel (tunnel.ts)

The orchestrator auto-starts a named `cloudflared` tunnel for GitHub webhook delivery. No manual tunnel management needed.

**Prerequisites (one-time setup):**
1. Install `cloudflared` (`brew install cloudflared` / `apt install cloudflared`)
2. Authenticate: `cloudflared tunnel login`
3. Create a named tunnel: `cloudflared tunnel create agent-orchestrator`
4. Add DNS route: `cloudflared tunnel route dns agent-orchestrator agent-orch.yourdomain.com`
5. Set `TUNNEL_NAME=agent-orchestrator` and `TUNNEL_HOSTNAME=agent-orch.yourdomain.com` in `.env`

**Lifecycle management:**

```typescript
let tunnelProc: Subprocess | null = null;

const startTunnel = async (port: number, tunnelName: string) => {
  // Check if cloudflared is available
  const which = Bun.spawnSync(['which', 'cloudflared']);
  if (which.exitCode !== 0) {
    console.warn('cloudflared not found — webhook delivery disabled');
    console.warn('Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    return;
  }

  tunnelProc = Bun.spawn([
    'cloudflared', 'tunnel', '--no-autoupdate',
    '--url', `http://localhost:${port}`,
    'run', tunnelName,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Log tunnel output for debugging
  const reader = tunnelProc.stderr.getReader();
  (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const line = decoder.decode(value);
      if (line.includes('Registered tunnel connection')) {
        console.log(`✓ Tunnel connected: https://${TUNNEL_HOSTNAME}`);
      }
    }
  })();

  console.log(`Starting cloudflared tunnel: ${tunnelName}`);
};

const stopTunnel = () => {
  if (tunnelProc) {
    tunnelProc.kill();
    tunnelProc = null;
  }
};

// Graceful shutdown
process.on('SIGINT', () => { stopTunnel(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });
```

If `cloudflared` is not installed or `TUNNEL_NAME` is not set, the orchestrator starts normally without webhook support — polling still works, you just can't get automatic PR review reruns.

### Database (bun:sqlite)

```sql
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,       -- ULID
  project       TEXT NOT NULL,          -- key from projects.json
  issue_id      TEXT NOT NULL,
  issue_key     TEXT NOT NULL,
  issue_title   TEXT NOT NULL,
  branch        TEXT NOT NULL,
  worktree_path TEXT NOT NULL,          -- .worktrees/agent-{key}-{slug}
  status        TEXT NOT NULL DEFAULT 'queued',
  -- queued → running → success | failed
  is_revision   INTEGER NOT NULL DEFAULT 0,  -- 1 if triggered by PR review
  pr_number     INTEGER,                     -- GitHub PR number (for revision agent gh CLI)
  agent_pid     INTEGER,
  error_summary TEXT,
  pr_url        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  completed_at  TEXT
);

-- Prevent duplicate pickup of same issue in same cycle
CREATE UNIQUE INDEX idx_runs_issue_status ON runs(issue_id, status)
  WHERE status IN ('queued', 'running');

CREATE TABLE logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  stream     TEXT NOT NULL,             -- stdout | stderr | system
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_branch ON runs(branch);
CREATE INDEX idx_logs_run_id ON logs(run_id);
```

The partial unique index on `(issue_id, status) WHERE status IN ('queued', 'running')` prevents duplicate pickup: you can have multiple completed runs for the same issue (original + revisions), but only one active run at a time.

**Log buffering:** Agent stdout/stderr is buffered in memory and flushed to SQLite every 5 seconds (or on process exit). SSE broadcasts from the buffer, not the DB. This avoids per-line write overhead on long-running agents.

```typescript
const LOG_FLUSH_INTERVAL_MS = 5000;

// In-memory buffer per run
const logBuffers = new Map<string, Array<{ stream: string; content: string }>>();

const bufferLog = (runId: string, stream: string, content: string) => {
  if (!logBuffers.has(runId)) logBuffers.set(runId, []);
  logBuffers.get(runId)!.push({ stream, content });
  // SSE broadcast immediately from buffer
  broadcastSSE({ type: 'log', runId, stream, content });
};

const flushLogs = (runId: string) => {
  const buffer = logBuffers.get(runId);
  if (!buffer?.length) return;
  const stmt = db.prepare('INSERT INTO logs (run_id, stream, content) VALUES (?, ?, ?)');
  const insertMany = db.transaction((entries: typeof buffer) => {
    for (const entry of entries) stmt.run(runId, entry.stream, entry.content);
  });
  insertMany(buffer);
  buffer.length = 0;
};

// Periodic flush
setInterval(() => {
  for (const runId of logBuffers.keys()) flushLogs(runId);
}, LOG_FLUSH_INTERVAL_MS);
```

### API

```
GET  /api/runs           List runs (?status=&project= filters)
GET  /api/runs/:id/logs  Logs for a run
POST /api/runs/:id/retry Create new run entry for failed run (re-enqueue)
GET  /api/events         SSE: run updates + log lines
POST /webhook/github     GitHub PR review webhook
GET  /                   Status board
```

**Retry semantics:** `POST /api/runs/:id/retry` creates a **new run entry** (preserving the failed run's logs for debugging). The new run is `queued` with the same issue/branch. The orchestrator also moves the Linear issue back to "In Progress" when the new run starts.

### Status Board (board/index.html)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Agent Orchestrator                                               ● Connected │
├──────────┬─────┬──────────┬──────┬────────────┬─────────┬────────────────────┤
│ Project  │ Key │ Title    │ Rev  │ Status     │ Duration│ Actions            │
├──────────┼─────┼──────────┼──────┼────────────┼─────────┼────────────────────┤
│ legalipro│ E-57│ Rate lim │      │ ● Running  │ 2:14    │ [Logs]             │
│ legalipro│ E-56│ Fix nav  │ #2   │ ● Running  │ 1:05    │ [Logs] [Feedback]  │
│ c-remote │ E-58│ Add SSL  │      │ ● Queued   │ —       │                    │
│ legalipro│ E-56│ Fix nav  │ #1   │ ● Review   │ 4:32    │ [PR] [Logs]        │
│ lea      │ E-55│ Onboard  │      │ ● Failed   │ 1:02    │ [Retry] [Logs]     │
└──────────┴─────┴──────────┴──────┴────────────┴─────────┴────────────────────┘
```

"Rev" column shows revision number. [Feedback] button shows the PR review comments that triggered the revision.

### Config (.env)

```bash
PROJECTS_CONFIG_PATH=/home/belle/.config/planner/projects.json
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=whsec_...
GITHUB_USERNAME=belle                    # Auto-assigned as PR reviewer
CLAUDE_CODE_PATH=claude
MAX_CONCURRENT_AGENTS=2
AGENT_TIMEOUT_MS=1800000                 # 30 minutes
POLL_INTERVAL_MS=30000
LOG_FLUSH_INTERVAL_MS=5000
PORT=7400

# Tunnel (optional — omit to disable webhook support)
TUNNEL_NAME=agent-orchestrator
TUNNEL_HOSTNAME=agent-orch.yourdomain.com
```

### Crash Recovery

On startup:
1. Runs with status `running` → mark `failed` ("orchestrator restarted")
2. Clean up orphaned worktrees: for each failed/completed run that still has a worktree on disk, `git worktree remove --force`
3. Runs with status `queued` → re-add to in-memory queue
4. Start tunnel (if configured)
5. Start poll + tick loops

---

## Shared Config

Both processes read the same `projects.json`. That's the only shared state.

```
~/.config/planner/
├── projects.json       # Project registry (both processes read this)
└── .env                # Orchestrator env vars
```

The planner needs no env vars — `obsidian` and `lineark` handle their own auth/config.

---

## Linear State Setup

Before first use, configure these states in each Linear team that will use the orchestrator:

| State | Type | Purpose |
|---|---|---|
| Ready for Agent | Started | Orchestrator polls for these |
| In Progress | Started | Set when agent is spawned |
| In Review | Started | Set when PR is created |
| Failed | Cancelled | Set when agent fails or times out |

These are custom states — Linear's defaults won't have them. Create them in Linear → Team Settings → Workflow.

---

## Full Workflow

```
Terminal 1:
$ bun run orchestrator     # starts daemon + cloudflared tunnel, polls lineark every 30s

Terminal 2:
$ plan "add rate limiting to legalipro"

  [Claude searches Obsidian, reads project code, designs feature]
  [You review and say "ship it"]
  [Claude calls submit.sh → temp worktree → commits design → pushes → creates ENG-57]

  # 0-30s later, orchestrator picks up ENG-57
  # Creates worktree from agent/rate-limit-middleware branch
  # Design doc is already there (committed by submit.sh)
  # Writes .claude/settings.json with scoped permissions
  # Runs init (bun install, etc.)
  # Builds prompt: global-prompt.md + CLAUDE.md + design doc
  # Spawns agent → builds → runs tests → commits
  # Orchestrator pushes → creates PR (you as reviewer) → "In Review"

$ plan "add caching layer to legalipro"
  # Submit ENG-58 while ENG-57 is still building
  # Both agents run in parallel in separate worktrees — no conflicts

  # Check http://localhost:7400 for status
  # Review PRs in Zed when ready

  # If you request changes on ENG-57's PR:
  # GitHub webhook fires → orchestrator queues revision run
  # New worktree from same branch (has original commits)
  # Agent reads review via gh CLI (gets inline comments too)
  # Addresses feedback → commits → orchestrator pushes → PR updates
```

---

## What's In Each Process

| Concern           | Planner                    | Orchestrator                       |
|-------------------|----------------------------|------------------------------------|
| Linear access     | `lineark` CLI (bash)       | `lineark` CLI (Bun.spawn)          |
| Obsidian access   | `obsidian` CLI (bash)      | N/A                                |
| Git               | `submit.sh` (temp worktree)| `git worktree` + push (Bun.spawn)  |
| GitHub PR         | N/A                        | REST API (fetch) + webhook         |
| GitHub review read| N/A                        | `gh` CLI (via agent in worktree)   |
| Tunnel            | N/A                        | `cloudflared` (auto-managed)       |
| Custom code       | 1 shell script             | 8 TypeScript files                 |
| Database          | None                       | SQLite                             |
| HTTP server       | None                       | Hono                               |

---

## YAGNI

- **No custom MCP server for planner** — Claude Code has bash, CLIs are enough
- **No webhook for Linear** — polling lineark every 30s is simpler
- **No Linear API key in config** — lineark manages its own auth
- **No Obsidian plugin/integration** — the official CLI does everything
- **No vault write access** — designs go on agent branches, not the vault
- **No shared database** — projects.json is the only shared state
- **No custom Linear GraphQL client** — lineark replaces it entirely
- **No project auto-discovery** — explicit projects.json
- **No DAG between issues** — sequence manually in Linear
- **No approval step** — you see the design before saying "submit"
- **No DB migrations** — two tables, created on first run
- **No Docker isolation per agent** — worktrees + scoped permissions provide sufficient isolation
- **No repo clones for local projects** — worktrees share `.git` storage, instant creation, zero disk overhead
- **No per-project concurrency limits** — global MAX_CONCURRENT_AGENTS is enough for single user
- **No log retention policy** — SQLite handles the volume fine
- **No review body parsing in webhook** — agent reads review via `gh` CLI (gets inline comments for free)
- **No manual tunnel management** — orchestrator auto-starts cloudflared

## Tech Stack

| Layer           | Choice               | Why                                       |
|-----------------|---------------------|-------------------------------------------|
| Runtime         | Bun                 | Orchestrator only. Planner is bash.        |
| HTTP            | Hono                | Orchestrator status API + GitHub webhook   |
| Database        | SQLite (bun:sqlite) | Orchestrator run tracking                  |
| Linear access   | lineark CLI         | Rust, agent-friendly, multi-profile auth   |
| Vault access    | obsidian CLI        | Official, search/read/query vault          |
| Agent           | Claude Code CLI     | --print + scoped .claude/settings.json     |
| Git             | git CLI             | worktree add/remove, push, fetch           |
| GitHub API      | fetch + webhook     | Create PR + listen for review events       |
| GitHub review   | gh CLI              | Agent reads PR review + inline comments    |
| Tunnel          | cloudflared         | Named tunnel, auto-managed by orchestrator |
| Status board    | Vanilla HTML + SSE  | No build step                              |

## Estimated Effort

| Module                 | Effort   |
|------------------------|----------|
| plan + PLANNER.md      | 1 hour   |
| submit.sh (worktree-based, with retry) | 1.5 hours |
| projects.json + setup  | 30 min   |
| skills/design.md       | 1 hour   |
| global-prompt.md       | 30 min   |
| orchestrator/server.ts | 1.5 hours|
| orchestrator/runner.ts | 2 hours  |
| orchestrator/git.ts    | 1.5 hours|
| orchestrator/init.ts   | 1 hour   |
| orchestrator/tunnel.ts | 1 hour   |
| orchestrator/db.ts     | 1 hour   |
| orchestrator/types.ts  | 30 min   |
| orchestrator/config.ts | 30 min   |
| orchestrator/board/    | 2 hours  |
| Linear state setup     | 15 min   |
| Cloudflare tunnel setup| 15 min   |
| **Total**              | **~2.5 weekends** |