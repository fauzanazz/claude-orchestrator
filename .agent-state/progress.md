# Progress: Linear Project Schema + Auto-create + Auto-assign (FAU-9)

## Status: Complete

All 10 features implemented and committed in `43619f9`.

## What was accomplished

1. **TypeScript type** (`types.ts`): Added optional `linearProject?: string` to `ProjectConfig`
2. **init-project.sh**:
   - `--linear-project <name>` flag with validation
   - Help text updated
   - Auto-create/reuse Linear Project step (Step 6) between push and registration
   - Writes `linearProject` to `projects.json` via jq
   - Summary output includes Linear project name
   - Failure is a warning, not fatal — init continues without it
3. **submit.sh**:
   - Reads `linearProject` from `projects.json` config
   - Conditionally passes `--project` flag to `lineark issues create`
   - Success output includes Linear project name
4. **Backward compatibility**: Entries without `linearProject` use `// empty` in jq, producing no `--project` flag

## What's left to do

Nothing — all features from the design doc are implemented.

## Decisions made

- Linear Project creation failure is a warning (non-fatal) per design doc
- Default project name falls back to `$PROJECT_NAME` when `--linear-project` not specified
- Used `jq -r '// empty'` pattern for backward-compatible optional field reads in submit.sh

## Tests

- 82/84 tests pass; 2 errors are pre-existing (missing `zod` and `@google/genai` packages)
- TypeScript type errors are all pre-existing (Bun types not recognized by vanilla `tsc`)
- No new test failures introduced
