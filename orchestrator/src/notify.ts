import { config } from './config.ts';
import { isPRNotified, markPRNotified, clearPRNotified } from './db.ts';
import { log, errorMsg } from './logger.ts';
import { loadProjects } from './config.ts';
import { GHPRListSchema, GHPRViewSchema, type GHPRListItem, type GHPRView } from './schemas.ts';
import type { PRMergeStatus } from './types.ts';

export type { GHPRView };

async function ghPRList(repo: string): Promise<GHPRListItem[]> {
  const proc = Bun.spawn(
    ['gh', 'pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) return [];

  try {
    const parseResult = GHPRListSchema.safeParse(JSON.parse(out));
    if (!parseResult.success) {
      log.warn(`[notify] gh pr list validation failed for ${repo}: ${parseResult.error.message}`);
      return [];
    }
    return parseResult.data;
  } catch {
    return [];
  }
}

async function ghPRView(repo: string, prNumber: number): Promise<GHPRView | null> {
  const proc = Bun.spawn(
    [
      'gh', 'pr', 'view', String(prNumber),
      '--repo', repo,
      '--json', 'number,title,url,headRefName,reviewDecision,mergeable,statusCheckRollup,commits,reviews,comments',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) return null;

  try {
    const parseResult = GHPRViewSchema.safeParse(JSON.parse(out));
    if (!parseResult.success) {
      log.warn(`[notify] gh pr view validation failed for ${repo}#${prNumber}: ${parseResult.error.message}`);
      return null;
    }
    return parseResult.data;
  } catch {
    return null;
  }
}

export function checkMergeReady(pr: GHPRView, repo: string): PRMergeStatus {
  const checks = (pr.statusCheckRollup ?? []).map((c) => ({
    name: c.name,
    conclusion: c.conclusion ?? c.status,
  }));

  const hasChecks = checks.length > 0;
  const allChecksPassed = checks.every((c) =>
    ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion?.toUpperCase() ?? ''),
  );

  // Find the latest commit timestamp
  const commitDates = (pr.commits ?? [])
    .map((c) => new Date(c.committedDate).getTime())
    .filter((t) => !isNaN(t));
  const latestCommitTime = commitDates.length > 0 ? Math.max(...commitDates) : 0;

  // Check for review comments posted after the latest push
  const hasCommentsAfterPush = latestCommitTime > 0 && [
    ...(pr.reviews ?? [])
      .filter((r) => r.author?.login !== config.githubUsername)
      .filter((r) => (r.body ?? '').trim().length > 0)
      .map((r) => new Date(r.submittedAt).getTime()),
    ...(pr.comments ?? [])
      .filter((c) => c.author?.login !== config.githubUsername)
      .map((c) => new Date(c.createdAt).getTime()),
  ].some((t) => !isNaN(t) && t > latestCommitTime);

  return {
    repo,
    prNumber: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.headRefName,
    reviewDecision: pr.reviewDecision ?? '',
    checks,
    isReady: hasChecks && allChecksPassed && !hasCommentsAfterPush,
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function truncateForNotification(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function sanitizeForSlack(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// macOS notification
// ---------------------------------------------------------------------------

export function sendMacOSNotification(title: string, body: string, url: string): void {
  const safeTitle = truncateForNotification(title, 100);
  const safeBody = truncateForNotification(body, 200);

  // Use terminal-notifier for clickable notifications that open the URL on click.
  // Falls back to osascript if terminal-notifier is not installed.
  const proc = Bun.spawnSync(['which', 'terminal-notifier'], { stdout: 'pipe', stderr: 'pipe' });

  if (proc.exitCode === 0) {
    Bun.spawn(
      [
        'terminal-notifier',
        '-title', safeTitle,
        '-message', safeBody,
        '-open', url,
        '-sound', 'default',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  } else {
    // Fallback: osascript notification (no click-to-open support)
    const escapedTitle = safeTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedBody = safeBody.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    Bun.spawn(
      [
        'osascript', '-e',
        `display notification "${escapedBody}" with title "${escapedTitle}"`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    // Only open validated GitHub PR URLs
    if (/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(url)) {
      Bun.spawn(['open', url], { stdout: 'pipe', stderr: 'pipe' });
    }
  }
}

// ---------------------------------------------------------------------------
// Slack notification (Block Kit)
// ---------------------------------------------------------------------------

async function sendSlackNotification(pr: PRMergeStatus): Promise<void> {
  if (!config.slackWebhookUrl) return;

  const checksText = pr.checks.length > 0
    ? pr.checks.map((c) => `${c.conclusion === 'SUCCESS' ? 'Pass' : sanitizeForSlack(c.conclusion)}: ${sanitizeForSlack(c.name)}`).join('\n')
    : 'No checks';

  const reviewText = pr.reviewDecision
    ? pr.reviewDecision.replace(/_/g, ' ').toLowerCase()
    : 'none';

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `PR Ready to Merge: #${pr.prNumber}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Title*\n${sanitizeForSlack(pr.title)}` },
          { type: 'mrkdwn', text: `*Repo*\n${sanitizeForSlack(pr.repo)}` },
          { type: 'mrkdwn', text: `*Branch*\n\`${sanitizeForSlack(pr.branch)}\`` },
          { type: 'mrkdwn', text: `*Review*\n${sanitizeForSlack(reviewText)}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*CI Status*\n\`\`\`${checksText}\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View PR' },
            url: pr.url,
            style: 'primary',
          },
        ],
      },
    ],
  };

  try {
    const resp = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      log.warn(`[notify] Slack webhook returned ${resp.status}: ${await resp.text().catch(() => '(no body)')}`);
    }
  } catch (err) {
    log.warn(`[notify] Slack webhook failed: ${errorMsg(err)}`);
  }
}

interface FixExhaustedOpts {
  repo: string;
  prNumber: number;
  title: string;
  url: string;
  fixType: string;
  attempts: number;
}

export async function sendFixExhaustedNotification(opts: FixExhaustedOpts): Promise<void> {
  const { repo, prNumber, title, url, fixType, attempts } = opts;
  const typeLabel = fixType === 'merge_conflict' ? 'Merge Conflict' : 'CI Failure';

  sendMacOSNotification(
    `Fix Exhausted: ${typeLabel}`,
    `PR #${prNumber}: ${title} — ${attempts} attempts failed`,
    url,
  );

  if (!config.slackWebhookUrl) return;

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Fix Attempts Exhausted: PR #${prNumber}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Title*\n${sanitizeForSlack(title)}` },
          { type: 'mrkdwn', text: `*Repo*\n${sanitizeForSlack(repo)}` },
          { type: 'mrkdwn', text: `*Fix Type*\n${sanitizeForSlack(typeLabel)}` },
          { type: 'mrkdwn', text: `*Attempts*\n${attempts}/${config.maxFixRetries}` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View PR' },
            url,
            style: 'danger',
          },
        ],
      },
    ],
  };

  try {
    const resp = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      log.warn(`[notify] Slack fix-exhausted webhook returned ${resp.status}: ${await resp.text().catch(() => '(no body)')}`);
    }
  } catch (err) {
    log.warn(`[notify] Slack fix-exhausted webhook failed: ${errorMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Shared PR status fetching
// ---------------------------------------------------------------------------

function createSemaphore(max: number) {
  let current = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire() {
      if (current < max) { current++; return; }
      await new Promise<void>(resolve => queue.push(resolve));
      current++;
    },
    release() {
      current--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

export async function fetchAllPRStatuses(): Promise<Map<string, GHPRView[]>> {
  const projects = loadProjects();
  const result = new Map<string, GHPRView[]>();

  // Collect unique, non-empty repos
  const uniqueRepos = [...new Set(
    Object.values(projects)
      .map((p) => p.repo)
      .filter((r): r is string => !!r),
  )];

  const sem = createSemaphore(5);

  // Parallelize ghPRList across all unique repos
  const repoResults = await Promise.allSettled(
    uniqueRepos.map(async (repo) => {
      await sem.acquire();
      let openPRs: GHPRListItem[];
      try {
        openPRs = await ghPRList(repo);
      } finally {
        sem.release();
      }

      // Parallelize ghPRView calls within this repo
      const prViewResults = await Promise.allSettled(
        openPRs.map(async ({ number: prNumber }) => {
          await sem.acquire();
          try {
            return await ghPRView(repo, prNumber);
          } finally {
            sem.release();
          }
        }),
      );

      const prViews: GHPRView[] = [];
      for (const r of prViewResults) {
        if (r.status === 'fulfilled' && r.value) prViews.push(r.value);
      }

      return { repo, prViews };
    }),
  );

  repoResults.forEach((settled, i) => {
    if (settled.status === 'rejected') {
      log.error(`[notify] Error fetching PRs for ${uniqueRepos[i] ?? 'unknown'}:`, settled.reason);
      return;
    }
    const { repo, prViews } = settled.value;
    if (prViews.length > 0) {
      result.set(repo, prViews);
    }
  });

  return result;
}

export function checkFixNeeded(pr: GHPRView): { fixType: 'merge_conflict' | 'ci_failure' } | null {
  // Check for merge conflicts
  if (pr.mergeable === 'CONFLICTING') {
    return { fixType: 'merge_conflict' };
  }

  // Check for CI failures
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length > 0) {
    const hasFailure = checks.some((c) => {
      const conclusion = (c.conclusion ?? c.status ?? '').toUpperCase();
      return conclusion === 'FAILURE' || conclusion === 'ERROR';
    });
    if (hasFailure) {
      return { fixType: 'ci_failure' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main poller
// ---------------------------------------------------------------------------

export async function pollMergeReadiness(prStatuses?: Map<string, GHPRView[]>): Promise<void> {
  const allStatuses = prStatuses ?? await fetchAllPRStatuses();

  for (const [repo, prs] of allStatuses) {
    for (const prData of prs) {
      const status = checkMergeReady(prData, repo);
      const alreadyNotified = isPRNotified(repo, prData.number);

      if (status.isReady && !alreadyNotified) {
        log.info(`[notify] PR #${prData.number} in ${repo} is merge-ready`);

        sendMacOSNotification(
          'PR Ready to Merge',
          `#${prData.number}: ${status.title} (${repo})`,
          status.url,
        );

        await sendSlackNotification(status);
        markPRNotified(repo, prData.number);

      } else if (!status.isReady && alreadyNotified) {
        log.info(`[notify] PR #${prData.number} in ${repo} is no longer merge-ready, clearing notification state`);
        clearPRNotified(repo, prData.number);
      }
    }
  }
}
