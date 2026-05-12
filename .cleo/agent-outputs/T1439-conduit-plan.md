# T1439 Conduit Dispatch OpsFromCore Plan

Task: T1439 (T1435-W1-conduit)
Domain: conduit
Date: 2026-04-27

## Phase 1 Audit

### CLI Surface

The mandated command scan:

```bash
grep -rn "program\.command\|\.command(\|program\.action\|\.action(" packages/cleo/src/cli/commands/ packages/cleo/src/cli/index.ts packages/cleo/src/cli/program.ts 2>/dev/null | grep -i "conduit" | head -50
```

returned no rows because this CLI uses `citty` command modules rather than Commander `program.command(...)` registrations. The actual conduit command group is `packages/cleo/src/cli/commands/conduit.ts`.

| CLI command | File:line | Flags and aliases | Action body line count | Dispatch path |
|---|---:|---|---:|---|
| `cleo conduit status` | `packages/cleo/src/cli/commands/conduit.ts:25` | `--agent-id`, `-a` | 11 | `dispatchFromCli('query', 'conduit', 'status', ...)` |
| `cleo conduit peek` | `packages/cleo/src/cli/commands/conduit.ts:48` | `--agent-id`, `-a`; `--limit` default `"20"` parsed with `Number.parseInt` | 12 | `dispatchFromCli('query', 'conduit', 'peek', ...)` |
| `cleo conduit start` | `packages/cleo/src/cli/commands/conduit.ts:80` | `--agent-id`, `-a`; `--interval` default `"5000"` parsed with `Number.parseInt` | 12 | `dispatchFromCli('mutate', 'conduit', 'start', ...)` |
| `cleo conduit stop` | `packages/cleo/src/cli/commands/conduit.ts:109` | none | 11 | `dispatchFromCli('mutate', 'conduit', 'stop', {})` |
| `cleo conduit send` | `packages/cleo/src/cli/commands/conduit.ts:125` | `--to`; required `--content`; `--conversation-id`; `--agent-id`, `-a` | 14 | `dispatchFromCli('mutate', 'conduit', 'send', ...)` |
| `cleo conduit publish` | `packages/cleo/src/cli/commands/conduit.ts:164` | required `--topic`; `--kind` default `"message"`; `--payload`; `--content`; `--agent-id`, `-a` | 27 | `dispatchFromCli('mutate', 'conduit', 'publish', ...)` |
| `cleo conduit subscribe` | `packages/cleo/src/cli/commands/conduit.ts:228` | required `--topic`; `--agent-id`, `-a` | 12 | `dispatchFromCli('mutate', 'conduit', 'subscribe', ...)` |
| `cleo conduit listen` | `packages/cleo/src/cli/commands/conduit.ts:264` | required `--topic`; `--limit` default `"50"` parsed with `Number.parseInt`; `--since`; `--agent-id`, `-a` | 14 | `dispatchFromCli('query', 'conduit', 'listen', ...)` |

Root command behavior at `packages/cleo/src/cli/commands/conduit.ts:317` registers exactly eight subcommands. If invoked without a valid subcommand, it calls `showUsage(cmd)`.

### Dispatch Surface

Mandatory dispatch scan:

```bash
ls packages/cleo/src/dispatch/domains/conduit*
wc -l packages/cleo/src/dispatch/domains/conduit.ts
grep -nE "^\s*[a-zA-Z_]+:\s*async" packages/cleo/src/dispatch/domains/conduit.ts | head -30
```

Results:

| Item | Result |
|---|---|
| Domain files | `packages/cleo/src/dispatch/domains/conduit.ts` |
| LOC | 876 |
| Query ops | `status` line 58, `peek` line 78, `listen` line 94 |
| Mutate ops | `start` line 123, `stop` line 147, `send` line 163, `subscribe` line 184, `publish` line 204 |
| Supported op sets | `QUERY_OPS = ['status', 'peek', 'listen']`, `MUTATE_OPS = ['start', 'stop', 'send', 'subscribe', 'publish']` |

### Core Surface

Mandatory Core scan:

```bash
ls packages/core/src/conduit/
grep -rn "^export (async )\?function" packages/core/src/conduit/ --include='*.ts' | head -30
```

Results:

| File | Existing exports |
|---|---|
| `packages/core/src/conduit/index.ts` | `ConduitClient`, `createConduit`, `resolveTransport`, `HttpTransport`, `LocalTransport`, `SseTransport` |
| `packages/core/src/conduit/factory.ts` | `resolveTransport(credential)`, `createConduit(registry, agentId?)` |
| `packages/core/src/conduit/conduit-client.ts` | `ConduitClient` class |
| `packages/core/src/conduit/local-transport.ts` | `LocalTransport` class |
| `packages/core/src/conduit/http-transport.ts` | `HttpTransport` class |
| `packages/core/src/conduit/sse-transport.ts` | `SseTransport` class |

There are no normalized conduit operation functions today. Moving `start`/`stop` runtime behavior fully into Core would create a `@cleocode/core` -> `@cleocode/runtime` cycle because `@cleocode/runtime` already depends on `@cleocode/core`. For T1439, follow the completed T1437 admin pattern: add a Core-owned operation signature registry and keep runtime behavior unchanged in dispatch.

### Behavior Contracts To Preserve

| Operation | Behavior contract |
|---|---|
| `status` | Resolves explicit `agentId` or active agent; returns local unread count when `conduit.db` exists; falls back to HTTP inbox; HTTP non-OK returns success with `connected: false`, `transport: 'http'`, and `error: "API returned <status>"`. |
| `peek` | Resolves explicit `agentId` or active agent; local transport polls `limit ?? 20` and ACKs returned messages; HTTP path queries `/messages/peek?mentioned=<agentId>&limit=<limit>`; HTTP non-OK returns empty `messages`. |
| `listen` | Requires `topicName`; local transport only; missing topic name returns `E_ARGS` with `Must specify "topicName"`; missing `conduit.db` returns `E_CONDUIT` with `conduit.db not found -- run: cleo init`; converts ISO `since` to Unix seconds; default limit is 50. |
| `start` | Idempotent if poller already active; returns `Poller already running. Use conduit.stop first.`; otherwise creates `AgentPoller` with `pollIntervalMs ?? 5000`; uses local transport when available, otherwise HTTP. |
| `stop` | If no poller is active, returns success with `No active poller to stop.`; otherwise stops the active poller, clears singleton state, and returns `Polling stopped.` |
| `send` | Requires one of `to` or `conversationId`; missing both returns `E_ARGS` with `Must specify "to" (agent ID) or "conversationId"`; local transport writes directly to `conduit.db`; HTTP path posts to either `/messages` or `/conversations/<id>/messages`; HTTP send failure returns `E_SEND` with `Send failed: <status> <body>`. |
| `subscribe` | Requires `topicName`; local transport only; missing `conduit.db` returns `E_CONDUIT`; success message is `Subscribed to topic: <topicName>`. |
| `publish` | Requires `topicName` and `content`; local transport only; CLI content defaults to `--payload` or `{}` when `--content` is omitted; invalid JSON payload is preserved as `{ raw: <payload> }`; default kind is `message`. |

Output and exit behavior is shared through `dispatchFromCli`:

- Success calls `cliOutput(response.data, { command: 'conduit <subcommand>', operation: 'conduit.<op>' })`.
- Errors call `cliError(...)` and `process.exit(exitCode)`.
- `E_INVALID_OPERATION` exits 2 through `ERROR_CODE_TO_EXIT`.
- Existing conduit-specific `E_ARGS` and `E_CONDUIT` are not mapped and therefore exit 1.
- `E_SEND` is not mapped and therefore exits 1.

### Dispatch Bypass Paths

No `cleo conduit <subcommand>` bypasses dispatch. Every conduit CLI subcommand routes through `dispatchFromCli`.

Adjacent non-domain paths exist and are out of scope for T1439:

- `packages/cleo/src/cli/commands/agent.ts` calls `createConduit(...)` for agent messaging flows.
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` sends conduit events directly.
- `packages/core/src/orchestration/spawn-prompt.ts` emits example `cleo conduit ...` commands.

These paths are not part of the `cleo conduit` CLI command group and will not be touched.

## Phase 2 Plan

### Per-CLI-Command Migration Table

| Command | Current behavior summary | Target type source | What stays in CLI | What moves/changes |
|---|---|---|---|---|
| `conduit status` | Thin dispatch with optional `agentId`. | `conduitCoreOps.status` signature. | Flag parsing, alias `-a`, output rendering through `dispatchFromCli`. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit peek` | Thin dispatch with optional `agentId` and parsed numeric limit. | `conduitCoreOps.peek` signature. | Flag parsing, default `"20"`, numeric parsing, rendering. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit start` | Thin dispatch with optional `agentId` and parsed interval. | `conduitCoreOps.start` signature. | Flag parsing, default `"5000"`, numeric parsing, rendering. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit stop` | Thin dispatch with empty params. | `conduitCoreOps.stop` signature. | Empty CLI params, rendering. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit send` | Thin dispatch with `to`, required `content`, optional `conversationId`, optional `agentId`. | `conduitCoreOps.send` signature. | Required flag behavior, aliases, rendering. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit publish` | Thin dispatch; content fallback to payload or `{}`; JSON parse fallback to `{ raw }`. | `conduitCoreOps.publish` signature. | All flag parsing, content fallback, payload normalization, rendering. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit subscribe` | Thin dispatch with required topic and optional `agentId`. | `conduitCoreOps.subscribe` signature. | Flag parsing, alias `-a`, rendering. | Dispatch param type inferred via `OpsFromCore`. |
| `conduit listen` | Thin dispatch with required topic, parsed numeric limit, optional since and agent. | `conduitCoreOps.listen` signature. | Flag parsing, default `"50"`, numeric parsing, rendering. | Dispatch param type inferred via `OpsFromCore`. |

### New Contract Types Needed

None. Existing `packages/contracts/src/operations/conduit.ts` types remain the wire contract and are still referenced by `ConduitOps`. Per AGENTS.md, shared types stay in `packages/contracts/src/`.

No per-op contract types will be deleted unless a grep proves they are unreferenced after implementation. The planned Core signature registry intentionally references `ConduitOps`, so the per-op contract declarations remain referenced and must be preserved.

### New Core Signatures To Author

Add `packages/core/src/conduit/ops.ts` as a type-only signature registry, mirroring the completed T1437 `adminCoreOps` pattern:

```ts
import type { ConduitOps } from '@cleocode/contracts';

type ConduitOpName = keyof ConduitOps;
type ConduitOpParams<Op extends ConduitOpName> = ConduitOps[Op][0];
type ConduitOpResult<Op extends ConduitOpName> = ConduitOps[Op][1];
type ConduitCoreOperation<Op extends ConduitOpName> = (
  params: ConduitOpParams<Op>,
) => Promise<ConduitOpResult<Op>>;

export declare const conduitCoreOps: {
  readonly status: ConduitCoreOperation<'status'>;
  readonly peek: ConduitCoreOperation<'peek'>;
  readonly listen: ConduitCoreOperation<'listen'>;
  readonly start: ConduitCoreOperation<'start'>;
  readonly stop: ConduitCoreOperation<'stop'>;
  readonly send: ConduitCoreOperation<'send'>;
  readonly subscribe: ConduitCoreOperation<'subscribe'>;
  readonly publish: ConduitCoreOperation<'publish'>;
};
```

Export it from `packages/core/src/conduit/index.ts` as a type-only export. This places the operation signature source in Core without changing runtime behavior or creating a Core/runtime dependency cycle.

### Dispatch Refactor

Update `packages/cleo/src/dispatch/domains/conduit.ts`:

1. Replace per-op `Conduit*Params` and `ConduitOps` imports from `@cleocode/contracts`.
2. Import `type { conduit as coreConduit } from '@cleocode/core'`.
3. Import `type OpsFromCore` from `../adapters/typed.js`.
4. Add `type ConduitOps = OpsFromCore<typeof coreConduit.conduitCoreOps>;`.
5. Remove explicit per-op handler parameter annotations and let `defineTypedHandler<ConduitOps>` infer params.
6. Preserve all implementation bodies, helper functions, singleton poller state, operation sets, error messages, and output wrapping.

Code placed in `packages/core/src/conduit/` and `packages/cleo/src/dispatch/domains/` per Package-Boundary Check -- verified against AGENTS.md.

### Regression-Test Plan

Add a focused regression test in `packages/cleo/src/dispatch/domains/__tests__/conduit-opsfromcore.test.ts` that verifies:

- `packages/cleo/src/dispatch/domains/conduit.ts` contains `type ConduitOps = OpsFromCore<typeof coreConduit.conduitCoreOps>;`
- The dispatch file does not import per-op `Conduit*Params`/`Conduit*Result` types from `@cleocode/contracts`.
- The Core conduit index exposes `conduitCoreOps`.

Run existing conduit tests:

```bash
pnpm exec vitest run packages/cleo/src/dispatch/domains/__tests__/conduit.test.ts packages/cleo/src/cli/commands/__tests__/conduit.test.ts packages/cleo/src/dispatch/domains/__tests__/conduit-opsfromcore.test.ts
```

### Smoke Plan

Before code changes, capture a baseline using the built CLI in an isolated project under `/tmp/smoke-conduit-baseline`.

After code changes, rebuild and run the same commands in `/tmp/smoke-conduit-after`.

Commands to smoke:

1. `cleo conduit`
2. `cleo conduit status --agent-id smoke-agent`
3. `cleo conduit peek --agent-id smoke-agent --limit 1`
4. `cleo conduit start --agent-id smoke-agent --interval 1000`
5. `cleo conduit stop`
6. `cleo conduit send --to peer --content "hello" --agent-id smoke-agent`
7. `cleo conduit publish --topic smoke.topic --content "hello" --kind notify --agent-id smoke-agent`
8. `cleo conduit publish --topic smoke.topic --payload '{"ok":true}' --agent-id smoke-agent`
9. `cleo conduit subscribe --topic smoke.topic --agent-id smoke-agent`
10. `cleo conduit listen --topic smoke.topic --limit 1 --agent-id smoke-agent`

Expected smoke result in a fresh isolated project without a registered agent: command outputs and exit codes must match baseline. Some commands fail before transport access with the existing credential error; that failure is a behavior contract and must be preserved exactly.

### Atomic Commits

1. `docs(T1439): record conduit migration plan`
2. `feat(T1439): infer conduit dispatch ops from Core signatures`
3. `test(T1439): lock conduit OpsFromCore dispatch shape`

