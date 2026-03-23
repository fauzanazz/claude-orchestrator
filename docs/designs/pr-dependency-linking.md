# Link Dependent PRs to Parent PRs on Creation

## Context

The orchestrator creates PRs after an agent completes work on a Linear issue. When issues have parent/sub-issue relationships in Linear (set via `submit.sh --parent` or manually), the created PRs have no awareness of each other. A child PR should reference its parent PR so reviewers understand the dependency chain.

FAU-12 (design-4) covers dispatch ordering (skip child issues until parent is Done) and `submit.sh --parent` flag but is still in progress. This design adds the **PR linking** behavior that runs at PR creation time, and includes the minimal parent-awareness plumbing needed from the issue data flow. This design is independent of FAU-12's dispatch ordering — both can be implemented in any order.

## Requirements

- When the orchestrator creates a PR for an issue that has a parent issue in Linear, the PR body must include a "Depends on #X" reference to the parent's PR
- The parent's PR number is looked up from the `runs` table (most recent successful run for the parent issue key)
- If the parent has no PR yet (not processed, or failed), the PR is still created but without the dependency link — a log message is emitted instead
- Issues without a parent are unaffected (backward compatible)
- The `submit.sh` script accepts an optional `--parent <issue-identifier>` flag (if not already implemented by FAU-12)

## Implementation

### 1. Add `--parent` flag to `submit.sh`

**File:** `planner/submit.sh`

**Skip this section if FAU-12 has already implemented it.** Check by running: `grep -q PARENT_ISSUE planner/submit.sh && echo "already done"`.

After line 10 (`PRIORITY="${4:-3}"`), add variable and flag parsing:

```bash
PARENT_ISSUE=""

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

In the `lineark issues create` call (~line 107), add the parent flag:

```bash
PARENT_FLAG=""
[ -n "$PARENT_ISSUE" ] && PARENT_FLAG="--parent $PARENT_ISSUE"
```

Add `$PARENT_FLAG` to the `lineark issues create` invocation, alongside the existing `$PROFILE_FLAG`:

```bash
ISSUE_KEY=$(retry lineark issues create "$TITLE" \
  --team "$TEAM" \
  -p "$PRIORITY" \
  -s "Ready for Agent" \
  --description "$DESCRIPTION" \
  --format json \
  $PARENT_FLAG \
  $PROFILE_FLAG | jq -r '.identifier') || {
    ...
  }
```

At the end of the success output block, add:

```bash
[ -n "$PARENT_ISSUE" ] && echo "Parent issue: ${PARENT_ISSUE}"
```

### 2. Add `parentKey` to `Issue` interface

**File:** `orchestrator/src/types.ts`

Add an optional `parentKey` field to the `Issue` interface:

```typescript
export interface Issue extends ParsedIssueMetadata {
  id: string;
  key: string;
  title: string;
  description: string;
  baseBranch: string;
  parentKey: string | null;  // <-- ADD: parent issue identifier (e.g. "FAU-9")
}
```

### 3. Add `getPRNumberByIssueKey()` query

**File:** `orchestrator/src/db.ts`

Add a new prepared statement and export after the existing `getRunByPRNumber` function (~line 431):

```typescript
const stmtGetPRByIssueKey = db.prepare<{ pr_number: number } | null, [string]>(`
  SELECT pr_number FROM runs
  WHERE issue_key = ?
    AND pr_number IS NOT NULL
    AND is_fix = 0
    AND is_revision = 0
    AND status = 'success'
  ORDER BY created_at DESC LIMIT 1
`);

export function getPRNumberByIssueKey(issueKey: string): number | null {
  const row = stmtGetPRByIssueKey.get(issueKey);
  return row?.pr_number ?? null;
}
```

### 4. Extract parent from Linear issue data in `pollLinear()`

**File:** `orchestrator/src/runner.ts`

In the `pollLinear()` function, after parsing the full issue details (~line 154), extract the parent identifier. Modify the `issues.push(...)` block:

```typescript
// Inside the for loop, after the design: check passes:
const parent = full.parent as { id: string; identifier: string } | null | undefined;

issues.push({
  id: full.id as string,
  identifier: full.identifier as string,
  title: full.title as string,
  description: full.description as string,
  parent: parent ?? undefined,  // pass through raw parent data
});
```

Note: The `LinearIssue` type has `[key: string]: unknown` so the extra `parent` field is accepted without a type change.

### 5. Pass `parentKey` when constructing `Issue` in dispatch loop

**File:** `orchestrator/src/runner.ts`

In the dispatch loop inside `startPolling()` (~line 1172), when constructing the `Issue` object, add `parentKey`:

```typescript
const issue: Issue = {
  id: linearIssue.id,
  key: linearIssue.identifier,
  title: linearIssue.title,
  description: linearIssue.description,
  designPath: meta.designPath,
  branch: meta.branch,
  repo: meta.repo,
  baseBranch: resolved.project.baseBranch,
  parentKey: (linearIssue as any).parent?.identifier ?? null,  // <-- ADD
};
```

### 6. Pass `parentKey` in `reconstructIssueFromRun()`

**File:** `orchestrator/src/runner.ts`

In `reconstructIssueFromRun()` (~line 268), add `parentKey` to the returned object:

```typescript
const parent = linearIssue.parent as { id: string; identifier: string } | null | undefined;

return {
  id: linearIssue.id as string,
  key: run.issue_key,
  title: run.issue_title,
  description: linearIssue.description as string,
  designPath: meta.designPath,
  branch: meta.branch,
  repo: meta.repo,
  baseBranch: resolved.project.baseBranch,
  parentKey: parent?.identifier ?? null,  // <-- ADD
};
```

### 7. Pass `parentKey` in `getIssueForRun()` fallback

**File:** `orchestrator/src/db.ts`

In the `getIssueForRun()` function that reconstructs `Issue` from DB columns, add `parentKey: null`:

```typescript
export function getIssueForRun(run: Run): Issue | null {
  if (!run.design_path || !run.issue_repo || !run.base_branch) return null;
  return {
    id: run.issue_id,
    key: run.issue_key,
    title: run.issue_title,
    description: '',
    designPath: run.design_path,
    branch: run.branch,
    repo: run.issue_repo,
    baseBranch: run.base_branch,
    parentKey: null,  // <-- ADD: not available from DB, but PR linking is best-effort
  };
}
```

### 8. Build dependency-aware PR body in `executeRun()`

**File:** `orchestrator/src/runner.ts`

Import `getPRNumberByIssueKey` at the top (~line 24), alongside existing db imports:

```typescript
import {
  // ... existing imports ...
  getPRNumberByIssueKey,
} from './db.ts';
```

Replace the PR creation block (~lines 716-724). Change from:

```typescript
prUrl = await createPR({
  repo: issue.repo,
  base: issue.baseBranch,
  head: issue.branch,
  title: `[${issue.key}] ${issue.title}`,
  body: `Automated implementation for ${issue.key}.\n\nDesign: \`${issue.designPath}\``,
  reviewer: config.githubUsername,
});
```

To:

```typescript
// Build PR body with optional dependency link
let prBody = `Automated implementation for ${issue.key}.\n\nDesign: \`${issue.designPath}\``;

if (issue.parentKey) {
  const parentPR = getPRNumberByIssueKey(issue.parentKey);
  if (parentPR) {
    prBody += `\n\nDepends on #${parentPR}`;
    bufferLog(runId, 'system', `[runner] Linked PR to parent ${issue.parentKey} (PR #${parentPR})`);
  } else {
    bufferLog(runId, 'system', `[runner] Parent ${issue.parentKey} has no PR yet — skipping dependency link`);
  }
}

prUrl = await createPR({
  repo: issue.repo,
  base: issue.baseBranch,
  head: issue.branch,
  title: `[${issue.key}] ${issue.title}`,
  body: prBody,
  reviewer: config.githubUsername,
});
```

## Testing strategy

### 1. Type check
```bash
cd orchestrator && bunx tsc --noEmit
```

### 2. submit.sh --parent flag (manual)
```bash
# Test with --parent
echo "test" | planner/submit.sh claude-orchestrator test-link "Test PR linking" 3 --parent FAU-21
# Verify: lineark issues read <new-issue> --format json | jq '.parent'
# Expected: { "id": "...", "identifier": "FAU-21" }
# Clean up: lineark issues delete <new-issue> && git push origin --delete agent/test-link

# Test without --parent (backward compat)
echo "test" | planner/submit.sh claude-orchestrator test-nolink "Test no parent" 3
# Verify: issue created normally, no parent field
# Clean up: lineark issues delete <new-issue> && git push origin --delete agent/test-nolink
```

### 3. DB query (unit test)
```bash
cd orchestrator && bun test db
```
Add a test case in a new or existing test file that:
- Inserts a mock run with `issue_key = 'FAU-99'`, `pr_number = 42`, `status = 'success'`
- Calls `getPRNumberByIssueKey('FAU-99')` and asserts it returns `42`
- Calls `getPRNumberByIssueKey('FAU-NONEXISTENT')` and asserts it returns `null`

### 4. End-to-end (manual observation)
- Create a parent issue (no parent) and let the orchestrator process it to PR
- Create a child issue with `--parent <parent-key>` and let the orchestrator process it
- Verify the child's PR body contains `Depends on #<parent-pr-number>`
- Check orchestrator logs for `[runner] Linked PR to parent` message

## Out of scope

- **Dispatch ordering** (skipping child issues until parent is Done) — covered by FAU-12
- **Stacked PRs** (setting `--base` to parent's branch instead of `main`) — creates merge complexity; not needed for linking
- **Updating existing PRs** when a parent PR is created after the child PR — would require a separate polling mechanism
- **Multi-level dependency chains** (grandparent references) — only immediate parent is linked
- **Linear relation creation** (creating `blocked-by` relations between Linear issues) — orthogonal to PR linking
