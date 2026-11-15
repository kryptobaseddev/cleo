# CLEO Conduit Protocol Specification

**Status**: LEGACY — retiring (owner decision D11176; retirement epic T13933)
**Task**: T5524, T964

> **Conduit is legacy.** Under D11176, AgentMBX is the messaging layer for every
> CLEO agent message. Agents message each other through the AgentMBX `mbx_*` tools
> or the `agentmbx` CLI (for example `agentmbx send`), not through Conduit. SignalDock is
> fully deprecated. Conduit is being cut down to a thin client over AgentMBX with no
> transport of its own, and the rest of it is being removed under T13933.
>
> This document no longer specifies a relay protocol. It records what Conduit code
> still ships, what has been removed, and what is still to be removed. Do not build
> new features on anything here.

---

## 1. What was removed

The relay protocol this spec used to describe (the Rust broker, IPC opcodes, lease
clock, address kinds, delivery state machine) was never built. The parts of Conduit
that did ship have been removed:

| Removed | Where it went |
|---------|---------------|
| The `conduit` dispatch domain and its 8 operations | Removed in T13955. They are no longer in the operations registry or the generated gateway SDK. |
| `cleo conduit status\|peek\|start\|stop\|send\|publish\|subscribe\|listen` | Removed in T13955 |
| `cleo orchestrate conduit-status\|conduit-peek\|conduit-start\|conduit-stop\|conduit-send` | Removed in T13955 |
| `cleo nexus conduit-scan`, `cleo graph living conduit-scan` | Removed in T13955 |
| `cleo agent start\|assign\|wake\|reassign\|watch\|poll\|send` | Removed in T13955. `cleo agent work` still runs its task work loop but no longer starts the conduit message poller. |
| Conduit hook handlers and the `sendConduitEvent` calls on spawn and handoff | Silenced in T13953 |
| The `cleo-conduit-core` Rust crate | Deleted in T13954 (there is no `crates/conduit-*`) |
| The standalone `conduit.db` file | The conduit tables now live in the project `cleo.db` (see §2.2) |
| The SignalDock cloud (`api.signaldock.io`) | Retired. Every outbound call is refused (see §2.1). |

Sources: the changeset `.changeset/remove-conduit-verbs.md` (merge `59ab2cbd4`), the
`packages/cleo/src/cli/commands/agent.ts` header (lines 14-17), and the T13953 task record.

---

## 2. What still ships

### 2.1 Core module `packages/core/src/conduit/`

This module is exported as the `conduit` namespace of `@cleocode/core`
(`packages/core/src/index.ts:45`) and through the `./conduit` and `./conduit/*`
subpath exports. `packages/core/src/conduit/index.ts` exports:

| File | What it holds | State |
|------|---------------|-------|
| `cloud-endpoint.ts` | `conduitFetch`, `assertCloudUrlAllowed`, `installRetiredHostFetchGuard`, `RETIRED_CLOUD_HOSTS` (`['signaldock.io']`), `E_SIGNALDOCK_RETIRED`, `SignalDockRetiredError` | Live. It refuses any SignalDock host before network I/O and at every redirect hop. The CLI installs the global fetch guard before every command (`packages/cleo/src/cli/lazy-command.ts:76`). Moving it out of `conduit/` is pending (T13983). |
| `conduit-client.ts` | `ConduitClient`, the high-level wrapper over a `Transport` | Legacy |
| `factory.ts` | `createConduit`, `resolveTransport` (order: `LocalTransport` when the project store exists, then `SseTransport` when the credential has an SSE endpoint and a non-retired cloud URL, then `HttpTransport`) | Legacy. Also re-exported from `packages/core/src/agents/index.ts:15`. |
| `local-transport.ts` | `LocalTransport`: offline messaging over the `conduit_*` tables in the project `cleo.db` | Legacy |
| `http-transport.ts`, `sse-transport.ts` | Cloud polling and SSE transports | Still in source, but they have no live server to reach. Both refuse a SignalDock URL at connect. `EventSource` is not a global in Node 24 without a flag, so the SSE transport falls back to HTTP polling (`cloud-endpoint.ts` header). |
| `delivery-router.ts`, `local-tui-adapter.ts` | `DeliveryRouter`, `SessionStore`, `LocalTuiChannelAdapter`: an in-memory channel router and an offline terminal channel adapter that ride a `Transport` | Legacy |

The shared types (`Conduit`, `ConduitMessage`, `Transport`, `ChannelAdapter`,
`InboundMsg`, `OutboundReply`) are in `packages/contracts/src/conduit.ts` and
`packages/contracts/src/transport.ts`. Removing the conduit public API is a separate,
announced-release step (T13957, pending).

One caller still writes through Conduit when asked to. The agent event bus
(`packages/core/src/events/event-bus.ts`) defaults to the file transport
(`.cleo/agent-events/<agentId>.jsonl`). It publishes to the `agent.events.<agentId>`
topic through `LocalTransport` only when `CLEO_EVENTS_TRANSPORT=conduit` is set
(lines 7-14, 92-93).

### 2.2 Store: `conduit_*` tables in the project `cleo.db`

`packages/core/src/store/conduit-sqlite.ts` opens the conduit domain through
`openDualScopeDb('project', …)`. `getConduitDbPath()` returns the project `cleo.db`
path (line 159). `CONDUIT_DB_FILENAME = 'conduit.db'` is kept only as a deprecated
constant (line 116). The schema is `packages/core/src/store/schema/cleo-project/conduit.ts`.

| Group | Tables | Planned fate |
|-------|--------|--------------|
| Messaging | `conduit_conversations`, `conduit_messages` (plus the FTS5 index `conduit_messages_fts` and its triggers, from `packages/core/migrations/drizzle-conduit/`), `conduit_message_pins`, `conduit_topics`, `conduit_topic_subscriptions`, `conduit_topic_messages`, `conduit_topic_message_acks` | Dropped by a forward migration (T13956, pending) |
| Delivery jobs | `conduit_delivery_jobs`, `conduit_dead_letters` | Owner decision D010 keeps them. T13956 confirms this with the lead before any drop. |
| Docs history (used by `cleo docs`, `packages/core/src/store/conduit-doc-history.ts`) | `conduit_attachments`, `conduit_attachment_versions`, `conduit_attachment_approvals`, `conduit_attachment_contributors`, `conduit_doc_slug_aliases`, `conduit_doc_heads`, `section_crdt_states` (local-only, no prefix) | Kept (T13933) |
| Agent refs | `conduit_project_agent_refs`, used by `cleo agent attach` / `detach` / `list` (`conduit-sqlite.ts:408-523`) | Kept (T13933) |

`cleo init` and `cleo upgrade` still call `ensureConduitDb()`
(`packages/core/src/init.ts:1547`, `packages/core/src/upgrade.ts:1135`). That opens the
project `cleo.db`; the `conduit.db` label in their output is a leftover name.

For the store layout, see [database-architecture.md](database-architecture.md).

### 2.3 CLI

There is no `cleo conduit` command and no `conduit` dispatch domain. These `cleo agent`
verbs remain. They manage agent credentials and project attachment, not messaging:
`register`, `list`, `get`, `attach`, `detach`, `remove`, `rotate-key`, `work`, and the
others in `packages/cleo/src/cli/commands/agent.ts`. Where they make a cloud call,
they go through `conduitFetch`, so a SignalDock URL is refused without any network I/O.

### 2.4 `@cleocode/runtime` services

`packages/runtime/src/services/` still contains `agent-poller.ts`, `heartbeat.ts`,
`key-rotation.ts` and `sse-connection.ts`. `createRuntime()` in
`packages/runtime/src/index.ts` wires them to a Conduit transport. The CLI does not
call `createRuntime()`; it imports only `@cleocode/runtime/gateway` and
`@cleocode/runtime/daemon`. ADR-098 lists these services for deletion in one announced
release after the freeze has shipped. Until then they ship, frozen, in the published
`@cleocode/runtime` package.

---

## 3. Still to be removed (T13933)

Pending children of T13933 (`cleo list --parent T13933`):

- T13952: record the AgentMBX decisions D008-D010 in CLEO BRAIN.
- T13956: a forward migration that drops the messaging tables and `conduit_messages_fts`.
- T13957: remove the conduit public API in an announced release.
- T13983: move `cloud-endpoint.ts` out of `conduit/` and retire the `cleo agent` runtime loops.
- T13984: mark `cleo-conduit-core` as removed wherever docs and bench comments still describe it.

---

## 4. Sticky boundary

`sticky` is still a separate domain (`packages/cleo/src/dispatch/domains/sticky.ts`).
It is for quick human capture and has never been a message lane. Use AgentMBX for
messages between agents. See [sticky-notes.md](sticky-notes.md).

---

## 5. References

- ADR-037, `docs/adr/adr-037-conduit-signaldock-separation.md` (superseded)
- ADR-098 (`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`)
- [database-architecture.md](database-architecture.md)
- [sticky-notes.md](sticky-notes.md)
