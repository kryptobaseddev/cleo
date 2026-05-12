# T1326 — classifier↔registry contract

**Status**: complete  
**Commit**: ab465b87c58d1a7ac9a3f4925e2ca3a43a060629  
**Branch**: task/T1326  
**Epic**: T1323

## Summary

Implemented the classifier↔registry contract per Council 2026-04-24 FP atomic truth #3: the classifier output space MUST be a strict subset of the registry input space.

## Changes

### packages/contracts/src/errors.ts
- Added `ClassifierUnregisteredAgentError` class
  - `code = 'E_CLASSIFIER_UNREGISTERED_AGENT'`
  - `exitCode = ExitCode.SPAWN_VALIDATION_FAILED` (63)
  - Constructor: `(emittedAgentId: string, registeredIds: readonly string[])`
  - Message includes fix-hint listing all valid agent IDs

### packages/contracts/src/index.ts
- Exported `ClassifierUnregisteredAgentError` from errors.js

### packages/core/src/orchestration/classify.ts
- Added `getRegisteredAgentIds(): readonly string[]`
  - Derives vocabulary from `CLASSIFIER_RULES` agentIds + `CLASSIFY_FALLBACK_AGENT_ID`
  - Vocabulary and rules always in sync (no separate list to maintain)
- Added `ClassifyOptions` interface with optional `allowedAgentIds` override
- Updated `classifyTask(task, opts?)` signature
  - Validates resolved agentId against `opts.allowedAgentIds ?? getRegisteredAgentIds()`
  - Throws `ClassifierUnregisteredAgentError` if emitted ID is absent
  - Both persona and fallback (cleo-subagent) paths validated

### packages/core/src/orchestration/index.ts
- Exported `ClassifyOptions` type and `getRegisteredAgentIds` function

### packages/core/src/orchestration/__tests__/classify.test.ts
- Added `getRegisteredAgentIds` test suite (3 tests): vocabulary correctness, canonical personas, no unknown IDs
- Added `classifyTask — registry validation` test suite (8 tests):
  - Succeeds with default built-in vocabulary
  - Succeeds with explicit allowedAgentIds
  - Throws ClassifierUnregisteredAgentError when agent absent from allowedAgentIds
  - Error code is E_CLASSIFIER_UNREGISTERED_AGENT
  - Error message includes fix-hint listing valid IDs
  - Fallback path validated with cleo-subagent in allowedAgentIds
  - Throws when fallback absent from allowedAgentIds
  - All built-in vocabulary members dispatch cleanly

## Test Results

- **24/24 tests passing** in classify.test.ts
- **biome CI**: clean on all 5 changed files

## Key Design Decision

The classifier is a pure synchronous function. Rather than coupling it to the async DB-backed `AgentRegistryAccessor`, `getRegisteredAgentIds()` derives the vocabulary directly from `CLASSIFIER_RULES`. This keeps the classifier pure and testable while enabling callers to inject live registry IDs at dispatch time via `opts.allowedAgentIds`.

## Acceptance Criteria Status

- [x] Classifier validates its own output against registry at classification time
- [x] Unknown agent emission throws `E_CLASSIFIER_UNREGISTERED_AGENT` with fix-hint listing valid agent IDs
- [x] Classifier vocabulary derived from CLASSIFIER_RULES (no separate list to drift)
- [x] Unit test: all 8 registry validation scenarios covered
- [x] `pnpm biome ci .` (scoped): PASS
- [x] Tests: 24 passed
