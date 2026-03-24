# Global Agent Instructions

These conventions apply to every coding task. Project-specific and task-specific instructions take precedence.

## Commit Conventions

- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Reference the issue key in every commit message (e.g., `feat: add retry logic [PROJ-42]`)
- Make small, focused commits — one logical change per commit

## Scope Discipline

- Only modify files directly related to the assigned issue or design doc.
- Do not refactor unrelated code, even if it looks like it needs it.
- Do not add features or behaviors not specified in the task specification.

## Git Hygiene

- Do not commit generated files, build artifacts, `node_modules`, or `.env` files.
- Do not commit merge conflict markers.
- Never commit secrets, tokens, API keys, or credentials.
