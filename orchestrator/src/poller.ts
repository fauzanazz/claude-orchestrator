import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, errorMsg } from './logger.ts';
import { resolveProject } from './config.ts';
import { hasAnyRunForIssue } from './db.ts';
import { validateDesignPath, validateBranch, validateRepo } from './validate.ts';
import { LinearIssueListSchema, LinearIssueDetailSchema } from './schemas.ts';
import { chunkArray } from './runner.ts';
import type {
  Run,
  Issue,
  LinearIssue,
  ParsedIssueMetadata,
} from './types.ts';

// ---------------------------------------------------------------------------
// Linear API rate limiter (shared across lineark CLI + direct GraphQL calls)
// Linear allows 30 requests per 60s — we stay under with a 25-req budget.
// ---------------------------------------------------------------------------

export const linearCallTimestamps: number[] = [];
const LINEAR_RATE_LIMIT = 25;
const LINEAR_RATE_WINDOW_MS = 60_000;

async function waitForLinearRateLimit(): Promise<void> {
  const now = Date.now();
  // Evict timestamps outside the window
  while (linearCallTimestamps.length > 0 && linearCallTimestamps[0]! < now - LINEAR_RATE_WINDOW_MS) {
    linearCallTimestamps.shift();
  }
  if (linearCallTimestamps.length >= LINEAR_RATE_LIMIT) {
    const waitMs = linearCallTimestamps[0]! + LINEAR_RATE_WINDOW_MS - now + 100;
    log.debug(`[runner] Linear rate limit: waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return waitForLinearRateLimit();
  }
  linearCallTimestamps.push(Date.now());
}

// ---------------------------------------------------------------------------
// Linear interaction
// ---------------------------------------------------------------------------

const LINEARK_MAX_RETRIES = 3;

async function runLineark(args: string[]): Promise<string> {
  for (let attempt = 0; attempt <= LINEARK_MAX_RETRIES; attempt++) {
    await waitForLinearRateLimit();

    const proc = Bun.spawn(['lineark', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [rawOut, errText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return rawOut;

    if ((errText.includes('RATELIMITED') || errText.includes('429')) && attempt < LINEARK_MAX_RETRIES) {
      const jitter = Math.floor(Math.random() * 2000);
      const backoffMs = 2000 * 2 ** attempt + jitter; // ~2-4s, ~4-6s, ~8-10s
      log.warn(`[runner] lineark rate-limited, retry ${attempt + 1}/${LINEARK_MAX_RETRIES} in ${(backoffMs / 1000).toFixed(1)}s`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      continue;
    }

    throw new Error(`lineark ${args[0]} failed (exit ${exitCode}): ${errText.trim()}`);
  }
  throw new Error(`lineark ${args[0]} failed after ${LINEARK_MAX_RETRIES} retries`);
}

// lineark doesn't include the parent field in `issues read` output, so we
// query the Linear GraphQL API directly to resolve parent relationships.
async function fetchLinearParent(issueId: string): Promise<{ id: string; identifier: string } | null> {
  const tokenPath = join(process.env.HOME ?? '~', '.linear_api_token');
  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    log.debug(`[runner] Linear API token not found at ${tokenPath} — skipping parent lookup`);
    return null;
  }

  try {
    await waitForLinearRateLimit();
    const resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        query: `query ($id: String!) { issue(id: $id) { parent { id identifier } } }`,
        variables: { id: issueId },
      }),
    });
    const json = await resp.json() as { data?: { issue?: { parent?: { id: string; identifier: string } | null } } };
    return json.data?.issue?.parent ?? null;
  } catch (err) {
    log.warn(`[runner] Failed to fetch parent for issue ${issueId}: ${errorMsg(err)}`);
    return null;
  }
}

export async function pollLinear(): Promise<LinearIssue[]> {
  // Step 1: List issues (lean output — has identifier + state but no id/description)
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

  // Filter to actionable states: "Ready for Agent" (new work) or "In Progress" (orphaned after restart)
  const ready = summaries.filter((s) => s.state === 'Ready for Agent' || s.state === 'In Progress');
  if (ready.length === 0) return [];

  clearParentStateCache();

  // Step 2: Fetch full details concurrently (3 at a time to stay within rate limits)
  const POLL_CONCURRENCY = 3;
  const chunks = chunkArray(ready, POLL_CONCURRENCY);
  const issues: LinearIssue[] = [];

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (summary): Promise<LinearIssue | null> => {
        const identifier = summary.identifier;

        let readOut: string;
        try {
          readOut = await runLineark(['issues', 'read', identifier, '--format', 'json']);
        } catch (err) {
          log.warn(`[runner] lineark read failed for ${identifier}: ${errorMsg(err)}`);
          return null;
        }

        let detailJson: unknown;
        try {
          detailJson = JSON.parse(readOut);
        } catch {
          log.warn(`[runner] lineark read for ${identifier} returned invalid JSON`);
          return null;
        }

        const detailResult = LinearIssueDetailSchema.safeParse(detailJson);
        if (!detailResult.success) {
          log.warn(`[runner] Failed to validate lineark read for ${identifier}: ${detailResult.error.message}`);
          return null;
        }
        const full = detailResult.data;

        if (!full.description.includes('design:') && !(full.description.includes('branch:') && full.description.includes('repo:'))) {
          return null;
        }

        // "In Progress" issues are only re-picked if the orchestrator previously ran them
        // (orphaned after crash). Issues manually moved to "In Progress" are skipped.
        if (summary.state === 'In Progress' && !hasAnyRunForIssue(full.id)) {
          log.info(`[runner] Skipping ${identifier} — "In Progress" but no prior run (manually moved?)`);
          return null;
        }

        // lineark doesn't return parent — fetch from Linear API directly
        const parent = await fetchLinearParent(full.id);
        if (parent?.identifier) {
          const done = await isParentDone(parent.identifier);
          if (!done) {
            log.info(`[runner] Skipping ${identifier}: parent ${parent.identifier} not done yet`);
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

    for (const result of results) {
      if (result) issues.push(result);
    }
  }

  return issues;
}

export function parseIssueMetadata(description: string): ParsedIssueMetadata | null {
  // Try structured format first (from submit.sh): "design: ...\nbranch: ...\nrepo: ..."
  const designMatch = description.match(/^design:\s*(.+)$/im);
  const branchMatch = description.match(/^branch:\s*(.+)$/im);
  const repoMatch = description.match(/^repo:\s*(.+)$/im);

  const designPath = designMatch?.[1]?.trim();
  const branch = branchMatch?.[1]?.trim();
  const repo = repoMatch?.[1]?.trim();

  // Branch and repo are always required
  if (branch && repo) {
    try {
      return {
        designPath: designPath ? validateDesignPath(designPath) : null,
        branch: validateBranch(branch),
        repo: validateRepo(repo),
      };
    } catch (err) {
      log.warn(`[runner] parseIssueMetadata: validation failed: ${errorMsg(err)}`);
      return null;
    }
  }

  // Fallback: extract from prose-style descriptions
  const proseDesign = description.match(/design\s*doc:\s*([\w/._-]+\.md)/i);
  const proseBranch = description.match(/branch\s+([\w/\-]+(?:\/[\w/\-]+)*)/i);
  const proseRepo = description.match(/repo:\s*([\w/._-]+)/i)
    ?? description.match(/repo[.:]?\s*([\w-]+\/[\w._-]+)/i);

  const pd = proseDesign?.[1]?.trim();
  const pb = proseBranch?.[1]?.trim();
  const pr = proseRepo?.[1]?.trim();

  if (!pb || !pr) return null;

  try {
    return {
      designPath: pd ? validateDesignPath(pd) : null,
      branch: validateBranch(pb),
      repo: validateRepo(pr),
    };
  } catch (err) {
    log.warn(`[runner] parseIssueMetadata: validation failed: ${errorMsg(err)}`);
    return null;
  }
}

export function updateLinearStatus(key: string, state: string): void {
  // Fire and forget — but record the call in the rate limiter
  linearCallTimestamps.push(Date.now());
  Bun.spawn(['lineark', 'issues', 'update', key, '-s', state], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export function commentOnIssue(key: string, message: string): void {
  // Fire and forget — but record the call in the rate limiter
  linearCallTimestamps.push(Date.now());
  Bun.spawn(['lineark', 'comments', 'create', key, '--body', message], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

// ---------------------------------------------------------------------------
// Parent dependency checking
// ---------------------------------------------------------------------------

const parentStateCache = new Map<string, string>();

function clearParentStateCache(): void {
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
    log.warn(`[runner] Failed to read state for ${identifier}`);
    return null;
  }
}

async function isParentDone(parentIdentifier: string): Promise<boolean> {
  const state = await getIssueState(parentIdentifier);
  if (!state) return false; // can't determine — safe to block

  const doneStates = ['done', 'canceled', 'cancelled'];
  return doneStates.includes(state.toLowerCase());
}

// ---------------------------------------------------------------------------
// Issue reconstruction (from DB run record via Linear)
// ---------------------------------------------------------------------------

export async function reconstructIssueFromRun(run: Run): Promise<Issue> {
  const readOut = await runLineark(['issues', 'read', run.issue_key, '--format', 'json']);

  let detailJson: unknown;
  try {
    detailJson = JSON.parse(readOut);
  } catch {
    throw new Error(`lineark read for ${run.issue_key} returned invalid JSON`);
  }
  const detailResult = LinearIssueDetailSchema.safeParse(detailJson);
  if (!detailResult.success) {
    throw new Error(`Failed to validate Linear issue for ${run.issue_key}: ${detailResult.error.message}`);
  }
  const linearIssue = detailResult.data;

  const meta = parseIssueMetadata(linearIssue.description);
  if (!meta) {
    throw new Error(`Could not parse issue metadata from ${run.issue_key} description`);
  }

  const resolved = resolveProject(meta.repo);
  if (!resolved) {
    throw new Error(`Project not found for repo: ${meta.repo}`);
  }

  const parent = await fetchLinearParent(linearIssue.id);

  return {
    id: linearIssue.id,
    key: run.issue_key,
    title: run.issue_title,
    description: linearIssue.description,
    designPath: meta.designPath,
    branch: meta.branch,
    repo: meta.repo,
    baseBranch: resolved.project.baseBranch,
    parentKey: parent?.identifier ?? null,
  };
}
