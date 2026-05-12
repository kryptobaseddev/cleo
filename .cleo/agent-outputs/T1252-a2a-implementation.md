# T1252 CONDUIT A2A Implementation — Lead B1

**Date**: 2026-04-23
**Task**: T1252 (CONDUIT A2A implementation — SDK + schema + CLI + spawn integration)
**Parent Epic**: T1149 (Wave 9: Conduit Agent-to-Agent Communication)
**Commit**: fdd8838bfa404ffcb894d38be26cc4e9618ff82e (task/T1252)

---

## What Was Implemented

### 1. Envelope Extension (`packages/contracts/src/conduit.ts`)

`ConduitMessage` extended with 4 new optional fields (backward-compatible):
- `kind?: 'message' | 'request' | 'notify' | 'subscribe'` (defaults to `'message'`)
- `fromPeerId?: string` — stable peer identity from PeerIdentity.peerId
- `toPeerId?: string | null` — null for topic broadcasts
- `payload?: Record<string, unknown>` — structured JSON payload

New types added: `ConduitTopicSubscribeOptions`, `ConduitTopicPublishOptions`

`Conduit` and `Transport` interfaces extended with 4 optional topic methods:
`subscribeTopic`, `publishToTopic`, `onTopic`, `unsubscribeTopic`

### 2. Schema Migration (`packages/core/src/store/conduit-sqlite.ts`)

4 new A2A tables added to `CONDUIT_SCHEMA_SQL` (idempotent via `CREATE TABLE IF NOT EXISTS`):
- `topics` — named coordination channels with epic_id/wave_id
- `topic_subscriptions` — agent-to-topic links
- `topic_messages` — broadcast messages with kind/payload
- `topic_message_acks` — per-subscriber delivery tracking

Schema version bumped to `2026.4.23`. Migration record `2026-04-23-000000_t1252_a2a_topics` written.

### 3. LocalTransport Topic Methods (`packages/core/src/conduit/local-transport.ts`)

5 new public methods:
- `subscribeTopic(topicName, options?)` — creates topic + subscription row (idempotent)
- `publishToTopic(topicName, content, options?)` — writes to topic_messages + notifies in-process handlers
- `onTopic(topicName, handler)` — registers real-time handler with cross-process poll timer
- `unsubscribeTopic(topicName)` — removes subscription row
- `pollTopic(topicName, options?)` — one-shot query for topic messages

Helper: `parseTopicName()` extracts epic_id/wave_id from topic name strings.

State extended with `topicHandlers: Map`, `topicPollTimer`, `topicLastSeen: Map`.

### 4. ConduitClient Topic SDK Methods (`packages/core/src/conduit/conduit-client.ts`)

4 new methods that delegate to the transport (with clear error if transport lacks topic support):
- `subscribeTopic`, `publishToTopic`, `onTopic`, `unsubscribeTopic`

`publishToTopic` wraps the result in `ConduitSendResult` format.

### 5. CLI Dispatch Operations (`packages/cleo/src/dispatch/domains/conduit.ts`)

3 new operations (all LocalTransport-only with conduit.db availability check):
- `conduit.subscribe` (mutate) — subscribe agent to a named topic
- `conduit.publish` (mutate) — broadcast message to a topic with kind/payload
- `conduit.listen` (query) — one-shot poll for topic messages

`getSupportedOperations()` updated to include all 3 new ops.

### 6. Spawn-Prompt Integration (`packages/core/src/orchestration/spawn-prompt.ts`)

New type `ConduitSubscriptionConfig` added to `BuildSpawnPromptInput`.

`buildConduitSubscriptionBlock()` function generates a `## CONDUIT Subscription` section with:
- Wave topic + coordination topic names (concrete, filled in at spawn time)
- TypeScript SDK usage example
- CLI equivalent commands

Injected for `tier >= 1` when `conduitSubscription` config is provided (after Worktree Setup block).

### 7. E2E Test (`packages/core/src/conduit/__tests__/a2a-topic.test.ts`)

22 new tests across 3 test suites:
- `LocalTransport — A2A Topic Operations` — 16 unit tests
- `ConduitClient — A2A Topic Delegation` — 6 tests including error paths
- `E2E — Two subagents coordinate via CONDUIT topics` — 2 end-to-end tests

E2E test proves atom 5 of T1149: two concurrent agents (Lead A, Lead B, Orchestrator) exchange wave-completion signals via topic pub-sub and verify durable storage.

---

## Quality Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | PASS | commit:fdd8838 + 11 files |
| testsPassed | PASS | 22 new tests pass, 0 regressions |
| qaPassed | PASS | biome CI 0 errors, build complete |
| documented | PASS | CONDUIT-A2A-DESIGN.md |
| securityPassed | PASS | SQLite IPC only, no network surface |
| cleanupDone | PASS | no dead branches, package boundaries respected |

---

## Design Decisions (Ambiguity Resolution)

1. **`since` parameter type** — `pollTopic()` uses `number` (unix seconds) not `string` (ISO)
   to be consistent with the SQLite integer column type. The CLI `listen` op converts ISO→unix.

2. **`onTopic` vs cross-process delivery** — in-process delivery is synchronous (publishToTopic
   calls notifyTopicHandlers immediately). Cross-process delivery requires the 1s poll timer
   started by `onTopic`. This matches the existing `subscribe()` pattern.

3. **Topic auto-creation on publish** — publishers can create topics lazily (no prior subscribe
   needed) to support orchestrator-first broadcast patterns.

4. **Transport interface** — topic methods added as optional to `Transport` to avoid breaking
   HttpTransport/SseTransport (which don't implement them). ConduitClient checks presence.

---

## Files Changed

- `packages/contracts/src/conduit.ts` — envelope extension + new topic types
- `packages/contracts/src/transport.ts` — optional topic methods on Transport interface
- `packages/contracts/src/operations/conduit.ts` — subscribe/publish/listen operation contracts
- `packages/contracts/src/index.ts` — export new types
- `packages/core/src/conduit/conduit-client.ts` — 4 new SDK methods
- `packages/core/src/conduit/local-transport.ts` — 5 new topic methods + state extensions
- `packages/core/src/store/conduit-sqlite.ts` — 4 new A2A tables in schema
- `packages/cleo/src/dispatch/domains/conduit.ts` — 3 new CLI operations
- `packages/core/src/orchestration/spawn-prompt.ts` — CONDUIT Subscription section
- `packages/core/src/conduit/__tests__/a2a-topic.test.ts` — NEW: 22 tests
- `packages/core/src/store/__tests__/conduit-sqlite.test.ts` — EXPECTED_TABLES updated
