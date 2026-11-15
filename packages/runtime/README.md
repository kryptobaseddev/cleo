# @cleocode/runtime

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

Runtime layer for CLEO. It has three parts, exported as separate subpaths:

| Subpath | What it is | Status |
|---|---|---|
| `@cleocode/runtime/gateway` (+ `/gateway/dispatch`, `/gateway/http`, `/gateway/rpc`, `/gateway/mcp`) | The transport-agnostic dispatcher behind the CLI. The CLI adapter injects the domain handlers and middleware (`packages/cleo/src/dispatch/adapters/cli.ts`). `/gateway/http` is the HTTP gateway with the versioned `/v1` REST facade, which `cleo daemon serve` starts (loopback `127.0.0.1:7777` by default) | Kept (ADR-098). The MCP server under `/gateway/mcp` is not wired to any command; wiring it as `cleo mcp serve` or deleting it is an open owner call in ADR-098. |
| `@cleocode/runtime/daemon` | `defineSubsystem` and `SubsystemRegistry`: one `start → healthProbe → shutdown` lifecycle for long-running concerns. `cleo web` and `cleo docs-viewer` run as subsystems built with it; the core GC subsystem (`createGcSubsystem`) implements the same `Subsystem` contract. Also ships the NDJSON IPC clients for the Rust `cleo-supervisor` | In use |
| `@cleocode/runtime` (root) | `createRuntime()`, the agent services (poller, heartbeat, key rotation, SSE) and the sentient subsystem adapter (`createSentientSubsystem`, `bootstrapSentientRegistry`) | **Frozen for removal (ADR-098).** Nothing in the CLI imports the root entry. ADR-098 deletes the services and the sentient subsystem host together with the other npm-breaking parts, in one announced release, after a release has shipped the freeze. The services were built for SignalDock, which is retired; AgentMBX is CLEO's messaging layer (D11176). |

The rest of this README documents the frozen root exports as they ship today.

## Install

```bash
pnpm add @cleocode/runtime
```

## Public API (root)

```ts
import {
  createRuntime,
  type RuntimeConfig,
  type RuntimeHandle,
  AgentPoller,
  HeartbeatService,
  KeyRotationService,
  SseConnectionService,
  createSentientSubsystem,
  bootstrapSentientRegistry,
} from '@cleocode/runtime';
```

### `createRuntime(registry, config?)`

Resolves an agent credential from the registry (`config.agentId`, else the active agent), resolves and connects a transport, configures the poller and the ancillary services, and returns a `RuntimeHandle`. `registry` is an `AgentRegistryAPI` (`@cleocode/contracts`); core's implementation is `AgentRegistryAccessor`. It throws when no agent credential is found.

```ts
import { createRuntime } from '@cleocode/runtime';
import { AgentRegistryAccessor } from '@cleocode/core/internal';

const registry = new AgentRegistryAccessor('/path/to/project');
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
  agentId?: string;              // defaults to the active agent
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

`heartbeat` and `keyRotation` are `null` when disabled or when the credential's base URL is a retired SignalDock host (T13169). `stop()` stops the poller, heartbeat, key rotation and SSE connection, then disconnects the transport.

## Services

### `AgentPoller`

The polling loop. Fetches direct messages and group-conversation messages that mention the agent on a configurable interval, deduplicates by message ID across both sources, and dispatches each new message to the handlers registered with `onMessage()`.

### `HeartbeatService`

Sends a periodic online-status heartbeat to the agent's cloud API. Failures are retried silently. A retired SignalDock host is refused before any network I/O. Disabled when `heartbeatIntervalMs === 0`.

### `KeyRotationService`

Checks the credential's age on an interval and calls the registry's `rotateKey()` once it is older than `maxKeyAgeMs`. A failed rotation is retried on the next check. Disabled when `maxKeyAgeMs === 0`.

### `SseConnectionService`

Optional persistent Server-Sent Events connection for real-time delivery, started only when an SSE endpoint and a `createSseTransport` factory are both present. When the SSE transport falls back to HTTP polling, the service keeps running.

### Sentient subsystem

`createSentientSubsystem` expresses the sentient daemon lifecycle as one `Subsystem` for hosts that drive a `SubsystemRegistry`; `bootstrapSentientRegistry(projectRoot, opts?)` boots the sentient daemon through a `SubsystemRegistry`, installing SIGTERM/SIGINT handlers that shut it down. ADR-098 removes this host along with the services.

## Transport resolution

When `config.transport` is not given, `createRuntime()` uses core's `conduit.resolveTransport()` (`packages/core/src/conduit/factory.ts`):

1. `LocalTransport` when the project store exists: messages are read and written in the project `cleo.db`, with no network.
2. `SseTransport` when the credential is cloud-backed and has an SSE endpoint.
3. `HttpTransport` otherwise. Its `connect()` refuses a retired SignalDock host.

```
caller (nothing in the CLI calls it today)
        │
        ▼
@cleocode/runtime  createRuntime()
  AgentPoller · HeartbeatService · KeyRotationService · SseConnectionService
        │
        ▼
Transport (@cleocode/contracts), resolved by core conduit: Local | SSE | HTTP
```

## CANT profile execution

`createRuntime()` does **not** execute `.cant` workflow profiles. CLEO runs deterministic `.cant` pipelines with `cleo cant execute <file> --pipeline <name>`; LLM-dependent constructs go through the Pi `cant-bridge` extension (`packages/cleo-os/extensions/cleo-cant-bridge.ts`), which retires with the Pi/CleoOS harness (ADR-098, which supersedes ADR-035). CLEO Goal (ADR-097) is the autonomous driver.

## Testing

```bash
pnpm --filter @cleocode/runtime test
```

Tests live in `src/__tests__/`, `src/daemon/__tests__/` and `src/gateway/**/__tests__/`.

## Related

- [`@cleocode/contracts`](../contracts): Transport interface, `AgentRegistryAPI`, `Subsystem` and message types
- [`@cleocode/core`](../core): agent registry, credential storage, conduit transports
- [`packages/cleo/src/dispatch/adapters/cli.ts`](../cleo/src/dispatch/adapters/cli.ts): the CLI adapter over the gateway dispatcher
- [`docs/adr/adr-035-pi-v2-v3-harness.md`](../../docs/adr/adr-035-pi-v2-v3-harness.md): the original runtime/Pi boundary (superseded by ADR-098)

## License

MIT
