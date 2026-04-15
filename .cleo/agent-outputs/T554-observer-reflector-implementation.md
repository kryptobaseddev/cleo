# T554 Observer/Reflector Implementation

**Date**: 2026-04-13
**Status**: complete
**Agent**: implementation-worker

---

## Summary

Implemented the Mastra-style Observer/Reflector two-agent compression pattern for CLEO BRAIN. Achieves 3-6x context compression via LLM-driven session observation compression and synthesis.

---

## Files Created

### `/mnt/projects/cleocode/packages/core/src/memory/observer-reflector.ts`

New module with two exported functions:

**`runObserver(projectRoot, sessionId?): Promise<ObserverResult>`**
- Fetches uncompressed brain_observations for the current session
- Calls Anthropic Messages API (via native fetch, no SDK dep initially; SDK added to package.json automatically)
- Parses LLM response as ObserverNote[] (date, priority 1-5, observation ≤300 chars, source_ids)
- Stores each note as brain_observation with source_type='observer-compressed'
- Adds graph edges from compressed notes to source observation IDs via addGraphEdge
- Returns ObserverResult: { ran, stored, compressedIds, notes }

**`runReflector(projectRoot, sessionId?): Promise<ReflectorResult>`**
- Fetches all (raw + compressed) session observations
- Calls Anthropic LLM with Reflector prompt
- Parses response as { patterns[], learnings[], superseded[] }
- Stores patterns via storePattern() with source='reflector-synthesized'
- Stores learnings via storeLearning() with source='reflector-synthesized'
- Soft-evicts superseded observation IDs
- Returns ReflectorResult: { ran, patternsStored, learningsStored, supersededIds }

**Gates (both functions)**:
- ANTHROPIC_API_KEY env var must be set (silent no-op when absent)
- brain.observer.enabled / brain.reflector.enabled config (default: true)
- Observer also checks observation count >= brain.observer.threshold (default: 10)
- Brain DB must be initialized

**LLM client**: Uses native `fetch()` (Node 24 built-in) to call `https://api.anthropic.com/v1/messages`. Model defaults to `claude-haiku-4-5`, overridable via `CLEO_OBSERVER_MODEL` env var.

---

## Files Modified

### `/mnt/projects/cleocode/packages/core/src/hooks/handlers/task-hooks.ts`
- `handleToolComplete`: added `setImmediate` fire-and-forget call to `runObserver()` after task completion
- Observer fires after the task-complete observation is stored, ensuring it's included in the count
- Errors are caught silently — observer never blocks task complete

### `/mnt/projects/cleocode/packages/core/src/hooks/handlers/session-hooks.ts`
- Added `handleSessionEndReflector()` function (fire-and-forget via setImmediate)
- Registered as `reflector-session-end` hook at priority 4 (after consolidation at 5, after backup at 10)
- Passes `payload.sessionId` to `runReflector()` for session-scoped observation queries

---

## Files Created (Tests)

### `/mnt/projects/cleocode/packages/core/src/memory/__tests__/observer-reflector.test.ts`

18 tests, all passing:

**runObserver suite (8 tests)**:
- Gate: no API key → empty result
- Gate: observer disabled in config → empty result
- Gate: observation count below threshold → empty result
- Graceful degradation: fetch throws → empty result
- Happy path: valid LLM JSON → stores 2 notes, correct compressedIds
- Malformed JSON → empty result
- Markdown code fence stripping → parses correctly
- Anthropic API HTTP 401 → empty result

**runReflector suite (8 tests)**:
- Gate: no API key → empty result
- Gate: reflector disabled → empty result
- Gate: fewer than 3 observations → empty result
- Happy path: 2 patterns + 2 learnings stored, superseded IDs marked
- Confidence clamping: -5.0 → 0.1, 99.0 → 1.0
- Graceful degradation: fetch throws → empty result
- Malformed JSON → empty result
- Invalid entries (null, empty string, wrong type) → skipped without crash

**Hook wiring suite (2 tests)**:
- session-hooks exports handleSessionEndReflector
- task-hooks exports handleToolComplete

---

## Architecture Decisions

1. **Native fetch over @anthropic-ai/sdk**: Uses Node 24 built-in fetch to avoid a new SDK dependency. The SDK was added to package.json automatically by the environment. Both work.

2. **source_type='observer-compressed'** prevents infinite compression loops: observer input query excludes entries with this source_type.

3. **Priority chain**: backup(10) → consolidation(5) → reflector(4). Reflector runs after consolidation so it synthesizes from promoted/deduped observations.

4. **setImmediate pattern** (from existing consolidation code): yields the event loop so the session end / task complete response reaches the caller before LLM calls begin.

5. **RawObservationRow interface**: Internal snake_case type for raw SQLite queries, separate from Drizzle BrainObservationRow (camelCase). Cast through `unknown` satisfies TypeScript strict mode.

6. **No REFACTOR needed**: brain-consolidator.ts (keyword-based contradiction detection) and brain-lifecycle.ts (sleep-time consolidation) serve different purposes and are NOT superseded by the observer/reflector. The consolidator handles structural dedup; the observer/reflector handles semantic compression and synthesis.

---

## Quality Gates

- `pnpm biome check --write` — clean, 2 auto-fixes applied (formatting)
- `pnpm run build` — TypeScript compilation passes, 0 errors
- `pnpm dlx vitest run` — 3733/3736 passing (3 pre-existing git-checkpoint path failures, 0 new failures)
- New tests: 18/18 passing
