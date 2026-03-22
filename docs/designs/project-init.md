# Add Project Init CLI Command

## Context

The claude-orchestrator currently requires manually setting up repositories and editing
`projects.json` to onboard a new project. This creates friction — every new project needs:
manual `git init`, manual `gh repo create`, manual JSON editing, and manual first push.

This design adds a `plan --init <name>` command that automates the entire flow: create local
repo, create GitHub remote, push initial commit, and register in `projects.json`.

## Requirements

- `plan --init <project-name>` creates a fully operational project in one command
- Creates a local git repository at `~/Github/<project-name>/`
- Creates a private GitHub repo under the authenticated user's personal account via `gh`
- Pushes an initial commit with README.md, .gitignore, and CLAUDE.md stub
- Registers the project in `planner/projects.json` with all required fields
- Prints a summary (local path, GitHub URL, project key) and exits
- Supports `--public` flag to create a public repo instead of private
- Supports `--path <dir>` flag to override the default `~/Github/` base directory
- Supports `--team <team>` flag to override the default Linear team (`FAU`)
- Rolls back partial state on failure (remove dir, delete remote repo)
- Validates `gh` is installed and authenticated before starting
- Validates project name doesn't already exist in `projects.json`

## Implementation

### Files to modify

#### `planner/plan` (modify — add init flag detection)

Add a 4-line block at the top, after the `PLANNER_DIR` line, before any prompt templating:

```bash
#!/usr/bin/env bash
PLANNER_DIR="$(dirname "$(realpath "$0")")"

# Route --init to the project init script
if [[ "${1:-}" == "--init" ]]; then
  shift
  exec "$PLANNER_DIR/init-project.sh" "$@"
fi

# Template paths into system prompt (existing code, unchanged)
PROMPT=$(sed \
  -e "s|\\\$PLANNER_DIR|$PLANNER_DIR|g" \
  -e "s|\\\$PROJECTS_JSON|$PLANNER_DIR/projects.json|g" \
  "$PLANNER_DIR/PLANNER.md")

SKILL=$(cat "$PLANNER_DIR/skills/design.md")
PROMPT="${PROMPT//<DESIGN_SKILL>/$SKILL}"

exec claude --dangerously-skip-permissions --system-prompt "$PROMPT" "$@"
```

### Files to create

#### `planner/init-project.sh` (new file — the core implementation)

This is a bash script. Make it executable (`chmod +x`).

**Usage:**

```
init-project.sh <project-name> [--public] [--path <dir>] [--team <team>]
```

**Argument parsing:**

```bash
#!/usr/bin/env bash
set -euo pipefail

PLANNER_DIR="$(dirname "$(realpath "$0")")"
PROJECTS_JSON="$PLANNER_DIR/projects.json"

# Defaults
PROJECT_NAME=""
VISIBILITY="private"
BASE_DIR="$HOME/Github"
LINEAR_TEAM="FAU"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public)
      VISIBILITY="public"
      shift
      ;;
    --path)
      BASE_DIR="$2"
      shift 2
      ;;
    --team)
      LINEAR_TEAM="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: plan --init <project-name> [--public] [--path <dir>] [--team <team>]"
      echo ""
      echo "Creates a new project: local repo + GitHub remote + projects.json entry"
      echo ""
      echo "Options:"
      echo "  --public       Create a public GitHub repo (default: private)"
      echo "  --path <dir>   Base directory for the project (default: ~/Github)"
      echo "  --team <team>  Linear team key (default: FAU)"
      echo "  --help         Show this help"
      exit 0
      ;;
    -*)
      echo "Error: unknown flag '$1'" >&2
      echo "Run 'plan --init --help' for usage" >&2
      exit 1
      ;;
    *)
      if [ -z "$PROJECT_NAME" ]; then
        PROJECT_NAME="$1"
      else
        echo "Error: unexpected argument '$1'" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$PROJECT_NAME" ]; then
  echo "Error: project name is required" >&2
  echo "Usage: plan --init <project-name>" >&2
  exit 1
fi
```

**Validation phase** (after argument parsing):

```bash
# --- Validate prerequisites ---

# 1. gh CLI must be installed and authenticated
if ! command -v gh &>/dev/null; then
  echo "Error: 'gh' CLI is not installed. Install from https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "Error: 'gh' is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# 2. jq must be available (used for projects.json manipulation)
if ! command -v jq &>/dev/null; then
  echo "Error: 'jq' is not installed." >&2
  exit 1
fi

# 3. Project name must not already exist in projects.json
if jq -e --arg k "$PROJECT_NAME" 'has($k)' "$PROJECTS_JSON" &>/dev/null; then
  echo "Error: project '$PROJECT_NAME' already exists in projects.json" >&2
  exit 1
fi

# 4. Target directory must not already exist
PROJECT_PATH="$BASE_DIR/$PROJECT_NAME"
if [ -d "$PROJECT_PATH" ]; then
  echo "Error: directory '$PROJECT_PATH' already exists" >&2
  exit 1
fi

# 5. Get GitHub username
GH_USER=$(gh api user --jq '.login')
if [ -z "$GH_USER" ]; then
  echo "Error: could not determine GitHub username" >&2
  exit 1
fi

REPO_FULLNAME="$GH_USER/$PROJECT_NAME"
```

**Rollback state tracking** (same pattern as `submit.sh`):

```bash
# --- Rollback state tracking ---
DIR_CREATED=false
REPO_CREATED=false
JSON_MODIFIED=false
ORIGINAL_JSON=""

rollback() {
  echo "Rolling back..." >&2
  if [ "$JSON_MODIFIED" = true ] && [ -n "$ORIGINAL_JSON" ]; then
    echo "$ORIGINAL_JSON" > "$PROJECTS_JSON"
    echo "  Restored projects.json" >&2
  fi
  if [ "$REPO_CREATED" = true ]; then
    gh repo delete "$REPO_FULLNAME" --yes 2>/dev/null && echo "  Deleted GitHub repo" >&2 || true
  fi
  if [ "$DIR_CREATED" = true ] && [ -d "$PROJECT_PATH" ]; then
    rm -rf "$PROJECT_PATH"
    echo "  Removed $PROJECT_PATH" >&2
  fi
  exit 1
}
```

**Execution steps** (in order, with rollback on failure):

```bash
# --- Step 1: Create local directory ---
echo "Creating $PROJECT_PATH..."
mkdir -p "$PROJECT_PATH"
DIR_CREATED=true

# --- Step 2: Initialize git repo ---
echo "Initializing git repo..."
git -C "$PROJECT_PATH" init -b main

# --- Step 3: Create initial files ---
cat > "$PROJECT_PATH/README.md" << EOF
# $PROJECT_NAME
EOF

cat > "$PROJECT_PATH/.gitignore" << 'EOF'
# Dependencies
node_modules/
.venv/

# Environment
.env
.env.local

# OS
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# Build
dist/
build/
*.tgz
EOF

cat > "$PROJECT_PATH/CLAUDE.md" << EOF
# $PROJECT_NAME

## Project Overview

<!-- Describe what this project does -->

## Tech Stack

<!-- List technologies used -->

## Development

<!-- How to run, test, and build -->

## Conventions

<!-- Project-specific coding conventions -->
EOF

# --- Step 4: Initial commit ---
echo "Creating initial commit..."
git -C "$PROJECT_PATH" add -A
git -C "$PROJECT_PATH" commit -m "Initial commit"

# --- Step 5: Create GitHub repo ---
echo "Creating GitHub repo ($VISIBILITY)..."
gh repo create "$PROJECT_NAME" "--$VISIBILITY" --source "$PROJECT_PATH" --push || {
  echo "Error: failed to create GitHub repo" >&2
  rollback
}
REPO_CREATED=true

# --- Step 6: Register in projects.json ---
echo "Registering in projects.json..."
ORIGINAL_JSON=$(cat "$PROJECTS_JSON")

UPDATED_JSON=$(jq \
  --arg key "$PROJECT_NAME" \
  --arg path "$PROJECT_PATH" \
  --arg repo "$REPO_FULLNAME" \
  --arg team "$LINEAR_TEAM" \
  '. + {($key): {path: $path, repo: $repo, baseBranch: "main", linearTeam: $team, linearProfile: ""}}' \
  "$PROJECTS_JSON")

echo "$UPDATED_JSON" | jq --sort-keys '.' > "$PROJECTS_JSON"
JSON_MODIFIED=true

# --- Done ---
echo ""
echo "Project created successfully!"
echo "  Local path:  $PROJECT_PATH"
echo "  GitHub repo: https://github.com/$REPO_FULLNAME"
echo "  Project key: $PROJECT_NAME"
echo "  Visibility:  $VISIBILITY"
echo ""
echo "Next steps:"
echo "  cd $PROJECT_PATH"
echo "  plan \"Describe your first feature\""
```

**Complete file structure** — the script is a single file with these sections in order:
1. Shebang + set options
2. Argument parsing (PROJECT_NAME, VISIBILITY, BASE_DIR, LINEAR_TEAM)
3. Validation (gh, jq, duplicate check, directory check, GitHub username)
4. Rollback function
5. Step 1-6 execution
6. Summary output

### Data shape: projects.json entry

The new entry added to `planner/projects.json` for a project called `my-app`:

```json
{
  "my-app": {
    "path": "/Users/enjat/Github/my-app",
    "repo": "fauzanazz/my-app",
    "baseBranch": "main",
    "linearTeam": "FAU",
    "linearProfile": ""
  }
}
```

This matches the existing `ProjectConfig` interface in `orchestrator/src/types.ts`:

```typescript
export interface ProjectConfig {
  path?: string;
  repo: string;
  linearTeam: string;
  linearProfile?: string;
  baseBranch: string;
  init?: string[];
  description?: string;
}
```

## Testing Strategy

Since this is a bash script, test manually with these scenarios:

1. **Happy path**: `plan --init test-project-001` — verify local dir, GitHub repo, projects.json entry, initial commit
2. **Duplicate prevention**: Run the same command again — should fail with "already exists"
3. **Public repo**: `plan --init test-project-002 --public` — verify repo is public via `gh repo view`
4. **Custom path**: `plan --init test-project-003 --path /tmp` — verify created at `/tmp/test-project-003`
5. **Rollback on GitHub failure**: Disconnect network after Step 4, verify local dir is cleaned up
6. **Missing gh**: Rename gh binary temporarily, verify clean error message
7. **Existing directory**: `mkdir ~/Github/test-conflict && plan --init test-conflict` — should fail

After testing, clean up test repos:
```bash
gh repo delete fauzanazz/test-project-001 --yes
gh repo delete fauzanazz/test-project-002 --yes
# Remove entries from projects.json
```

## Out of Scope

- Organization repo support (`--org` flag) — future enhancement
- Project templates (Bun+Hono, Next.js, Python) — future enhancement
- Orchestrator-side changes (runner.ts, server.ts, db.ts) — not needed
- Dashboard UI for project creation — CLI only
- Auto-launching a planner session after init
- Modifying the PLANNER.md system prompt (no new instructions needed — the planner already reads projects.json)
