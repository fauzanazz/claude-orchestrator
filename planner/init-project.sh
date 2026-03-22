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
