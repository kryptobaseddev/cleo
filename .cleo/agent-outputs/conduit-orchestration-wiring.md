# Conduit Orchestration Wiring

**Date**: 2026-04-13
**Worker**: CLEO Worker A
**Status**: complete

## Summary

Wired `conduit.send()` into the orchestration spawn and handoff flow so that
conduit.db receives real messages when agents are spawned or a handoff occurs.
Previously 0 production messages were ever written to conduit.db by orchestration
events.

## Changes Made

### File: `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`

**+70 lines, 1 file changed.**

#### 1. `sendConduitEvent()` helper (lines ~47-88)

A private async function added before the `HandoffStepStatus` type declarations.
It:
- Dynamically imports `AgentRegistryAccessor`, `getDb`, `createConduit` from
  `@cleocode/core/internal` to avoid circular deps at module load time
- Calls `getDb()` to ensure the DB is initialized
- Gets the active agent credential via `registry.getActive()`
- If no active agent is found, returns silently (no throw)
- Wraps `conduit.send()` in a try/finally so `disconnect()` always runs
- Outer try/catch swallows all errors — conduit failures MUST NOT surface

#### 2. `orchestrateSpawnExecute()` — spawn event (line ~643)

After `adapter.spawn(cleoSpawnContext)` succeeds, fires a `void` call to
`sendConduitEvent()` with payload:

```json
{
  "event": "agent.spawned",
  "taskId": "<id>",
  "instanceId": "<adapter-instance>",
  "status": "<spawn-status>",
  "providerId": "<provider>",
  "adapterId": "<adapter>",
  "tier": <0|1|2|null>,
  "spawnedAt": "<ISO timestamp>"
}
```

The `void` prefix documents intent: fire-and-forget, the return path does not
wait on this promise.

#### 3. `orchestrateHandoff()` — handoff event (line ~1114)

After all three steps complete successfully, fires a `void` call to
`sendConduitEvent()` with payload:

```json
{
  "event": "orchestrate.handoff",
  "taskId": "<id>",
  "protocolType": "<type>",
  "predecessorSessionId": "<session-id>",
  "endedSessionId": "<session-id>",
  "note": "<note|null>",
  "nextAction": "<action|null>",
  "handoffAt": "<ISO timestamp>"
}
```

## Code Path Trace

When `orchestrateSpawnExecute('T123', ...)` is called with a capable adapter:

1. `adapter.spawn(cleoSpawnContext)` executes and returns `result`
2. `void sendConduitEvent(cwd, 'cleo-core', { event: 'agent.spawned', ... })` fires
3. Inside `sendConduitEvent`:
   - `AgentRegistryAccessor(cwd)` opens `conduit.db` + `signaldock.db`
   - `registry.getActive()` returns the most-recently-used project agent
   - `createConduit(registry)` selects `LocalTransport` (conduit.db is present)
     via `resolveTransport()` in `factory.ts`
   - `LocalTransport.connect()` opens conduit.db at `.cleo/conduit.db`
   - `conduit.send('cleo-core', JSON.stringify(event))` calls
     `LocalTransport.push('cleo-core', content, {})`
   - `push()` calls `ensureDmConversation(agentId, 'cleo-core')` to get/create
     a private conversation row, then INSERTs into `messages` table with
     `status = 'pending'`
4. The main `orchestrateSpawnExecute` return proceeds unblocked

## Verification

- `pnpm biome check --write packages/cleo/src/dispatch/engines/orchestrate-engine.ts`
  - Result: "Checked 1 file in 30ms. No fixes applied."
- `pnpm run build`
  - Result: "Build complete." — all packages built successfully
- `pnpm dlx vitest run`
  - Result: 396 test files passed, 7135 tests passed, 0 failures

## Invariants Maintained

- Conduit failure NEVER blocks or changes the return value of orchestration
- No new `any` or `unknown` types introduced
- Dynamic import avoids adding `@cleocode/core` as a new static dep at the
  engine module level (already imported via `@cleocode/core/internal` but we
  want the conduit factory lazily loaded)
- Messages are LAFS-shaped (structured JSON in `content` field)
- Recipient is `cleo-core` — the system/orchestrator agent
