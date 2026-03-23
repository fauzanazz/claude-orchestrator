# Security: CLI Output Validation with Zod Schemas

## Context

Security audit finding LOW-2. JSON output from `lineark` and `gh` CLIs is parsed with `JSON.parse()` and cast with `as` type assertions. No runtime validation. If a CLI changes its output format, the orchestrator silently processes malformed data instead of failing loudly.

## Requirements

- Define Zod schemas for all external CLI output parsing boundaries
- Replace `as` type assertions with schema validation at the parse boundary
- Provide clear error messages when CLI output doesn't match expected schema
- Don't over-validate — only validate fields the orchestrator actually uses

## Implementation

### 1. Add Zod dependency

In `orchestrator/package.json`, add:

```json
"dependencies": {
  "zod": "^3.23.0"
}
```

Run `bun install` to install.

### 2. Create `orchestrator/src/schemas.ts`

New file containing all CLI output schemas:

```typescript
import { z } from 'zod';

export const LinearIssueSummarySchema = z.object({
  identifier: z.string(),
  title: z.string().optional(),
  state: z.string().optional(),
}).passthrough(); // Allow extra fields we don't use

export const LinearIssueListSchema = z.array(LinearIssueSummarySchema);

export const LinearIssueDetailSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional().default(''),
}).passthrough();

export const LinearIssueCreateSchema = z.object({
  identifier: z.string(),
}).passthrough();

export const GHPRListItemSchema = z.object({
  number: z.number(),
});

export const GHPRListSchema = z.array(GHPRListItemSchema);

export const GHPRViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  headRefName: z.string(),
  reviewDecision: z.string().nullable().optional().default(''),
  mergeable: z.string().optional().default('UNKNOWN'),
  statusCheckRollup: z.array(z.object({
    name: z.string(),
    status: z.string().optional().default(''),
    conclusion: z.string().nullable().optional().default(''),
  })).optional().default([]),
  commits: z.array(z.object({
    committedDate: z.string(),
  })).optional().default([]),
  reviews: z.array(z.object({
    submittedAt: z.string().optional().default(''),
    state: z.string().optional().default(''),
    author: z.object({
      login: z.string(),
    }).optional(),
    body: z.string().optional().default(''),
  })).optional().default([]),
  comments: z.array(z.object({
    createdAt: z.string().optional().default(''),
    author: z.object({
      login: z.string(),
    }).optional(),
  })).optional().default([]),
});

export const GHPRReviewPollSchema = z.object({
  state: z.string().optional(),
  reviews: z.array(z.object({
    id: z.string().optional(),
    state: z.string().optional().default(''),
    body: z.string().optional().default(''),
    author: z.object({
      login: z.string(),
    }).optional(),
  })).optional().default([]),
});

export const GHRunListSchema = z.array(z.object({
  databaseId: z.number(),
  name: z.string(),
}));
```

### 3. Update `orchestrator/src/runner.ts` — Linear CLI parsing

**In `pollLinear()` (around line 122):**

```typescript
import { LinearIssueListSchema, LinearIssueDetailSchema } from './schemas.ts';

export async function pollLinear(): Promise<LinearIssue[]> {
  const listOut = await runLineark(['issues', 'list', '--format', 'json']);

  const parseResult = LinearIssueListSchema.safeParse(JSON.parse(listOut));
  if (!parseResult.success) {
    throw new Error(`lineark list output validation failed: ${parseResult.error.message}`);
  }
  const summaries = parseResult.data;

  const ready = summaries.filter((s) => s.state === 'Ready for Agent');
  if (ready.length === 0) return [];

  const issues: LinearIssue[] = [];
  for (const summary of ready) {
    const identifier = summary.identifier;
    const readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);

    const detailResult = LinearIssueDetailSchema.safeParse(JSON.parse(readOut));
    if (!detailResult.success) {
      console.warn(`[runner] Failed to validate lineark read for ${identifier}: ${detailResult.error.message}`);
      continue;
    }
    const full = detailResult.data;

    if (full.description.includes('design:')) {
      issues.push({
        id: full.id,
        identifier: full.identifier,
        title: full.title,
        description: full.description,
      });
    }
  }

  return issues;
}
```

**In `reconstructIssueFromRun()` (around line 247):**

```typescript
const detailResult = LinearIssueDetailSchema.safeParse(JSON.parse(readOut));
if (!detailResult.success) {
  throw new Error(`Failed to validate Linear issue for ${run.issue_key}: ${detailResult.error.message}`);
}
const linearIssue = detailResult.data;
```

### 4. Update `orchestrator/src/notify.ts` — GitHub CLI parsing

```typescript
import { GHPRListSchema, GHPRViewSchema } from './schemas.ts';

async function ghPRList(repo: string): Promise<GHPRListItem[]> {
  if (exitCode !== 0) return [];

  const parseResult = GHPRListSchema.safeParse(JSON.parse(out));
  if (!parseResult.success) {
    console.warn(`[notify] gh pr list validation failed for ${repo}: ${parseResult.error.message}`);
    return [];
  }
  return parseResult.data;
}

async function ghPRView(repo: string, prNumber: number): Promise<GHPRView | null> {
  if (exitCode !== 0) return null;

  const parseResult = GHPRViewSchema.safeParse(JSON.parse(out));
  if (!parseResult.success) {
    console.warn(`[notify] gh pr view validation failed for ${repo}#${prNumber}: ${parseResult.error.message}`);
    return null;
  }
  return parseResult.data;
}
```

### 5. Update `orchestrator/src/runner.ts` — Review polling and CI log parsing

**In `pollReviews()` (around line 983):**

```typescript
import { GHPRReviewPollSchema, GHRunListSchema } from './schemas.ts';

const pollResult = GHPRReviewPollSchema.safeParse(JSON.parse(ghOut));
if (!pollResult.success) continue;
const prData = pollResult.data;
```

**In `fetchCIFailureLogs()` (around line 430):**

```typescript
const listResult = GHRunListSchema.safeParse(JSON.parse(listOut));
if (!listResult.success) return 'Could not parse CI run list.';
const runs = listResult.data;
```

## Testing Strategy

- **Unit tests** in `orchestrator/src/schemas.test.ts`:
  - Test each schema with valid input → parses successfully
  - Test each schema with missing required fields → returns error
  - Test each schema with wrong types → returns error
  - Test `.passthrough()` works: extra fields don't cause validation failure
  - Test default values: missing optional fields get correct defaults

- **Snapshot tests**: Save actual CLI output samples as test fixtures and validate against schemas

- Run `bunx tsc --noEmit` to verify type correctness.
- Run `bun test` to verify all existing tests still pass.

## Out of Scope

- Validating the content/semantics of CLI output (e.g., that an issue ID is a valid ULID)
- Schema generation from CLI docs (manual maintenance)
- Migrating other JSON parsing (e.g., projects.json) to Zod — that's operator-controlled config
