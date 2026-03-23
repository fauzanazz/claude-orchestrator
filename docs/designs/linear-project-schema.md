# Linear Project: Schema + Auto-create + Auto-assign

## Context

The claude-orchestrator currently creates Linear issues but doesn't organize them under Linear Projects. This is the foundational design doc that adds the `linearProject` field to the project config, auto-creates Linear Projects during project init, and auto-assigns issues to projects during submit.

## Requirements

- Add optional `linearProject` string field to `projects.json` entries
- `init-project.sh` must auto-create a Linear Project (or reuse existing) and write the name to `projects.json`
- `init-project.sh` must accept `--linear-project <name>` flag to specify a custom project name (default: project key name)
- `submit.sh` must read `linearProject` from config and pass `--project` to `lineark issues create`
- Backward compatible: entries without `linearProject` work exactly as before
- Many:1 mapping: multiple project keys can reference the same `linearProject` name
- All Linear Projects created under team FAU

## Implementation

### 1. Update `projects.json` schema

Add `linearProject` field to project entries. Example:

```json
{
  "keloia": {
    "path": "/Users/enjat/Github/keloia/keloia",
    "repo": "Keloia/keloia",
    "baseBranch": "main",
    "linearTeam": "FAU",
    "linearProfile": "",
    "linearProject": "Keloia"
  },
  "keloia-docs": {
    "path": "/Users/enjat/Github/keloia/keloia-docs",
    "repo": "Keloia/KELOIA-DOCS",
    "baseBranch": "main",
    "linearTeam": "FAU",
    "linearProfile": "",
    "linearProject": "Keloia"
  }
}
```

No existing entries are modified — the field is purely additive.

### 2. Update TypeScript type

**File:** `orchestrator/src/types.ts`

Add `linearProject` to `ProjectConfig`:

```typescript
export interface ProjectConfig {
  path?: string;
  repo: string;
  linearTeam: string;
  linearProfile?: string;
  baseBranch: string;
  init?: string[];
  description?: string;
  linearProject?: string;  // <-- ADD THIS
}
```

No other TypeScript files need changes — the runner doesn't use this field (it works with issues, not projects).

### 3. Update `init-project.sh`

**File:** `planner/init-project.sh`

#### 3a. Add `--linear-project` flag parsing

In the argument parsing `while` loop (after the existing `--team` case), add:

```bash
    --linear-project)
      if [[ $# -lt 2 || "$2" == -* ]]; then
        echo "Error: --linear-project requires a value" >&2
        exit 1
      fi
      LINEAR_PROJECT_NAME="$2"
      shift 2
      ;;
```

Add default at the top with other defaults:

```bash
LINEAR_PROJECT_NAME=""
```

Update the help text to include the new flag:

```bash
echo "  --linear-project <name>  Linear project name (default: project name). Reuses if exists."
```

#### 3b. Add Linear Project creation step (after Step 5: Create GitHub repo, before Step 6: Register in projects.json)

Insert a new step between the current Step 5 (push to remote) and Step 6 (register in projects.json):

```bash
# --- Step 6: Create or reuse Linear Project ---
# Default project name to the project key if not specified
if [ -z "$LINEAR_PROJECT_NAME" ]; then
  LINEAR_PROJECT_NAME="$PROJECT_NAME"
fi

echo "Checking for Linear Project '$LINEAR_PROJECT_NAME'..."

# Check if project already exists
EXISTING_PROJECT=$(lineark projects list --format json | jq -r --arg name "$LINEAR_PROJECT_NAME" '.[] | select(.name == $name) | .name' 2>/dev/null || true)

if [ -n "$EXISTING_PROJECT" ]; then
  echo "  Reusing existing Linear Project: $EXISTING_PROJECT"
else
  echo "  Creating Linear Project: $LINEAR_PROJECT_NAME"
  lineark projects create "$LINEAR_PROJECT_NAME" --team "$LINEAR_TEAM" --format json > /dev/null || {
    echo "Warning: failed to create Linear Project '$LINEAR_PROJECT_NAME'. Continuing without it." >&2
    LINEAR_PROJECT_NAME=""
  }
fi
```

Note: Linear Project creation failure is a **warning**, not a fatal error. The project init still succeeds — the user can manually create the Linear Project later.

#### 3c. Update Step 6 (now Step 7): Write `linearProject` to projects.json

Modify the existing `jq` command in the registration step to include `linearProject`:

```bash
UPDATED_JSON=$(jq \
  --arg key "$PROJECT_NAME" \
  --arg path "$PROJECT_PATH" \
  --arg repo "$REPO_FULLNAME" \
  --arg team "$LINEAR_TEAM" \
  --arg linproj "$LINEAR_PROJECT_NAME" \
  '. + {($key): {path: $path, repo: $repo, baseBranch: "main", linearTeam: $team, linearProfile: "", linearProject: $linproj}}' \
  "$PROJECTS_JSON")
```

#### 3d. Update "Done" output

Add to the summary output:

```bash
echo "  Linear project: ${LINEAR_PROJECT_NAME:-none}"
```

#### 3e. Update rollback

No rollback needed for the Linear Project creation — it's idempotent (reuses if exists) and non-destructive (lineark doesn't support project delete).

### 4. Update `submit.sh`

**File:** `planner/submit.sh`

#### 4a. Read `linearProject` from config

After the existing config reads (line ~16), add:

```bash
LINEAR_PROJECT=$(jq -r --arg k "$PROJECT_KEY" '.[$k].linearProject // empty' "$PROJECTS")
```

#### 4b. Pass `--project` to issue creation

Modify the `lineark issues create` command (around line 107). Add `--project` flag conditionally:

```bash
PROJECT_FLAG=""
[ -n "$LINEAR_PROJECT" ] && PROJECT_FLAG="--project $LINEAR_PROJECT"

ISSUE_KEY=$(retry lineark issues create "$TITLE" \
  --team "$TEAM" \
  -p "$PRIORITY" \
  -s "Ready for Agent" \
  --description "$DESCRIPTION" \
  --format json \
  $PROJECT_FLAG \
  $PROFILE_FLAG | jq -r '.identifier') || {
    echo "Error: failed to create Linear issue after retries" >&2
    echo "Branch $BRANCH was pushed. Create the issue manually or re-run." >&2
    exit 1
  }
```

#### 4c. Update success output

Add to the final echo:

```bash
[ -n "$LINEAR_PROJECT" ] && echo "Linear project: ${LINEAR_PROJECT}"
```

## Testing strategy

### Manual tests (shell scripts don't have unit tests):

1. **init-project.sh with new project:**
   ```bash
   plan --init test-linear-proj
   # Verify: Linear Project "test-linear-proj" created in Linear
   # Verify: projects.json has linearProject: "test-linear-proj"
   ```

2. **init-project.sh with shared project:**
   ```bash
   plan --init test-sub-proj --linear-project test-linear-proj
   # Verify: Reuses existing "test-linear-proj" (no duplicate)
   # Verify: projects.json has linearProject: "test-linear-proj"
   ```

3. **submit.sh with linearProject:**
   ```bash
   echo "test content" | planner/submit.sh test-linear-proj test-slug "Test title"
   # Verify: Issue created with project assignment in Linear
   ```

4. **submit.sh without linearProject (backward compat):**
   ```bash
   echo "test content" | planner/submit.sh claude-orchestrator test-slug2 "Test title 2"
   # Verify: Issue created without project (no error)
   ```

5. **TypeScript type check:**
   ```bash
   cd orchestrator && bunx tsc --noEmit
   # Verify: No type errors
   ```

### Cleanup after testing:
- Delete test projects from projects.json
- Delete test GitHub repos
- Clean up Linear issues manually

## Out of scope

- Updating existing projects.json entries to add linearProject (manual one-time task)
- Linear Project update/archive (lineark doesn't support it)
- Orchestrator runner changes (it works with issues, not projects)
- Dashboard changes (separate design doc)
- Milestone management (separate design doc)
