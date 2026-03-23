# Issue Dependency Handling via Linear Parent/Sub-issue

## Context

The orchestrator currently has no dependency awareness. When multiple issues are in "Ready for Agent" state, they're all processed as fast as capacity allows, regardless of ordering. This is a problem when Doc B depends on Doc A's changes being merged into the base branch first.

This design adds dependency handling using Linear's native parent/sub-issue relationship. The runner checks whether a parent issue is Done before dispatching a child issue.

## Requirements

- `submit.sh` accepts an optional `--parent <issue-identifier>` flag to set the parent issue
- The runner's `pollLinear()` detects issues that have a parent
- If a parent issue is NOT in a completed state (`Done`), the child issue is skipped during that poll cycle
- When the parent transitions to `Done` (e.g. after PR merge), the child is automatically picked up on the next poll cycle
- No new Linear states needed — child issues remain in "Ready for Agent" throughout
- Zero impact on issues without parents (backward compatible)

## Implementation

### 1. Update `submit.sh` — add `--parent` flag

**File:** `planner/submit.sh`

#### 1a. Add variable and argument parsing

After `PRIORITY="${4:-3}"` (line 10), add:

```bash
PARENT_ISSUE=""
```

The positional args stay the same (project-key, slug, title, priority). Add `--parent` as a named flag. Replace the simple positional assignment block with flag-aware parsing. Insert after the positional args:

```bash
# Parse optional flags after positional args
shift 4 2>/dev/null || shift $#
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent)
      if [[ $# -lt 2 || "$2" == -* ]]; then
        echo "Error: --parent requires an issue identifier (e.g. FAU-9)" >&2
        exit 1
      fi
      PARENT_ISSUE="$2"
      shift 2
      ;;
    *)
      echo "Error: unknown flag '$1'" >&2
      exit 1
      ;;
  esac
done
```

#### 1b. Pass `--parent` to lineark issues create

In the `lineark issues create` call (~line 107), add a conditional `--parent` flag:

```bash
PARENT_FLAG=""
[ -n "$PARENT_ISSUE" ] && PARENT_FLAG="--parent $PARENT_ISSUE"

ISSUE_KEY=$(retry lineark issues create "$TITLE" \
  --team "$TEAM" \
  -p "$PRIORITY" \
  -s "Ready for Agent" \
  --description "$DESCRIPTION" \
  --format json \
  $PROJECT_FLAG \
  $PARENT_FLAG \
  $PROFILE_FLAG | jq -r '.identifier') || {
    echo "Error: failed to create Linear issue after retries" >&2
    echo "Branch $BRANCH was pushed. Create the issue manually or re-run." >&2
    exit 1
  }
```

Note: `$PROJECT_FLAG` is from Doc 1. If Doc 1 is not yet implemented, this variable won't exist — that's fine, just include the `$PARENT_FLAG` variable alongside the existing flags.

#### 1c. Update success output

```bash
[ -n "$PARENT_ISSUE" ] && echo "Parent issue: ${PARENT_ISSUE}"
```

### 2. Update runner — dependency checking in `pollLinear()`

**File:** `orchestrator/src/runner.ts`

#### 2a. Update `LinearIssue` type to include parent

**File:** `orchestrator/src/types.ts`

```typescript
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  parent?: {             // <-- ADD
    id: string;
    identifier: string;
  } | null;
  [key: string]: unknown;
}
```

#### 2b. Add `isParentDone()` helper function

**File:** `orchestrator/src/runner.ts`

Add after the `commentOnIssue` function (~line 206):

```typescript

const parentStateCache = new Map<string, string>();

export function clearParentStateCache(): void {
  parentStateCache.clear();
}

async function getIssueState(identifier: string): Promise<string | null> {
  const cached = parentStateCache.get(identifier);
  if (cached) return cached;

  try {
    const readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
    const parsed = JSON.parse(readOut) as Record<string, unknown>;
    const state = (parsed.state as Record<string, unknown>)?.name as string | undefined;
    if (state) {
      parentStateCache.set(identifier, state);
    }
    return state ?? null;
  } catch {
    console.warn(`[runner] Failed to read state for ${identifier}`);
    return null;
  }
}

async function isParentDone(parentIdentifier: string): Promise<boolean> {
  const state = await getIssueState(parentIdentifier);
  if (!state) return false; // can't determine — safe to block

  const doneStates = ['done', 'canceled', 'cancelled'];
  return doneStates.includes(state.toLowerCase());
}
```

#### 2c. Update `pollLinear()` to extract parent and check dependency

Modify the `pollLinear` function. After parsing the full issue details, capture parent info and check:

```typescript
export async function pollLinear(): Promise<LinearIssue[]> {
  const listOut = await runLineark(['issues', 'list', '--format', 'json']);
  let summaries: Array<Record<string, unknown>>;
  try {
    summaries = JSON.parse(listOut);
  } catch {
    throw new Error(`Failed to parse lineark list output: ${listOut.slice(0, 200)}`);
  }

  const ready = summaries.filter((s) => s.state === 'Ready for Agent');
  if (ready.length === 0) return [];

  clearParentStateCache();

  const issues: LinearIssue[] = [];
  for (const summary of ready) {
    const identifier = summary.identifier as string;
    const readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
    let full: Record<string, unknown>;
    try {
      full = JSON.parse(readOut);
    } catch {
      console.warn(`[runner] Failed to parse lineark read for ${identifier}`);
      continue;
    }

    if (
      typeof full.description === 'string' &&
      full.description.includes('design:')
    ) {
      const parent = full.parent as { id: string; identifier: string } | null | undefined;
      if (parent?.identifier) {
        const done = await isParentDone(parent.identifier);
        if (!done) {
          console.log(`[runner] Skipping ${identifier}: parent ${parent.identifier} not done yet`);
          continue;
        }
      }

      issues.push({
        id: full.id as string,
        identifier: full.identifier as string,
        title: full.title as string,
        description: full.description as string,
        parent: parent ?? null,
      });
    }
  }

  return issues;
}
```

Key behavior:
- If issue has no parent → processed normally (backward compatible)
- If issue has parent and parent is `Done` or `Canceled` → processed normally
- If issue has parent and parent is NOT done → skipped this cycle, will be re-checked next poll
- Parent state is cached within a poll cycle so if multiple children share the same parent, only one `lineark issues read` call is made

### 3. Verify parent field exists in lineark output

**IMPORTANT for the implementing agent:** Before implementing step 2c, first verify the exact field name by creating a test sub-issue:

```bash
lineark issues create "test-child" --team FAU --parent FAU-9 -s "Backlog" --format json
# Check: does the output include a "parent" field?
# Then:
lineark issues read <new-issue-id> --format json | jq '.parent'
# Expected: { "id": "...", "identifier": "FAU-9" }
# Clean up: lineark issues delete <new-issue-id>
```

If the field name differs (e.g. `parentIssue` instead of `parent`), adjust the code accordingly. The Linear GraphQL API uses `parent { id identifier }` so lineark likely mirrors this.

### 4. Update PLANNER.md with `--parent` usage

**File:** `planner/PLANNER.md`

In the "### Submitting a design" section, update the usage example:

```markdown
### Submitting a design
When a design is ready, use the submit script:
  cat <<'EOF' | $PLANNER_DIR/submit.sh <project-key> <slug> <title> [priority] [--parent ISSUE-KEY]
  <design doc content from stdin>
  EOF

Optional flags:
- `--parent <issue-key>`: Set a parent issue. The orchestrator will wait for the
  parent to be Done before processing this issue.
```

## Testing strategy

### 1. submit.sh with --parent flag:
```bash
echo "test" | planner/submit.sh claude-orchestrator test-dep "Test dependency" 3 --parent FAU-9
# Verify: Issue created in Linear with FAU-9 as parent
# Verify: lineark issues read <new-issue> shows parent field
# Clean up after test
```

### 2. submit.sh without --parent (backward compat):
```bash
echo "test" | planner/submit.sh claude-orchestrator test-nodep "Test no dependency" 3
# Verify: Issue created with no parent (same as before)
```

### 3. Runner dependency blocking (manual test):
- Create two issues: parent (Ready for Agent) and child with --parent (Ready for Agent)
- Start the orchestrator
- Verify: parent is picked up and processed
- Verify: child is skipped with log message "Skipping <child>: parent <parent> not done yet"
- Mark parent as Done: `lineark issues update <parent> -s Done`
- Wait for next poll cycle (~30s)
- Verify: child is now picked up and processed

### 4. Cache effectiveness:
- Create two child issues with the same parent
- Check orchestrator logs: parent should only be read once per poll cycle

### 5. TypeScript type check:
```bash
cd orchestrator && bunx tsc --noEmit
```

## Out of scope

- Multi-level dependency chains (grandparent → parent → child). This design only checks the immediate parent. Deep chains would require recursive checking.
- Automatic state transitions (e.g. auto-moving child to "Ready for Agent" when parent is Done). Children are already in "Ready for Agent" — they just get skipped until parent is done.
- Circular dependency detection (if A depends on B depends on A). This would cause both to be perpetually skipped, which is visible in logs.
- Dependency visualization in the dashboard.
