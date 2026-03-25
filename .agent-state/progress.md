# Progress — AI First-Pass Review Gate (FAU-54)

## Accomplished

All requirements from the design doc have been implemented:

1. **Config flags** (`config.ts`): Added `autoReview` (opt-in via `AUTO_REVIEW=true`) and `autoReviewModel` (defaults to `gemini-2.0-flash`)
2. **Review gate module** (`review-gate.ts`): New module with `reviewRun()` (calls Gemini to review diff against design doc) and `formatReviewFeedback()` (formats results as markdown)
3. **Runner integration** (`runner.ts`): Review gate runs after successful PR creation/update, before memory documentation
4. **Loop prevention**: Skipped for fix runs (`is_fix`), revision runs (`is_revision`), and retry runs (`retry_attempt > 0`)
5. **PR comment**: On failure, posts formatted feedback as a PR comment
6. **Auto-revision**: On failure, enqueues a revision run via existing `enqueueRevision()`
7. **Tests** (`review-gate.test.ts`): 6 tests covering all `formatReviewFeedback()` branches — all passing

## What's Left

Nothing — all features from the design doc are implemented and tested.

## Decisions

- Placed the review gate after the SSE broadcast but before memory documentation, so the run is already marked successful before the review runs
- Used the same Gemini API pattern as `memory.ts` (`GoogleGenAI` from `@google/genai`)
- Used `responseMimeType: 'application/json'` for structured JSON output from Gemini
- Reused existing `enqueueRevision()` and `commentOnPR()` functions — no new abstractions needed
- Fail-safe: all error paths return `{ pass: true }` to avoid blocking PRs on review failures

## Blockers

None.
