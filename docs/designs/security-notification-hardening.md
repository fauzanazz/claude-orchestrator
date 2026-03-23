# Security: Notification Command Injection Hardening

## Context

Security audit finding MEDIUM-1. `sendMacOSNotification` in `notify.ts` constructs an osascript command via string interpolation with inadequate escaping. Only double quotes are escaped, but characters like `$()`, backticks, backslashes, and single quotes pass through. PR titles are attacker-controlled (any GitHub user can create PRs or reviews), so this is a real injection vector.

## Requirements

- Eliminate command injection in macOS notifications
- PR titles and bodies must be safely handled regardless of content
- Notification functionality must be preserved (title + body text + clickable URL)
- Slack notification payloads must also be sanitized (defense in depth)

## Implementation

### 1. Rewrite `sendMacOSNotification` in `orchestrator/src/notify.ts`

Replace lines 127-138 with a safe implementation that avoids shell interpretation entirely:

```typescript
export function sendMacOSNotification(title: string, body: string, url: string): void {
  const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeBody = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  Bun.spawn(
    [
      'osascript',
      '-e',
      `display notification "${safeBody}" with title "${safeTitle}"`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  if (/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(url)) {
    Bun.spawn(['open', url], { stdout: 'pipe', stderr: 'pipe' });
  }
}
```

Key changes:
- Escape backslashes FIRST, then quotes (order matters for correct escaping)
- Validate URL against a strict pattern before passing to `open` (prevents `open` from executing arbitrary URLs/schemes)
- Still uses `Bun.spawn` with an args array (not shell execution), so the osascript string is the only interpretation layer

### 2. Add text truncation for notification content

PR titles can be very long. Add truncation to prevent notification overflow:

```typescript
function truncateForNotification(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function sendMacOSNotification(title: string, body: string, url: string): void {
  const safeTitle = truncateForNotification(title, 100)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeBody = truncateForNotification(body, 200)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  Bun.spawn(
    ['osascript', '-e', `display notification "${safeBody}" with title "${safeTitle}"`],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  if (/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(url)) {
    Bun.spawn(['open', url], { stdout: 'pipe', stderr: 'pipe' });
  }
}
```

### 3. Sanitize Slack payload text in `orchestrator/src/notify.ts`

In `sendSlackNotification` (line 144) and `sendFixExhaustedNotification` (line 205), Slack Block Kit fields use `mrkdwn` formatting. Attacker-controlled PR titles could inject Slack formatting or mention `@everyone`.

Add a sanitizer function at the top of notify.ts:

```typescript
function sanitizeForSlack(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

Apply it to all user-controlled fields in the Slack payloads. In `sendSlackNotification` around line 155:

```typescript
const payload = {
  blocks: [
    {
      type: 'header',
      text: {
        type: 'plain_text',  // plain_text is safe, but truncate
        text: truncateForNotification(`PR Ready to Merge: #${pr.prNumber}`, 150),
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
  ],
};
```

Apply the same pattern to `sendFixExhaustedNotification`.

## Testing Strategy

- **Unit tests** in `orchestrator/src/notify.test.ts`:
  - `sendMacOSNotification('title with "quotes"', 'body', url)` — verify escaping
  - `sendMacOSNotification('$(whoami)', 'body', url)` — verify `$()` doesn't execute
  - `sendMacOSNotification('title', 'body', 'javascript:alert(1)')` — verify URL rejected
  - `sendMacOSNotification('title', 'body', 'https://github.com/owner/repo/pull/1')` — verify URL accepted
  - `sanitizeForSlack('<script>@everyone</script>')` → `&lt;script&gt;@everyone&lt;/script&gt;`
  - `truncateForNotification('a'.repeat(200), 100)` → 100 chars ending in `...`

- Run `bunx tsc --noEmit` to verify type correctness.

## Out of Scope

- Replacing osascript with a different notification mechanism (e.g., terminal-notifier)
- Notification preferences (mute, DND schedules)
- Slack webhook URL validation
