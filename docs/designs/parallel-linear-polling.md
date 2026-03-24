# Parallelize Linear Issue Polling

## Context

The `pollLinear()` function in `runner.ts` fetches full issue details sequentially — one `lineark issues read` call per issue in a `for` loop. With 10+ issues in "Ready for Agent" state, this blocks the poll cycle for several seconds. Each `lineark issues read` call takes ~500ms (CLI startup + Linear API round-trip), so 10 issues = ~5 seconds of sequential blocking.

## Requirements

- Replace the sequential `for` loop in `pollLinear()` with concurrent fetches, limited to 5 parallel calls
- Preserve all existing behavior: schema validation, parent dependency checking, "In Progress" filtering
- No new dependencies — implement with a simple chunked `Promise.all` pattern
- `fetchLinearParent()` calls (one per issue) should also be batched within each chunk

## Implementation

### 1. Add a chunked concurrency helper

**File:** `orchestrator/src/runner.ts`

Add a utility function near the top of the file (after the imports, around line 73):

```typescript
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
```

### 2. Refactor `pollLinear()` to use concurrent fetches

**File:** `orchestrator/src/runner.ts`

Replace the current sequential loop (lines ~193–239) with this approach:

```typescript
export async function pollLinear(): Promise<LinearIssue[]> {
  // Step 1: List issues (lean output) — unchanged
  const listOut = await runLineark(['issues', 'list', '--format', 'json']);
  let listJson: unknown;
  try {
    listJson = JSON.parse(listOut);
  } catch {
    throw new Error(`lineark list output is not valid JSON: ${listOut.slice(0, 200)}`);
  }
  const parseResult = LinearIssueListSchema.safeParse(listJson);
  if (!parseResult.success) {
    throw new Error(`lineark list output validation failed: ${parseResult.error.message}`);
  }
  const summaries = parseResult.data;

  const ready = summaries.filter((s) => s.state === 'Ready for Agent' || s.state === 'In Progress');
  if (ready.length === 0) return [];

  clearParentStateCache();

  // Step 2: Fetch full details concurrently (5 at a time)
  const POLL_CONCURRENCY = 5;
  const chunks = chunkArray(ready, POLL_CONCURRENCY);
  const issues: LinearIssue[] = [];

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (summary): Promise<LinearIssue | null> => {
        const identifier = summary.identifier;

        // Read full issue details
        let readOut: string;
        try {
          readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
        } catch (err) {
          console.warn(`[runner] lineark read failed for ${identifier}: ${err instanceof Error ? err.message : err}`);
          return null;
        }

        let detailJson: unknown;
        try {
          detailJson = JSON.parse(readOut);
        } catch {
          console.warn(`[runner] lineark read for ${identifier} returned invalid JSON`);
          return null;
        }

        const detailResult = LinearIssueDetailSchema.safeParse(detailJson);
        if (!detailResult.success) {
          console.warn(`[runner] Failed to validate lineark read for ${identifier}: ${detailResult.error.message}`);
          return null;
        }
        const full = detailResult.data;

        if (!full.description.includes('design:') && !(full.description.includes('branch:') && full.description.includes('repo:'))) {
          return null;
        }

        // Skip manually-moved "In Progress" issues
        if (summary.state === 'In Progress' && !hasAnyRunForIssue(full.id)) {
          console.log(`[runner] Skipping ${identifier} — "In Progress" but no prior run (manually moved?)`);
          return null;
        }

        // Fetch parent (Linear API call)
        const parent = await fetchLinearParent(full.id);
        if (parent?.identifier) {
          const done = await isParentDone(parent.identifier);
          if (!done) {
            console.log(`[runner] Skipping ${identifier}: parent ${parent.identifier} not done yet`);
            return null;
          }
        }

        return {
          id: full.id,
          identifier: full.identifier,
          title: full.title,
          description: full.description,
          parent: parent ?? undefined,
        };
      })
    );

    // Collect non-null results
    for (const result of results) {
      if (result) issues.push(result);
    }
  }

  return issues;
}
```

### Key design decisions

- **Chunked `Promise.all`** over a streaming semaphore: simpler, no shared mutable state, and 5-per-chunk is fine for this use case (we're not dealing with thousands of issues).
- **`parentStateCache`** is safe for concurrent access: JavaScript is single-threaded (event loop), so `Map.get`/`Map.set` can't interleave mid-operation. Redundant fetches for the same parent across concurrent tasks are harmless (one extra API call at worst).
- **Error handling per-issue**: a failed `lineark read` for one issue doesn't block others. Returns `null` and logs a warning.

## Testing Strategy

**File:** `orchestrator/src/runner.test.ts`

Add tests for the new `chunkArray` helper (export it for testing):

```typescript
describe('chunkArray', () => {
  test('splits array into chunks of specified size', () => {
    expect(chunkArray([1,2,3,4,5], 2)).toEqual([[1,2],[3,4],[5]]);
  });

  test('returns single chunk if array is smaller than size', () => {
    expect(chunkArray([1,2], 5)).toEqual([[1,2]]);
  });

  test('returns empty array for empty input', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});
```

The existing `parseIssueMetadata` tests still pass (unchanged behavior). Full integration of `pollLinear` is tested by running `bun test` and verifying no regressions. The function's external contract (returns `LinearIssue[]`) is unchanged.

**Commands:**
```bash
cd orchestrator && bun test
cd orchestrator && bunx tsc --noEmit
```

## Out of Scope

- Configurable concurrency limit (hardcoded to 5 is fine for now)
- Parallel `lineark issues list` (there's only one list call — already fast)
- Batching the `lineark issues read` calls into a single CLI invocation (lineark doesn't support multi-read)
- Changes to the review or fix polling loops (they have different patterns)
