---
id: t11998-suite-containment
tasks: [T11998]
kind: feat
summary: "per-session scope/pgid suite containment — session end reaps the entire MCP tree"
---

Fixes the root cause of the 1153-leaked-MCP-process / 46GB incident class.
Previously, cleo spawned the claude CLI with `detached:true` + `unref()`,
and claude's MCP suite (~7 processes/agent) reparented to the user systemd
manager on agent exit — never reaped.

## What changed

### New: `packages/contracts/src/spawn.ts`

Added `AgentContainmentMode` ('systemd' | 'pgid' | 'none') and
`AgentSuiteOwnership` (the per-session kill handle) as cross-package types.
Extended `SpawnResult.ownership?: AgentSuiteOwnership` so callers can persist
the handle and pass it to the reaper on session end.

### New: `packages/adapters/src/providers/shared/agent-spawn-wrapper.ts`

Adapter-local `buildAgentSpawnArgs(command, args, scopeId?)`:
- On Linux with systemd: wraps `claude` in `systemd-run --user --scope
  --slice=cleo.slice --unit=cleo-agent-session-<id>.scope -p MemoryMax=32G
  -p MemorySwapMax=0 -- sh -c 'ulimit -c 0; exec "$@"' sh claude ...`
- Fallback: pgid path (`detached:true`), records `pgid=child.pid` in
  the ownership handle; log-once demotion to stderr
- Returns `{ command, args, ownership }` — caller uses ownership for reaping

### New: `packages/adapters/src/providers/claude-code/suite-reaper.ts`

`reapAgentSuite(ownership: AgentSuiteOwnership)`:
- systemd mode: `systemctl --user stop <unitName>` → `reset-failed`; pgid
  fallback if systemctl fails
- pgid mode: SIGTERM → 3s grace → SIGKILL; ESRCH = no-op (idempotent)
- none mode: no-op (janitor T11995 is the backstop)

### Updated: `packages/adapters/src/providers/claude-code/spawn.ts`

- Rewired spawn to use `buildAgentSpawnArgs` instead of bare `nodeSpawn('claude', ...)`
- Records `ownership` in `TrackedProcess` and surfaces it in `SpawnResult`
- `terminate(instanceId)`: now calls `reapAgentSuite(tracked.ownership)` to
  kill the entire tree (root + all MCP grandchildren)
- `terminateAll()`: new method for session-end bulk reap

### New: `packages/adapters/src/__tests__/suite-containment.test.ts`

Integration test (pgid path, CI-runnable without a user bus):
- Stand-in agent script forks two `sleep 60` grandchildren
- Calls `reapAgentSuite`, asserts ZERO surviving processes (pgid + grandchildren)
- Abnormal agent exit (SIGKILL root): reap still clears grandchildren
- ESRCH / mode=none: no-op / no-throw
- Systemd path block: `describe.skipIf(!systemdAvailable)` — exercises real
  scope stop when a live user bus is present

## Architecture note

`@cleocode/adapters` cannot import from `@cleocode/core` (core depends on
adapters — cycle).  `agent-spawn-wrapper.ts` is a deliberate local copy of the
systemd-run builder from `core/resources/spawn-wrapper.ts`, kept in sync by
the skill-drift gate.  The types live in `@cleocode/contracts` (no cycle).

## MCP registry path (`packages/adapters/src/providers/claude-sdk/mcp-registry.ts`)

Returns stdio configs; the parent harness process spawns those children.
Containment of the parent scope covers all its stdio children — no changes
needed.  Documented in suite-reaper.ts module TSDoc.
