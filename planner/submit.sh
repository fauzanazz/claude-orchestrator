#!/usr/bin/env bash
set -euo pipefail

PLANNER_DIR="$(dirname "$(realpath "$0")")"
PROJECTS="$PLANNER_DIR/projects.json"

PROJECT_KEY="$1"
SLUG="$2"
TITLE="$3"
PRIORITY="${4:-3}"

# --- Validate slug (alphanumeric, hyphens, underscores only; no path traversal) ---
if [[ ! "$SLUG" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  echo "Error: slug must be alphanumeric with hyphens/underscores, got '$SLUG'" >&2
  exit 1
fi

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

echo "Branch created: ${BRANCH}"
echo "Design committed: ${DESIGN_PATH}"
echo "Issue created: ${ISSUE_KEY} (Ready for Agent)"
