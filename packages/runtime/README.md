# @cleocode/runtime

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

Runtime layer for CLEO. It has three parts, exported as separate subpaths:

| Subpath | What it is | Status |
|---|---|---|
| `@cleocode/runtime/gateway` (+ `/gateway/dispatch`, `/gateway/http`, `/gateway/rpc`, `/gateway/mcp`) | The transport-agnostic CQRS dispatcher behind the CLI: the CLI adapter injects the domain handlers and middleware (`packages/cleo/src/dispatch/adapters/cli.ts`) | Kept (ADR-098). The MCP server under `/gateway/mcp` is not wired to any command; wiring it as `cleo mcp serve` or deleting it is an open owner call in ADR-098. |
| `@cleocode/runtime/daemon` | `defineSubsystem` and the subsystem registry: one `start → healthProbe → shutdown` lifecycle for long-running concerns (the web server, the docs viewer, the GC cron), reported to the Rust `cleo-supervisor` | In use |
| `@cleocode/runtime` (root) | `createRuntime()` and the agent services below (poller, heartbeat, key rotation, SSE) | **Retiring (ADR-098).** No CLI command calls `createRuntime`; the services are removed with the other npm-breaking ADR-098 parts in one announced release. They target the SignalDock backend, which is deprecated (D11176: AgentMBX is CLEO's messaging layer). |

The rest of this README documents the root services as they ship today.

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
│ caller (no CLI command calls it today)   │
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

`createRuntime()` does **not** execute `.cant` workflow profiles. The only
workflow interpreter is the Pi `cant-bridge` extension, which retires with the
Pi/CleoOS harness (ADR-098, which supersedes ADR-035). CLEO keeps deterministic
`.cant` pipelines (`cleo cant execute <file> --pipeline <name>`); CLEO Goal
(ADR-097) is the autonomous driver.

## Testing

```bash
pnpm --filter @cleocode/runtime test
```

Tests use mocked transports from `@cleocode/contracts` to exercise the
poller and service lifecycle without hitting a real backend.

## Related

- [`@cleocode/contracts`](../contracts) — Transport interface and message types
- [`@cleocode/core`](../core) — agent registry, credential storage, message persistence
- [`packages/cleo/src/dispatch/adapters/cli.ts`](../cleo/src/dispatch/adapters/cli.ts) — the CLI adapter over the gateway dispatcher
- [`docs/adr/adr-035-pi-v2-v3-harness.md`](../../docs/adr/adr-035-pi-v2-v3-harness.md) — the original runtime/Pi boundary (superseded by ADR-098)

## License

MIT
