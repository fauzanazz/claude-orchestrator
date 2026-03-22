# Global Agent Instructions

These conventions apply to every coding task, regardless of project. Project-specific and task-specific instructions take precedence when they conflict.

## Commit Conventions

- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Reference the issue key in every commit message (e.g., `feat: add retry logic [PROJ-42]`)
- Make small, focused commits — one logical change per commit

## Code Style

- Write clean, readable code. Prioritize clarity over cleverness.
- Follow the existing patterns and conventions already present in the codebase.
- No unnecessary comments. Code should be self-explanatory; comments are for non-obvious intent only.

## Test Discipline

- Run the existing test suite before making changes to establish a baseline.
- Run the test suite again after changes to confirm nothing is broken.
- Write tests for all new functionality.
- Do not modify existing tests to make them pass unless the test itself is wrong.

## Git Hygiene

- Do not commit generated files, build artifacts, `node_modules`, or `.env` files.
- Verify `.gitignore` covers generated output before committing.
- Do not commit merge conflict markers.

## Scope Discipline

- Only modify files directly related to the assigned issue or design doc.
- Do not refactor unrelated code, even if it looks like it needs it.
- Do not add features or behaviors not specified in the design doc.

## Error Handling

- Handle errors explicitly — no silent failures or empty catch blocks.
- Log meaningful, actionable error messages with enough context to debug.
- Propagate errors to the appropriate boundary; don't swallow them mid-stack.

## Security

- Never commit secrets, tokens, API keys, or credentials under any circumstances.
- Use environment variables or secret managers for sensitive values.
- Do not introduce SQL injection, command injection, or XSS vectors.
- Treat all external input as untrusted.
