# Skill: Writing Agent-Friendly Design Docs

## Structure

Every design doc should have these sections:

**Title** — one line, matches the Linear issue title.

**Context** — why this is being built. One paragraph. Reference the ticket or user need.

**Requirements** — bulleted list of what the feature must do. Functional only; no implementation yet.

**Implementation** — the core section. Must include:
- Exact file paths for every file to create or modify
- Function signatures with parameter types and return types
- Data shapes (TypeScript interfaces, JSON examples, or SQL schema fragments)
- Sequence of operations for non-trivial flows

**Testing strategy** — what to run to verify correctness. Name specific test files or commands.

**Out of scope** — explicitly list what this doc does NOT cover. Prevents scope creep.

---

## Principles

**Be specific about file paths.** Write `src/api/routes/auth.ts`, not "the auth handler". The agent
has no implicit knowledge of the project layout.

**Include data shapes.** If a function returns an object, show its shape. If a route accepts a body,
show the expected JSON. Ambiguous shapes cause wrong implementations.

**Reference existing patterns.** If the project already has a pattern for error handling, middleware
registration, or database access — name the file where it lives. The agent will follow it.

**One doc = one issue = ~30 min of work.** If implementation would take longer, split the doc.
A focused doc produces a focused, reviewable PR.

**Write for cold context.** The agent reads your doc and nothing else. No Slack threads, no prior
conversations. Every assumption you don't write down will be guessed wrong.

---

## Anti-patterns

- **Vague instructions**: "Add auth to the dashboard" — add what kind of auth, to which routes, using which middleware?
- **Mixed features**: one doc covering login, logout, session refresh, and token rotation is four docs.
- **Missing data shapes**: "return the user object" — which fields? Is `password` included?
- **Assumed context**: "follow the pattern we discussed" — the agent wasn't in that meeting.
- **No file paths**: "create a new utility" — where? What module? Exported how?
