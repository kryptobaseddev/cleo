# T034: Agent Dimension Implementation

**Task:** T034
**Epic:** T029 (Schema Architecture Review)
**Status:** complete
**Date:** 2026-03-21

## Summary

Completed the Agent (A) dimension of BRAIN with execution learning, failure pattern tracking, and self-healing suggestions. The implementation bridges the existing agent registry (tasks.db) with the cognitive memory layer (brain.db) without circular dependencies.

## Files Created

- `packages/core/src/agents/execution-learning.ts` — New module implementing:
  - `recordAgentExecution` — logs agent execution events to brain_decisions with structured metadata
  - `getAgentPerformanceHistory` — queries and aggregates execution history by (agentType, taskType)
  - `recordFailurePattern` — creates/increments failure patterns in brain_patterns with upsert semantics
  - `storeHealingStrategy` — records healing strategy observations to brain_observations
  - `getSelfHealingSuggestions` — retrieves applicable healing suggestions from brain_patterns
  - `processAgentLifecycleEvent` — compound function that orchestrates all of the above as best-effort
  - Internal `_*WithAccessor` variants for testability with injected brain accessor
- `packages/core/src/agents/__tests__/execution-learning.test.ts` — 26 tests covering all functions

## Files Modified

- `packages/core/src/agents/index.ts` — Added execution-learning exports
- `packages/core/src/internal.ts` — Added flat exports for `@cleocode/cleo` consumption

## Architecture Decisions

### Best-effort design
All brain.db writes are wrapped in try/catch and return null on error. Agent lifecycle events must never fail due to a brain.db issue. This is consistent with the cognitive memory layer being an observational system.

### ID namespace conventions
- Brain decisions: `AGT-` prefix (tactical type)
- Brain patterns: `P-agt-` prefix
- Brain observations: `O-agt-` prefix

This allows filtering to identify agent-specific entries without ambiguity.

### Upsert pattern for failure patterns
Rather than inserting a new brain_pattern row for each failure occurrence, the `_recordFailurePatternWithAccessor` function checks for an existing pattern with matching text and increments its frequency counter. This keeps the pattern table clean and makes frequency counts accurate.

### Observation threshold
A healing strategy observation is only stored in brain_observations when a failure pattern reaches frequency >= 3. Below that threshold, the pattern exists but is not yet considered "established" enough to warrant a persistent healing note.

### Performance aggregation
`getAgentPerformanceHistory` reads all tactical brain decisions prefixed with `AGT-`, parses the embedded JSON metadata in `alternativesJson`, and aggregates in-memory per (agentType, taskType) bucket. This avoids schema changes to brain_decisions and keeps the aggregation logic in TypeScript rather than SQL.

## Acceptance Criteria Coverage

- Agent execution patterns tracked in brain_decisions: YES — every call to `recordAgentExecution` writes a tactical decision row with agentType, taskType, outcome, and embedded metadata JSON
- Self-healing suggestions based on failure history: YES — `getSelfHealingSuggestions` and `processAgentLifecycleEvent` surface relevant healing actions
- Pattern recognition queries implemented: YES — `getAgentPerformanceHistory` with agentType/taskType filters
- No breaking changes to existing agent infrastructure: YES — no existing exports modified, only additive

## Quality Gates

- biome check: PASS (no fixes needed)
- pnpm run build: PASS
- pnpm run test: 26/26 new tests pass, 118 pre-existing failures unchanged
