# Security: Input Validation for Issue Metadata & Init Commands

## Context

Security audit finding HIGH-1 (shell injection in init.ts), HIGH-2 (path traversal via designPath), and LOW-5 (unsanitized slug in submit.sh). Issue metadata extracted from Linear descriptions is used to read files, checkout branches, and determine target repos with no validation. Init commands are passed through `sh -c` which enables shell injection.

## Requirements

- Validate `designPath` from issue metadata: must start with `docs/designs/`, contain no `..` segments, and end with `.md`
- Validate init commands: allowlist known-safe commands (e.g. `bun install`, `npm ci`); for custom commands, reject shell metacharacters, null bytes, and control characters; execute via direct spawn (no `sh -c`)
- Sanitize issue slug/identifier: validate branch names, repo identifiers, and other metadata fields against strict patterns to prevent injection into git commands and file paths
