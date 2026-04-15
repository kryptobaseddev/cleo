# T268: Conduit Hook Handler Implementation (Worker B)

**Date**: 2026-04-13
**Approach**: Decoupled hook-based conduit messaging (Worker B)
**Status**: complete

## Summary

Implemented conduit messaging via a new hook handler at
`packages/core/src/hooks/handlers/conduit-hooks.ts`.

The approach is fully decoupled from the orchestrate engine — it hooks into
the existing `HookRegistry` to observe orchestration lifecycle events and
writes structured messages to `conduit.db` via `LocalTransport`.

## Files Created / Modified

- **NEW** `packages/core/src/hooks/handlers/conduit-hooks.ts` — handler module
- **NEW** `packages/core/src/hooks/handlers/__tests__/conduit-hooks.test.ts` — 22 tests
- **MODIFIED** `packages/core/src/hooks/handlers/index.ts` — auto-registration import + exports

## Hook Registrations

| Hook ID | Event | Priority | Action |
|---------|-------|----------|--------|
| `conduit-subagent-start` | `SubagentStart` | 50 | Sends `subagent.spawn` message to spawned agent |
| `conduit-subagent-stop` | `SubagentStop` | 50 | Sends `subagent.complete` message to `cleo-system` |
| `conduit-session-end` | `SessionEnd` | 8 | Sends `session.handoff` message with optional `nextTask` |

Priority 50 runs after brain capture (100) and before low-priority bookkeeping.
Priority 8 runs after backup (10) but before consolidation (5).

## Message Format

All messages are JSON-serialised strings written to `conduit.db`:

```json
{
  "type": "subagent.spawn | subagent.complete | session.handoff",
  "from": "cleo-orchestrator | <agentId>",
  "to": "<agentId> | cleo-system",
  "content": "human-readable description",
  "taskId": "T123 | null",
  "timestamp": "ISO 8601"
}
```

## Key Design Decisions

1. **Static import** — `LocalTransport` is imported statically at the top of the
   module. This avoids dynamic-import mock-resolution issues in Vitest.

2. **`tryGetLocalTransport` is exported** — allows direct testing via factory
   injection (`transportFactory` parameter). Production use passes the default
   `LocalTransport` class.

3. **Class-based mock** — tests use `class MockLocalTransport` with hoisted mock
   functions assigned as properties. This satisfies Vitest's constructor mock
   requirement.

4. **Best-effort throughout** — `tryGetLocalTransport` catches all errors and
   returns `null`. Every handler has `try/catch/finally` ensuring `disconnect()`
   is always called and no error ever propagates to the caller.

5. **No credential requirement** — the system agent `cleo-orchestrator` connects
   with `apiKey: ''` and `apiBaseUrl: 'local'`. `LocalTransport` doesn't
   authenticate; it just writes to conduit.db.

6. **Skips gracefully when conduit.db absent** — `LocalTransport.isAvailable(projectRoot)`
   returns false before `cleo init` is run. All handlers return early in that case.

## Test Results

```
Test Files: 1 passed
Tests: 22 passed (22)
```

All 8 hook handler test files pass (79 total tests, 0 failures).

## Comparison with Worker A (orchestrate-engine approach)

Worker B (this implementation) is simpler and safer:
- No changes to the orchestrate engine
- No new dependencies or interfaces
- Fully reversible — remove the import from index.ts to disable
- Best-effort by design — hook failures never surface to callers
- Activated automatically on module load (same pattern as all other handlers)
