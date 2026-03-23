# T041 — Agent Registry with Capacity Tracking

**Status**: complete
**Date**: 2026-03-22
**Epic**: T038 (Documentation-Implementation Drift Remediation)

## Summary

Created `/packages/core/src/agents/agent-registry.ts` — a new module providing
task-count-based capacity tracking, specialization management, and performance
recording for load balancing. Exported from the agents barrel and tested with
21 passing tests.

## Implementation

### New file

`packages/core/src/agents/agent-registry.ts`

Exports:

| Symbol | Type | Description |
|--------|------|-------------|
| `MAX_TASKS_PER_AGENT` | const (5) | Upper bound for task-count capacity |
| `AgentCapacity` | interface | Task-count capacity breakdown per agent |
| `AgentPerformanceMetrics` | interface | Simplified metrics input for performance recording |
| `getAgentCapacity(agentId, cwd?)` | function | Remaining task-count capacity for one agent |
| `getAgentsByCapacity(agentType?, cwd?)` | function | All active agents sorted by remaining capacity desc |
| `getAgentSpecializations(agentId, cwd?)` | function | Skills array from metadata_json |
| `updateAgentSpecializations(agentId, specs, cwd?)` | function | Write specializations to metadata_json |
| `recordAgentPerformance(agentId, metrics, cwd?)` | function | Record to brain_decisions via execution-learning |

### Design decisions

- **Task-count model**: capacity = `MAX_TASKS_PER_AGENT (5) - activeTasks`. Active tasks = own `task_id` (1 if set) + non-terminal child agents sharing `parent_agent_id`. This differs from the existing float-based `capacity.ts` which tracks resource load (0.0–1.0) — both models coexist without conflict.
- **No new tables**: used existing `agent_instances.metadata_json` for specializations and `brain_decisions` (via `execution-learning.ts`) for performance history.
- **Best-effort recording**: `recordAgentPerformance` delegates to `recordAgentExecution` and never throws when brain.db is unavailable.
- **Terminal states**: `stopped` and `crashed` agents return `remainingCapacity: 0` / `available: false` immediately without DB child queries.

### Barrel export

Added to `packages/core/src/agents/index.ts`:

```ts
export {
  type AgentCapacity,
  type AgentPerformanceMetrics,
  getAgentCapacity,
  getAgentsByCapacity,
  getAgentSpecializations,
  MAX_TASKS_PER_AGENT,
  recordAgentPerformance,
  updateAgentSpecializations,
} from './agent-registry.js';
```

### Tests

`packages/core/src/agents/__tests__/agent-registry.test.ts` — 21 tests across 5 describe blocks:

- `MAX_TASKS_PER_AGENT` — constant assertion
- `getAgentCapacity` — null for missing, full cap for new active, own task counts, child agents count, terminal states, stopped children excluded
- `getAgentsByCapacity` — empty when no agents, descending sort, type filter, terminal exclusion
- `getAgentSpecializations` / `updateAgentSpecializations` — round-trip, replace, metadata key preservation, null for missing
- `recordAgentPerformance` — null for missing agent, success recording, failure recording (no throw)

## Quality gates

- `pnpm biome check --write`: 2 files fixed, 0 errors
- `pnpm run build`: build complete (pre-existing warnings only)
- `pnpm exec vitest run`: 274 passed / 0 failed (4819 total tests)
