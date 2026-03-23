# T039 — Agent Health Monitoring and Heartbeat System

**Status**: complete
**Date**: 2026-03-22
**Epic**: T038 (Documentation-Implementation Drift Remediation)

---

## Summary

Implemented the agent health monitoring and heartbeat system for production agent reliability. The implementation adds a new `health-monitor.ts` module to `packages/core/src/agents/` with four exported functions matching the T039 specification, plus a `cleo agents health` CLI command.

---

## Files Created

### `/packages/core/src/agents/health-monitor.ts`

New module exporting the T039-specified health monitoring API:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `recordHeartbeat` | `(agentId, cwd?) -> AgentInstanceStatus \| null` | Update last_heartbeat for a live agent |
| `checkAgentHealth` | `(agentId, thresholdMs?, cwd?) -> AgentHealthStatus \| null` | Health status for a specific agent by ID |
| `detectStaleAgents` | `(thresholdMs?, cwd?) -> AgentHealthStatus[]` | Find agents with heartbeat older than threshold |
| `detectCrashedAgents` | `(thresholdMs?, cwd?) -> AgentInstanceRow[]` | Find and mark active agents with no heartbeat for >3min |

Constants exported:
- `HEARTBEAT_INTERVAL_MS = 30_000` (30 seconds — recommended heartbeat frequency)
- `STALE_THRESHOLD_MS = 180_000` (3 minutes — timeout/crash threshold)

Type exported:
- `AgentHealthStatus` — structured health report for a single agent (id, status, lastHeartbeat, heartbeatAgeMs, healthy, stale, thresholdMs)

### `/packages/core/src/agents/__tests__/health-monitor.test.ts`

25 tests covering:
- Module constants
- `recordHeartbeat`: updates heartbeat, returns status, skips terminal agents
- `checkAgentHealth`: null for missing, healthy/stale/stopped reporting
- `detectStaleAgents`: empty when healthy, detects active/idle stale, excludes terminal, sort order
- `detectCrashedAgents`: marks crashed in DB, active-only, idempotent, sort order

### `/packages/cleo/src/cli/commands/agents.ts`

New CLI command group with `cleo agents health`:

```
cleo agents health                         # full health report
cleo agents health --id <agentId>          # single agent check
cleo agents health --detect-crashed        # detect + mark crashed (mutating)
cleo agents health --threshold <ms>        # custom staleness threshold
```

---

## Files Modified

### `/packages/core/src/agents/index.ts`

Added health-monitor exports. Renamed the existing `registry.checkAgentHealth` export to `findStaleAgentRows` to avoid signature conflict with the new `health-monitor.checkAgentHealth`:
- `registry.checkAgentHealth(thresholdMs?, cwd?) -> AgentInstanceRow[]` → exported as `findStaleAgentRows`
- `health-monitor.checkAgentHealth(agentId, thresholdMs?, cwd?) -> AgentHealthStatus | null` → exported as `checkAgentHealth`

### `/packages/core/src/internal.ts`

Added flat exports for the new health-monitor functions and `AgentHealthStatus` type, required by `@cleocode/cleo`.

### `/packages/cleo/src/cli/index.ts`

Registered `registerAgentsCommand` import and invocation.

---

## Design Decisions

1. **Naming conflict resolution**: The pre-existing `registry.checkAgentHealth(thresholdMs) -> AgentInstanceRow[]` has a different signature from T039's `checkAgentHealth(agentId)`. The registry function is re-exported as `findStaleAgentRows` to give the T039 name to the new per-agent function.

2. **detectCrashedAgents is active-only**: Only agents with `status === 'active'` are considered crashed when heartbeat-silent. Idle/starting agents may not yet have established regular heartbeat intervals.

3. **detectCrashedAgents is write-side**: It calls `markCrashed()` and mutates the DB. `detectStaleAgents` is read-only. Callers who want read-only staleness detection should use `detectStaleAgents`.

4. **CLI uses core functions directly**: The `agents.ts` CLI command calls core functions directly rather than routing through the dispatch layer, since `agents` is not a canonical dispatch domain. This is consistent with how the CLI works for commands that don't need MCP exposure.

---

## Test Results

```
All agent tests: 150 passed across 6 test files
  - health-monitor.test.ts: 25 passed
  - registry.test.ts: 42 passed
  - capacity.test.ts: 32 passed
  - retry.test.ts: 30 passed
  - execution-learning.test.ts: 14 passed
  - agent-registry.test.ts: 7 passed
```

---

## Quality Gates

- biome check: passed (no violations)
- Full core test suite: 3075 passed, 5 skipped (pre-existing skips)
- Pre-existing build failure in `intelligence/impact.ts` is unrelated to this task
