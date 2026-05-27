# @cleocode/runtime

Long-running process layer for CLEO. Provides the daemon services that
let an agent stay resident on a host: message polling, SSE connection
management, heartbeat reporting, and credential key rotation.

This package powers `cleo agent start` — when an operator starts an
autonomous agent, this is the runtime that keeps it alive between
human interactions.

## Install

```bash
pnpm add @cleocode/runtime
```

## Public API

```ts
import {
  createRuntime,
  type RuntimeConfig,
  type RuntimeHandle,
  AgentPoller,
  HeartbeatService,
  KeyRotationService,
  SseConnectionService,
} from '@cleocode/runtime';
```

### `createRuntime(registry, config)`

Top-level entry point. Resolves an agent credential from the registry,
configures the poller and ancillary services, opens the transport, and
starts polling. Returns a `RuntimeHandle` for registering message
handlers and stopping the runtime cleanly.

```ts
import { createRuntime } from '@cleocode/runtime';
import { AgentRegistryAPI } from '@cleocode/core/internal';

const registry = new AgentRegistryAPI(/* ... */);
const handle = await createRuntime(registry, {
  agentId: 'cleo-prime',
  pollIntervalMs: 5000,
  heartbeatIntervalMs: 30000,
  groupConversationIds: ['general', 'announcements'],
});

handle.poller.onMessage(async (msg) => {
  // handle inbound messages
});

// later
handle.stop();
```

### `RuntimeConfig`

```ts
interface RuntimeConfig {
  agentId?: string;              // defaults to most recently active agent
  pollIntervalMs?: number;       // default: 5000
  groupConversationIds?: string[];
  groupPollLimit?: number;       // default: 15
  heartbeatIntervalMs?: number;  // default: 30000, 0 to disable
  maxKeyAgeMs?: number;          // default: 30 days, 0 to disable
  sseEndpoint?: string;
  createSseTransport?: () => Transport;
  transport?: Transport;         // pre-created, bypasses auto-resolution
}
```

### `RuntimeHandle`

```ts
interface RuntimeHandle {
  poller: AgentPoller;
  heartbeat: HeartbeatService | null;
  keyRotation: KeyRotationService | null;
  sseConnection: SseConnectionService | null;
  transport: Transport;
  agentId: string;
  stop: () => void;
}
```

`stop()` cleanly shuts down all services in order: SSE connection,
heartbeat, key rotation, poller, transport.

## Services

### `AgentPoller`

The core polling loop. Fetches direct messages and group-mention
messages on a configurable interval, deduplicates against a high-water
mark, and dispatches each new message to registered handlers.

### `HeartbeatService`

Periodic agent presence reporting. Tells the SignalDock backend that
the agent is alive so other agents can route messages to it without
hitting offline timeouts. Disabled when `heartbeatIntervalMs === 0`.

### `KeyRotationService`

Watches the agent's transport credential age and rotates the API key
before it expires. Maintains zero-downtime rotation by overlapping the
old and new keys for one poll cycle. Disabled when `maxKeyAgeMs === 0`.

### `SseConnectionService`

Optional persistent Server-Sent Events connection for sub-second
message delivery. When configured, the poller throttles down to a
slower interval and SSE handles the realtime path. Falls back
automatically to pure polling on connection loss.

## Architecture

```
┌──────────────────────────────────────────┐
│ cleo agent start  (CLI entry)            │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│ @cleocode/runtime  createRuntime()       │
│   ┌────────────────────────────────┐     │
│   │ AgentPoller        (poll loop) │     │
│   │ HeartbeatService   (presence)  │     │
│   │ KeyRotationService (creds)     │     │
│   │ SseConnectionService (realtime)│     │
│   └────────────────────────────────┘     │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│ @cleocode/contracts  Transport interface │
│   resolves to Local | SSE | HTTP         │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│ SignalDock backend (local or cloud)      │
└──────────────────────────────────────────┘
```

The runtime is **transport-agnostic**: it works with the local
napi-rs SignalDock binding (in-process), SSE realtime, or HTTP polling
against `api.signaldock.io`. The transport layer is selected by
`createRuntime()` based on whether `sseEndpoint` and `transport` are
present in the config.

## CANT profile execution

`createRuntime()` does **not** execute `.cant` workflow profiles
directly. Profile-driven workflow execution lives in the
[`cant-bridge.ts`](../cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts)
Pi extension and runs inside a Pi session, not the daemon. Operators
who want profile-driven behaviour should start a Pi session and use
`/cant:load <file>` followed by `/cant:run <file> <workflow>`.

This boundary was set in [ADR-035 §D5](../../.cleo/adrs/ADR-035-pi-v2-v3-harness.md)
"single engine, cant-bridge.ts as canonical" — runtime stays simple
and profile semantics live in one place.

## Testing

```bash
pnpm --filter @cleocode/runtime test
```

Tests use mocked transports from `@cleocode/contracts` to exercise the
poller and service lifecycle without hitting a real backend.

## Related

- [`@cleocode/contracts`](../contracts) — Transport interface and message types
- [`@cleocode/core`](../core) — agent registry, credential storage, message persistence
- [`packages/cleo/src/cli/commands/agent.ts`](../cleo/src/cli/commands/agent.ts) — `cleo agent start` CLI entry that calls `createRuntime`
- [`.cleo/adrs/ADR-035-pi-v2-v3-harness.md`](../../.cleo/adrs/ADR-035-pi-v2-v3-harness.md) — runtime/Pi boundary decisions

## License

MIT
