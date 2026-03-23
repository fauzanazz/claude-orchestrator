# Security: Input Validation for Issue Metadata & Init Commands

## Context

Security audit finding HIGH-1 (shell injection in init.ts), HIGH-2 (path traversal via designPath), and LOW-5 (unsanitized slug in submit.sh). Issue metadata extracted from Linear descriptions is used to read files, checkout branches, and determine target repos with no validation. Init commands are passed through `sh -c` which enables shell injection.

## Requirements

- Validate `designPath` from issue metadata: must start with `docs/designs/`, contain no `..` segments, and end with `.md`
