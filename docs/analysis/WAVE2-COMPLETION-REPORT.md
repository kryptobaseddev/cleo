# Wave 2 Completion Report: Agent Dimension

**Status**: COMPLETE
**Date**: 2026-03-19
**Target**: Agent dimension 40% -> 100%

## Summary

Implemented the complete Agent dimension for the BRAIN specification, adding
runtime agent instance tracking, heartbeat-based health monitoring, self-healing
with exponential backoff, and capacity-aware load balancing.

## Deliverables

### Task 1: Agent Registry (COMPLETE)

**New files:**
- `packages/core/src/agents/agent-schema.ts` -- Drizzle ORM schema for `agent_instances` and `agent_error_log` tables
- `packages/core/src/agents/registry.ts` -- Full CRUD, heartbeat, health monitoring, error classification

**Schema:**
- `agent_instances` table: id, agent_type, status, session_id, task_id, started_at, last_heartbeat, stopped_at, error_count, total_tasks_completed, capacity, metadata_json, parent_agent_id
- `agent_error_log` table: id, agent_id, error_type, message, stack, occurred_at, resolved
- 9 indexes for query performance

**Operations:**
- `registerAgent(opts)` -- creates new agent with starting status
- `deregisterAgent(id)` -- marks stopped (idempotent)
- `heartbeat(id)` -- updates last_heartbeat, returns current status
- `listAgentInstances(filters?)` -- multi-field filtering (status, type, session, parent)
- `getAgentInstance(id)` -- lookup by ID
- `updateAgentStatus(id, opts)` -- status transitions with error tracking
- `incrementTasksCompleted(id)` -- atomic counter increment
- `generateAgentId()` -- format: `agt_{YYYYMMDDHHmmss}_{6hex}`

### Task 2: Health Monitoring (COMPLETE)

**In `registry.ts`:**
- `checkAgentHealth(thresholdMs=30000)` -- finds agents with stale heartbeats (default 30s per BRAIN spec)
- `markCrashed(id, reason?)` -- sets crashed status with error logging
- `getHealthReport(thresholdMs)` -- full status summary: total, active, idle, starting, error, crashed, stopped, totalErrors, staleAgents

### Task 3: Self-Healing / Retry Logic (COMPLETE)

**New file:** `packages/core/src/agents/retry.ts`

- `createRetryPolicy(opts?)` -- configurable policy (maxRetries: 3, baseDelay: 1s, maxDelay: 30s, multiplier: 2x)
- `withRetry(fn, policy?)` -- wraps async function with retry logic, tracks attempts and total delay
- `classifyError(error)` -- returns 'retriable' | 'permanent' | 'unknown'
- `shouldRetry(error, attempt, policy)` -- determines if retry is warranted
- `calculateDelay(attempt, policy)` -- exponential backoff with optional jitter (0-25%)
- `recoverCrashedAgents(thresholdMs)` -- finds crashed agents, restarts retriable ones, abandons permanent/threshold-exceeded ones
- `DEFAULT_RETRY_POLICY` -- frozen default policy object

### Task 4: Capacity Tracking (COMPLETE)

**New file:** `packages/core/src/agents/capacity.ts`

- `getAvailableCapacity()` -- sum of capacity across active/idle agents
- `findLeastLoadedAgent(type?)` -- returns agent with highest capacity
- `updateCapacity(id, capacity)` -- validated 0.0-1.0 update
- `isOverloaded(threshold=0.1)` -- true if system capacity below threshold
- `getCapacitySummary(threshold)` -- total, average, count, overloaded status

### Task 5: Integration (COMPLETE)

- `packages/core/src/agents/index.ts` -- barrel file exporting all public APIs
- `packages/core/src/index.ts` -- added `export * as agents from './agents/index.js'`
- `packages/core/src/internal.ts` -- added flat function re-exports with `registerAgentInstance` alias
- `packages/core/src/store/tasks-schema.ts` -- re-exports agent schema tables for drizzle-kit
- `packages/core/src/store/validation-schemas.ts` -- Zod schemas: `insertAgentInstanceSchema`, `selectAgentInstanceSchema`, `insertAgentErrorLogSchema`, `selectAgentErrorLogSchema`, `agentInstanceStatusSchema`, `agentTypeSchema`
- `packages/core/migrations/drizzle-tasks/20260320020000_agent-dimension/` -- SQL migration + snapshot

### Task 6: Tests (COMPLETE)

**78 tests across 3 files:**

- `packages/core/src/agents/__tests__/registry.test.ts` (44 tests)
  - ID generation (format, uniqueness)
  - Registration CRUD (create, get, deregister, list)
  - Heartbeat protocol (update, stopped/crashed guards)
  - Status management (transitions, error counting, error logging)
  - Error classification (retriable, permanent, unknown patterns)
  - Health monitoring (stale detection, crash marking, health reports)
  - Error history retrieval

- `packages/core/src/agents/__tests__/retry.test.ts` (20 tests)
  - Retry policy creation and merging
  - Exponential backoff calculation
  - Max delay capping
  - Jitter randomness
  - shouldRetry decision logic
  - withRetry wrapper (success, retry+recover, immediate fail, exhaustion)
  - Self-healing recovery (retriable restart, permanent abandon, threshold abandon)

- `packages/core/src/agents/__tests__/capacity.test.ts` (14 tests)
  - Capacity update with validation
  - Available capacity aggregation
  - Stopped/crashed agent exclusion
  - Least loaded agent selection with type filtering
  - Overload detection
  - Capacity summary reporting

### Task 7: Verification (COMPLETE)

- `pnpm run build` -- passes (all packages compile)
- `pnpm run test` -- 4618 tests pass, 0 failures (267 test files + 1 skipped)
- Agent tests specifically: 78/78 pass

## Design Decisions

1. **Separate from skills/agents/registry.ts**: The existing file-based registry tracks installed agent *definitions*. The new DB-backed registry tracks running agent *instances*. They serve different purposes and coexist cleanly.

2. **Capacity as TEXT**: SQLite stores capacity as TEXT (`'1.0'`) rather than REAL to avoid floating-point representation issues across serialization boundaries. Parsed to number at query time.

3. **Error classification patterns**: Comprehensive regex matching categorizes errors into retriable (network, rate limits, locks), permanent (auth, constraints, not found), or unknown. This drives the self-healing recovery logic.

4. **Agent ID format**: `agt_{YYYYMMDDHHmmss}_{6hex}` follows the established CLEO ID convention (matching `ses_` prefix for sessions) -- human-readable, sortable, collision-resistant.

5. **No FKs on agent_instances**: session_id and task_id are stored as plain text without foreign keys, following the same pattern as audit_log. Agent records must survive session/task deletion.

## Existing Code Preserved

- `skills/agents/registry.ts` -- untouched (file-based agent definitions)
- `skills/types.ts` -- untouched (AgentRegistry, AgentRegistryEntry, AgentConfig types remain)
- `hooks/types.ts` -- untouched (OnAgentSpawnPayload, OnAgentCompletePayload remain for hook system)
- All 4540 pre-existing tests continue to pass
