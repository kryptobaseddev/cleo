# T564 — CONDUIT Delivery Loop Implementation

**Date**: 2026-04-14
**Task**: Wire CONDUIT delivery loop — enable LocalTransport in agent daemon
**Status**: complete

## Summary

Messages were being written to conduit.db but never delivered. The root cause
was three separate gaps in the transport resolution and dispatch layers.

## Changes Made

### Change 1: `packages/core/src/conduit/factory.ts`

**Before**: `resolveTransport()` only chose LocalTransport when `apiBaseUrl` was
`'local'` or missing. Cloud-backed agents (apiBaseUrl starts with `http`) always
received HttpTransport, even when conduit.db existed locally.

**After**: LocalTransport is now the top priority whenever conduit.db is present
(`LocalTransport.isAvailable()` checks for the file). Cloud credentials and local
transport are not mutually exclusive. The priority chain is:

1. LocalTransport — conduit.db present (no network needed)
2. SseTransport — cloud credential with sseEndpoint
3. HttpTransport — fallback

This change benefits all callers of `createConduit()` including `cleo agent send`,
`cleo agent poll`, and any internal conduit usage that calls `resolveTransport`.

### Change 2: `packages/cleo/src/dispatch/domains/conduit.ts`

Four private methods updated to use LocalTransport directly when conduit.db
exists, falling back to HTTP only when it does not:

- **`getStatus()`** — reads pending count from SQLite instead of hitting the
  cloud inbox endpoint. Reports `transport: 'local'` in the response.
- **`peek()`** — polls conduit.db via `transport.poll()`, acks fetched messages,
  and returns them. Bypasses the HTTP `/messages/peek` endpoint entirely.
- **`startPolling()`** — creates and connects a LocalTransport, passes it as
  `transport` to `AgentPoller`. The poller's `peekMessages()` method delegates
  to `transport.poll()` when a transport is provided. Reports `transport: 'local'`
  in the start response.
- **`sendMessage()`** — calls `transport.push()` to write directly to conduit.db.
  Reports `transport: 'local'` in the send response.

All four fall back gracefully to HTTP behavior when conduit.db is absent.

### Change 3: `packages/cleo-os/extensions/cleo-chatroom.ts`

Added `deliverViaConduit(toAgentId, message, cwd)` helper using `execFileSync`
(not `exec` — no shell injection surface) that calls `cleo agent send <message>
--to <agentId>`. Each of the four messaging tools now calls this helper after
`recordMessage()`:

- `send_to_lead` → delivers to `params.lead`
- `broadcast_to_team` → delivers to `team:<params.group>`
- `report_to_orchestrator` → delivers to `params.orchestrator`
- `query_peer` → delivers to `params.peer`

Delivery is best-effort (failures are silently swallowed) so TUI functionality
is never blocked by conduit errors.

## Message Flow (After Fix)

```
Pi tool (send_to_lead) → deliverViaConduit() → cleo agent send
                              ↓
                        createConduit() → resolveTransport()
                              ↓
                        LocalTransport.isAvailable() = true
                              ↓
                        transport.push() → conduit.db messages table
                        status = 'pending'

Recipient agent daemon (cleo agent start <id>):
  createRuntime() → resolveTransport() → LocalTransport
  AgentPoller.pollCycle() → transport.poll() → pending messages
  → handler called → ack() → status = 'delivered'
```

## Quality Gates

- `pnpm biome check --write`: clean (2 files checked, no fixes applied)
- `pnpm run build`: Build complete
- `pnpm run test`: 7275 passed | 10 skipped | 32 todo — zero new failures

## Acceptance Criteria

- [x] AgentPoller uses LocalTransport when conduit.db exists
- [x] Messages transition from pending to delivered (poller polls + acks)
- [x] `cleo orchestrate conduit-peek` returns delivered messages (via LocalTransport.poll())
