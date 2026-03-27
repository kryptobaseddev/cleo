# T140: Session Summarization — Prompt + Structured Response

**Task**: T140
**Epic**: T134 (Brain Memory Automation)
**Status**: complete
**Date**: 2026-03-23

## What Was Implemented

### 1. `SessionSummaryInput` type in contracts

Added to `packages/contracts/src/session.ts`:
- `keyLearnings: string[]`
- `decisions: string[]`
- `patterns: string[]`
- `nextActions: string[]`

Exported from `packages/contracts/src/index.ts` and re-exported from `packages/contracts/src/operations/session.ts`.

### 2. Updated operation types

`packages/contracts/src/operations/session.ts`:
- `SessionEndParams.sessionSummary?: SessionSummaryInput` — optional structured input
- `SessionEndResult.memoryPrompt?: string` — optional prompt output (prompt mode)

### 3. `buildSummarizationPrompt()` in session-memory.ts

`packages/core/src/memory/session-memory.ts`:
- Takes `SummarizationPromptData` (tasksCompleted, decisionsRecorded, focusChanges, scope)
- Reads `brain.summarization.promptTemplate` from config if set (Handlebars-style `{{scope}}` tokens)
- Falls back to built-in template producing a `cleo observe "..."` command
- Provider-agnostic — just a string the agent can act on
- Never throws

### 4. `ingestStructuredSummary()` in session-memory.ts

`packages/core/src/memory/session-memory.ts`:
- Takes `SessionSummaryInput`, sessionId, projectRoot
- Creates brain observations for each non-empty item:
  - `keyLearnings` → type=`'discovery'`
  - `decisions` → type=`'decision'`
  - `patterns` → type=`'discovery'` (observations table; dedicated patterns table uses storePattern separately)
  - `nextActions` → type=`'change'`
- Uses existing `observeBrain()` — no raw SQL
- ALL errors accumulated in result.errors — never throws (best-effort contract)
- Returns `SessionMemoryResult`

### 5. Wired into `sessionEnd()` engine

`packages/cleo/src/dispatch/engines/session-engine.ts`:
- New signature: `sessionEnd(projectRoot, notes?, params?)`
- If `params.sessionSummary` present → fires `ingestStructuredSummary()` best-effort (no-await)
- Else if `brain.summarization.enabled` → builds `memoryPrompt` via `buildSummarizationPrompt()`
- Returns `{ sessionId, ended, memoryPrompt? }` — prompt only present when applicable

### 6. Domain handler threads `sessionSummary`

`packages/cleo/src/dispatch/domains/session.ts`:
- `session.end` case extracts `params.sessionSummary` and passes to engine

### 7. Exported from internal.ts

`packages/core/src/internal.ts`:
- `buildSummarizationPrompt`, `ingestStructuredSummary`, `SummarizationPromptData`, `SessionMemoryResult`

## Acceptance Criteria Verification

- [x] `SessionSummaryInput` exported from contracts
- [x] `buildSummarizationPrompt()` returns meaningful prompt
- [x] `ingestStructuredSummary()` creates brain observations
- [x] `memoryPrompt` field in session.end result when summarization enabled
- [x] Structured summary auto-ingested when passed in session.end params
- [x] TSDoc on all exports
- [x] Build passes (`pnpm run build` — clean)
- [x] Biome check clean (`pnpm biome check --write` — 0 issues)
- [x] Zero new test failures (26 failing tests are all pre-existing)

## Files Changed

- `packages/contracts/src/session.ts` — added `SessionSummaryInput`
- `packages/contracts/src/index.ts` — exported `SessionSummaryInput`
- `packages/contracts/src/operations/session.ts` — updated params/result types
- `packages/core/src/memory/session-memory.ts` — added `buildSummarizationPrompt`, `ingestStructuredSummary`, `SummarizationPromptData`
- `packages/cleo/src/dispatch/engines/session-engine.ts` — wired dual-mode into `sessionEnd()`
- `packages/cleo/src/dispatch/domains/session.ts` — threaded `sessionSummary` param
- `packages/core/src/internal.ts` — exported new symbols

## Provenance

@task T140
@epic T134
@why Enable automatic session knowledge capture without API keys
@what Dual-mode session summarization (prompt + structured) wired to session.end
