# CONDUIT Infrastructure Audit — T1251 Lead A1

**Date**: 2026-04-23  
**Task**: T1251 (CONDUIT Audit + A2A Envelope Design)  
**Parent Epic**: T1149 (Wave 9: Conduit Agent-to-Agent Communication)  
**Decision**: D023 (SDK-first — core SDK primitives before CLI surface)

---

## Executive Summary

CONDUIT is the agent-to-agent messaging subsystem for CLEO. Current implementation provides:
- **LocalTransport**: In-process SQLite (conduit.db) for offline, project-scoped messaging
- **HttpTransport**: Cloud-backed polling via SignalDock REST API
- **SseTransport**: Real-time server-sent events (infrastructure, not yet dogfood)
- **ConduitClient**: High-level abstraction wrapping any Transport
- **CLI Surface**: 5 operations (status, peek, start, stop, send) via dispatch

**Current Maturity**: Write-complete for direct agent messaging. Read-complete for polling. Ready for extension. All major gaps identified below.

---

## Part 1: Per-File Surface Map

### `packages/core/src/conduit/conduit-client.ts` (~130 lines)

**Purpose**: High-level agent messaging abstraction over Transport adapters.

**Public Surface**:
- `class ConduitClient implements Conduit`
  - Constructor: `(transport: Transport, credential: AgentCredential)`
  - Methods:
    - `async connect(): Promise<void>` — establish backend connection
    - `async send(to: string, content: string, options?: ConduitSendOptions): Promise<ConduitSendResult>` — send message to agent or thread
    - `async poll(options?: { limit?, since? }): Promise<ConduitMessage[]>` — one-shot poll
    - `onMessage(handler: (msg: ConduitMessage) => void): ConduitUnsubscribe` — subscribe to incoming messages
    - `async heartbeat(): Promise<void>` — send keepalive ping
    - `async isOnline(agentId: string): Promise<boolean>` — check remote agent status
    - `async disconnect(): Promise<void>` — close backend connection
    - `getState(): ConduitState` — query connection state
  - Property: `agentId: string` (read-only, from credential)

**What it Does Today**:
- Wraps a Transport implementation to provide consistent API surface
- Delegates `send()`, `poll()`, `subscribe()` to the underlying transport
- State machine: `disconnected → connecting → (connected | error)` with explicit error-state recovery
- Falls back from real-time subscription to polling loop when transport doesn't support `subscribe()`
- Uses credential's `transportConfig.pollIntervalMs` (default 5000ms) for fallback polling

**Gaps for A2A Mesh Coordination**:
- No envelope metadata (no `fromPeerId`, `toPeerId`, `threadId`, `kind: request|notify|subscribe`)
- `send()` accepts only `to: string` (agent ID or conversation ID); no structured kind/payload routing
- No "topic subscription" API — only direct agent message subscription
- No "publish to topic" primitive (required for Wave-9 orchestrator coordination room)
- `onMessage` handler receives only `ConduitMessage`; no way to receive notifications separately from requests
- No acknowledgment strategy for delivered messages at the SDK level (only at transport level via `ack()`)

**Tests**: `/mnt/projects/cleocode/packages/core/src/conduit/__tests__/conduit-client.test.ts` (coverage: connect, state machine, send, poll)

---

### `packages/core/src/conduit/local-transport.ts` (~300 lines)

**Purpose**: In-process SQLite transport for fully offline agent-to-agent messaging within a project.

**Public Surface**:
- `class LocalTransport implements Transport`
  - Constructor: `()` (no args)
  - Static method: `isAvailable(projectRoot?: string): boolean` — checks if conduit.db exists
  - Methods:
    - `async connect(config: TransportConnectConfig): Promise<void>` — open conduit.db
    - `async disconnect(): Promise<void>` — close database and stop polling
    - `async push(to: string, content: string, options?: { conversationId?, replyTo? }): Promise<{ messageId }>`
    - `async poll(options?: { limit?, since? }): Promise<ConduitMessage[]>` — query pending messages
    - `async ack(messageIds: string[]): Promise<void>` — mark messages delivered
    - `subscribe(handler: (msg: ConduitMessage) => void): ConduitUnsubscribe` — real-time subscription via polling timer
  - Property: `name: string = 'local'`

**What it Does Today**:
- Opens conduit.db from `.cleo/conduit.db` (via `getConduitDbPath()`)
- Reads/writes messages directly from/to SQLite tables: `conversations`, `messages`, `delivery_jobs`, `dead_letters`
- Auto-creates direct-message (DM) conversation if needed (via `ensureDmConversation()`)
- Priority-ordered message selection (oldest-first, `where to_agent_id = ? and status = 'pending'`)
- Subscriber polling loop: sets interval-based timer to call `poll()` + notify handlers
- Message acknowledgment: updates `status = 'delivered'` and sets `delivered_at` timestamp
- FTS5 full-text search support on message content (via triggers on insert/update/delete)
- All I/O is transactional (WAL mode, foreign keys enabled, busy timeout 5s)

**Gaps for A2A Mesh Coordination**:
- No message routing by `kind: request|notify|subscribe` — all messages treated as peer-to-peer chats
- No topic subscription table (required for Lead-to-Lead coordination room)
- No "queue for topic subscribers" logic — `push()` writes to a conversation, not a topic
- Dead-letter queue exists (`dead_letters` table) but has no mechanism for replay or notification
- Subscription handler receives raw `ConduitMessage`; no way to distinguish request/notify/subscribe envelopes
- Conversation system is bidirectional (participants = both agents); topics would need one-to-many broadcast pattern
- No envelope metadata columns (would need `kind`, `threadId` stored separately from `content`)

**Tests**: `/mnt/projects/cleocode/packages/core/src/conduit/__tests__/local-transport.test.ts` (coverage: connect, push, poll, ack, FTS)

---

### `packages/core/src/conduit/http-transport.ts` (~180 lines)

**Purpose**: Cloud-backed HTTP polling transport for agents without local conduit.db.

**Public Surface**:
- `class HttpTransport implements Transport`
  - Constructor: `()` (no args)
  - Methods:
    - `async connect(config: TransportConnectConfig): Promise<void>` — verify API connectivity
    - `async disconnect(): Promise<void>` — no-op (stateless)
    - `async push(to: string, content: string, options?: { conversationId? }): Promise<{ messageId }>`
    - `async poll(options?: { limit?, since? }): Promise<ConduitMessage[]>` — HTTP GET to `/messages/peek`
    - `async ack(messageIds: string[]): Promise<void>` — HTTP POST to mark read
  - Property: `name: string = 'http'`

**What it Does Today**:
- Sends HTTP requests to `credential.apiBaseUrl` (SignalDock cloud API)
- `push()`: POST to `/messages` (DM) or `/conversations/{id}/messages` (thread)
- `poll()`: GET with `mentioned=<agentId>&limit=<n>` parameters; auto-ACK on read
- Maps response fields: `senderAgentId` → `from`, `conversationId` → `threadId`, `createdAt` → `timestamp`
- Bearer token auth via `Authorization: Bearer <apiKey>` header
- Stateless: can be shared across multiple concurrent consumers

**Gaps for A2A Mesh Coordination**:
- No topic-based subscription (cloud API may support it; SDK layer doesn't expose)
- No envelope versioning (can't handle `kind: request|notify|subscribe` until cloud API adds support)
- No message kind filtering — poll returns all messages

**Tests**: `/mnt/projects/cleocode/packages/core/src/conduit/__tests__/http-transport.test.ts`

---

### `packages/core/src/conduit/sse-transport.ts` (~150 lines)

**Purpose**: Server-sent events real-time transport (infrastructure complete, not yet integrated with agents).

**Public Surface**:
- `class SseTransport implements Transport`
  - Constructor: `()` (no args)
  - Methods: same as HttpTransport (push, poll, ack, connect, disconnect)
  - Additional:
    - `subscribe(handler: (msg: ConduitMessage) => void): ConduitUnsubscribe` — real-time SSE event handler

**What it Does Today**:
- Opens persistent SSE connection to `credential.apiBaseUrl + '/agents/me/messages/stream'`
- Parses incoming SSE events as JSON and emits to subscribers
- Provides `poll()` fallback for non-streaming transports
- Auto-reconnects on connection drop

**Gaps for A2A Mesh Coordination**:
- Same topic-subscription gaps as HttpTransport
- No envelope kind filtering in SDK layer

---

### `packages/core/src/conduit/factory.ts` (~70 lines)

**Purpose**: Auto-selects appropriate Transport based on agent credential and project state.

**Public Surface**:
- Function: `resolveTransport(credential: AgentCredential): Transport` — returns best available Transport
  - Priority: LocalTransport (if conduit.db exists) > SseTransport (if credential has SSE endpoint) > HttpTransport (fallback)
- Function: `async createConduit(registry: AgentRegistryAPI, agentId?: string): Promise<Conduit>` — resolve credential, create Transport, wrap in ConduitClient

**What it Does Today**:
- LocalTransport priority is hardcoded (line 34): `if (LocalTransport.isAvailable()) return new LocalTransport()`
- Checks `credential.transportConfig.sseEndpoint` for SSE preference
- D016 decision (April 2026): LocalTransport always prioritized when conduit.db exists, even if agent has cloud credentials

**Gaps for A2A Mesh Coordination**:
- No per-topic transport selection (would need topic-aware routing)
- Transport selection is per-agent, not per-message (can't route different kinds through different transports)

---

### `packages/core/src/store/conduit-sqlite.ts` (~450 lines)

**Purpose**: Project-tier SQLite database initialization and schema for conduit.db.

**Public Surface**:
- Constant: `CONDUIT_DB_FILENAME = 'conduit.db'`
- Constant: `CONDUIT_SCHEMA_VERSION = '2026.4.12'`
- Function: `getConduitDbPath(projectRoot: string): string` — returns `<projectRoot>/.cleo/conduit.db`
- Function: `applyConduitSchema(db: DatabaseSync): void` — applies full DDL idempotently
- Function: `async ensureConduitDb(projectRoot: string): Promise<DatabaseSync>` — open/create with schema bootstrap
- Function: `async closeConduitDb(): Promise<void>` — close singleton handle

**Schema Tables** (created via CREATE TABLE IF NOT EXISTS):
- `conversations` — DM threads (id, participants, visibility, message_count, created_at, updated_at)
- `messages` — agent messages (id, conversation_id FK, from_agent_id, to_agent_id, content, status, attachments, created_at, delivered_at, read_at)
- `messages_fts` — FTS5 virtual table for full-text search
- `delivery_jobs` — async delivery queue (status pending→delivered→dead, with retry logic)
- `dead_letters` — failed delivery archive (message_id, reason, attempts, created_at)
- `message_pins` — pinned messages in conversations
- `attachments` — blob storage with versioning
- `attachment_versions` — collaborative editing history
- `attachment_approvals` — review workflow
- `attachment_contributors` — edit statistics
- `project_agent_refs` — per-project agent override table (added ADR-037, T1075)
- `_conduit_meta` — schema version tracking
- `_conduit_migrations` — migration audit log

**What it Does Today**:
- Provides path helper for `.cleo/conduit.db` (project-tier isolation per ADR-037)
- Applies schema idempotently on first open (via `CREATE TABLE IF NOT EXISTS`)
- Stores schema version and migration history
- Full-text search on message content via FTS5 triggers
- Attachment versioning + approval workflow (mature feature)
- Async delivery queue with dead-letter handling

**Gaps for A2A Mesh Coordination**:
- No `topics` table (required for topic-based subscriptions)
- No `topic_subscribers` table (link agent to topic)
- No `subscriptions` table (record subscribe/unsubscribe events)
- No envelope metadata columns (kind, threadId are inferred from conversation structure)
- No message kind column (all messages are same type)
- Message routing assumes binary (two-agent) conversations; topics are one-to-many

---

### `packages/cleo/src/dispatch/domains/conduit.ts` (~445 lines)

**Purpose**: CLI dispatch surface for CONDUIT operations.

**Public Surface** (5 operations):
- Query operations:
  - `conduit.status` → `ConduitStatusResult` (agentId, connected, transport, pollerRunning, unreadTotal, actionItems)
  - `conduit.peek` → `ConduitPeekResult` (agentId, messages[])
- Mutate operations:
  - `conduit.start` → `ConduitStartResult` (agentId, pollIntervalMs, groupConversationIds, transport, message)
  - `conduit.stop` → `ConduitStopResult` (agentId, message)
  - `conduit.send` → `ConduitSendResult` (messageId, from, to, transport, sentAt)

**What it Does Today**:
- Maintains singleton `activePoller: AgentPoller | null` for persistent polling
- `status`: connects to LocalTransport if available, otherwise queries HTTP API
- `peek`: one-shot poll via LocalTransport or HTTP, ACKs messages after read
- `start`: creates AgentPoller with LocalTransport when available (line 296)
- `stop`: stops active poller and nullifies singleton
- `send`: writes to LocalTransport or HTTP depending on credential + conduit.db availability
- All operations use `AgentRegistryAccessor` to resolve credentials

**Gaps for A2A Mesh Coordination**:
- No `conduit.subscribe` operation (required for topic subscriptions)
- No `conduit.publish` operation (required for topic publishing)
- No `conduit.listen` operation (required for long-running topic watchers)
- All operations default to active agent (no multi-agent coordination built-in)
- No thread/topic routing logic in dispatch (all messages treated as peer-to-peer)

---

### `packages/core/src/hooks/handlers/conduit-hooks.ts` (~200 lines)

**Purpose**: Observes orchestration lifecycle events (SubagentStart, SubagentStop, SessionEnd) and writes structured messages to conduit.db.

**Public Surface**:
- Async function: `handleConduitSubagentStart(projectRoot, payload: SubagentStartPayload): Promise<void>` — send spawn message
- Async function: `handleConduitSubagentStop(projectRoot, payload: SubagentStopPayload): Promise<void>` — send completion message
- Async function: `handleConduitSessionEnd(projectRoot, payload: SessionEndPayload): Promise<void>` — send handoff message
- Helper: `tryGetLocalTransport(projectRoot, transportFactory?): Promise<LocalTransport | null>` — safe connection
- Auto-registers handlers on module load (via `hooks.on()`)

**What it Does Today**:
- Decoupled integration: hooks listen for orchestration events without modifying the orchestrator
- Spawning subagent A → writes `{type: 'subagent.spawn', from: 'cleo-orchestrator', to: <agentId>, taskId}` to conduit
- Completing subagent A → writes `{type: 'subagent.complete', from: <agentId>, to: 'cleo-system', taskId, status}`
- Session end → writes `{type: 'session.handoff', from: 'cleo-orchestrator', to: 'cleo-system', taskId: nextTask}`
- All writes are best-effort (failures swallowed at debug level, never crash orchestration)
- All messages are JSON-in-content (no envelope schema version)

**Gaps for A2A Mesh Coordination**:
- Message format is hardcoded JSON (no versioning or flexibility for envelope changes)
- All lifecycle messages go to fixed recipients (agent ID or 'cleo-system'); no topic routing
- No way for agents to subscribe to orchestration events (would need to poll conduit for spawn messages)

---

### `packages/contracts/src/conduit.ts` (~163 lines)

**Purpose**: TypeScript type contracts for the Conduit protocol (client-side interface).

**Public Types**:
- `interface ConduitMessage` — received message (id, from, content, tags, threadId, groupId, timestamp, metadata)
- `interface ConduitSendOptions` — send parameters (tags, threadId, groupId, metadata)
- `interface ConduitSendResult` — send result (messageId, deliveredAt)
- `type ConduitUnsubscribe = () => void` — subscription cleanup function
- `type ConduitState` — `'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'`
- `interface ConduitStateChange` — state change event (from, to, timestamp, error)
- `interface Conduit` — main protocol interface (send, onMessage, poll, heartbeat, isOnline, connect, disconnect, getState, onStateChange?, agentId)
- `interface ConduitConfig` — factory config (agentId, apiBaseUrl, apiKey, pollIntervalMs, wsUrl)

**Gap**: No envelope types (no `fromPeerId`, `toPeerId`, `kind`, `threadId`, `payload`)

---

### `packages/contracts/src/operations/conduit.ts` (~190 lines)

**Purpose**: Wire-format contracts for CLI + HTTP dispatch (5 operations).

**Public Types**:
- `type ConduitTransportKind = 'local' | 'http' | 'sse' | 'ws'`
- `interface ConduitInboxMessage` — compact projection (id, from, content, conversationId, timestamp)
- `interface ConduitStatusParams`, `ConduitStatusResult`
- `interface ConduitPeekParams`, `ConduitPeekResult`
- `interface ConduitStartParams`, `ConduitStartResult`
- `interface ConduitStopParams`, `ConduitStopResult`
- `interface ConduitSendParams`, `ConduitSendResult`

**Gap**: No subscribe/publish/listen operation contracts

---

### Test Coverage

- **`__tests__/conduit-client.test.ts`** — ConduitClient state machine, connect/disconnect, send, poll
- **`__tests__/factory.test.ts`** — Transport selection logic, credential resolution
- **`__tests__/http-transport.test.ts`** — HTTP API mocking, send/poll/ack
- **`__tests__/local-transport.test.ts`** — SQLite I/O, conversation creation, FTS indexing
- **`__tests__/sse-transport.test.ts`** — SSE event parsing, reconnection
- **`__tests__/local-credential-flow.test.ts`** — credential resolution for LocalTransport

**Total**: ~1500 lines of test code. Good coverage of individual transports. No end-to-end agent coordination tests.

---

## Part 2: Gaps Summary for A2A Mesh Coordination (T1149 Scope)

### 🔴 Critical Gaps — Block T1149 Acceptance

1. **No Topic Subscription API**
   - Existing: `send(to: agent, content)` → bilateral messaging only
   - Missing: `subscribe(topic: epicId.waveId)` → one-to-many broadcast
   - Impact: Leads cannot listen for wave-completion notifications
   - Scope: Add `topics` table + subscription lifecycle to LocalTransport + ConduitClient

2. **No Message Envelope Versioning**
   - Existing: `ConduitMessage` has no `kind`, `fromPeerId`, `toPeerId`, `threadId`
   - Missing: Structured envelope `{fromPeerId, toPeerId, threadId, kind: request|notify|subscribe, payload}`
   - Impact: Can't distinguish Lead-to-Lead coordination requests from agent lifecycle messages
   - Scope: Extend `ConduitMessage` type; update all transports + SDK

3. **No Topic Publisher/Broker**
   - Existing: LocalTransport writes to `conversations` (binary) only
   - Missing: `publish(topic, message)` → writes to topic + broadcasts to all subscribers
   - Impact: Orchestrator can't send wave-completion notifications to waiting Leads
   - Scope: Add `topics` + `topic_subscriptions` + `topic_messages` tables; new LocalTransport methods

4. **No Spawn-Prompt Integration Hook**
   - Existing: `cleo orchestrate spawn` returns task description + protocol
   - Missing: `## CONDUIT Subscription` section in spawn prompt template
   - Impact: Subagents don't know they should subscribe to coordination topics
   - Scope: Update `packages/core/src/orchestrate/spawn-prompt.ts` to inject topic names

### 🟡 High-Priority Gaps — Enable Wave-9 Implementation

5. **No Dead-Letter Replay Mechanism**
   - Existing: `dead_letters` table captures failed deliveries
   - Missing: Replay orchestrator (retry with original context) + originating-agent notification
   - Impact: Agents don't know when their published messages failed
   - Scope: Add replay queue + notification to originating agent

6. **No Acknowledgment Strategy for SDK**
   - Existing: LocalTransport has `ack()` method
   - Missing: SDK-level ACK semantics (delivered vs. read vs. processed)
   - Impact: Can't track message lifecycle for coordination
   - Scope: Document ACK flow; add processed state to messages table

7. **No Per-Project Agent Capability Queries**
   - Existing: `project_agent_refs` table exists
   - Missing: Query API to list enabled agents + their capabilities for topic routing
   - Impact: Orchestrator can't validate agent can handle subscription
   - Scope: Add accessor in `packages/core/src/store/`

---

## Part 3: Scope Handoff for Implementation Lead (T1251 → T1149.2+)

### SDK Layer (`packages/core/src/conduit/`)

**Required Changes for T1149 Acceptance**:

1. **Envelope Versioning** (reuse existing ConduitMessage)
   - Add optional fields: `kind?: 'request' | 'notify' | 'subscribe'`, `fromPeerId?: string`, `toPeerId?: string`, `payload?: unknown`
   - Maintain backward compatibility (kind defaults to message type)
   - Update factory to pass through peer info from PeerIdentity

2. **LocalTransport Topic Support** (new methods)
   - Schema: `topics(id, name, epic_id, wave_id, created_by, created_at)` + `topic_subscriptions(topic_id FK, agent_id, subscribed_at)`
   - New method: `async subscribeTopic(topicName: string): Promise<void>` — inserts into topic_subscriptions
   - New method: `async publishToTopic(topicName: string, content: string, kind: 'request'|'notify'|'subscribe', payload?: unknown): Promise<{messageId}>`
   - Update `poll()` to support `{ topic?: string }` parameter
   - Update `subscribe()` handler to route topic messages to separate callback

3. **ConduitClient Topic Wrapper** (new high-level methods)
   - `async subscribeTopic(topicName: string): Promise<void>` — delegates to transport
   - `async publishToTopic(topicName: string, content: string, options: {kind, payload}): Promise<ConduitSendResult>`
   - `onTopic(topicName: string, handler: (msg: ConduitMessage) => void): ConduitUnsubscribe` — topic-specific handler

### CLI + Dispatch (`packages/cleo/src/dispatch/domains/conduit.ts`)

**Required Operations** (mapped to D023 SDK-first):

1. **`conduit.subscribe`** (mutate) — wire ConduitClient.subscribeTopic
2. **`conduit.publish`** (mutate) — wire ConduitClient.publishToTopic
3. **`conduit.listen`** (query, long-running) — poll for topic messages

### Contract Updates (`packages/contracts/src/`)

1. Extend `ConduitMessage` with `kind?`, `fromPeerId?`, `toPeerId?`, `payload?`
2. Add `ConduitTopicSubscribeParams`, `ConduitTopicPublishParams`, `ConduitTopicListenParams`
3. Update `Transport` interface to add optional `subscribeTopic()`, `publishToTopic()` methods

### Spawn-Prompt Integration (`packages/core/src/orchestrate/spawn-prompt.ts`)

Add section after `## CONDUIT Subscription` (similar to Lead D's `## Worktree Setup`):
```
## CONDUIT Subscription (Wave 9 A2A Coordination)

Your wave is {{WAVE_ID}} of epic {{EPIC_ID}}. Subscribe to these topics:

- Topic: {{EPIC_ID}}.{{WAVE_ID}} — listen for peer findings + requests from Leads in your wave
- Topic: {{EPIC_ID}}.coordination — meta-topic where orchestrator publishes wave-complete signals

Example (TypeScript SDK):
  import { createConduit } from '@cleocode/core';
  const conduit = await createConduit(registry);
  
  // Subscribe to your wave
  await conduit.subscribeTopic('{{EPIC_ID}}.{{WAVE_ID}}');
  
  // Publish findings when done
  await conduit.publishToTopic('{{EPIC_ID}}.{{WAVE_ID}}', 'Wave {{WAVE_ID}} findings ready', {
    kind: 'notify',
    payload: { findings: [...], completedAt: new Date().toISOString() }
  });
  
  // Listen for orchestrator signals
  conduit.onTopic('{{EPIC_ID}}.coordination', (msg) => {
    if (msg.kind === 'notify' && msg.payload?.event === 'wave-complete') {
      // Unblock next wave
    }
  });
```

### Tests for Lead B1

1. Two Leads spawn in parallel (Wave 2, Wave 3)
2. Lead 2 completes, publishes to topic Epic.Wave2
3. Lead 3 is subscribed to Epic.Wave2 and receives notification
4. Lead 3 wakes up and completes its work
5. Both publish to Epic.coordination; orchestrator receives both notifications

---

## Part 4: Migration / Schema Additions

**New Tables** (apply after existing CONDUIT_SCHEMA_SQL):

```sql
-- Topics for broadcast coordination
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    epic_id TEXT NOT NULL,
    wave_id INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_epic ON topics(epic_id);

-- Topic subscriptions (agent → topic link)
CREATE TABLE IF NOT EXISTS topic_subscriptions (
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    subscribed_at INTEGER NOT NULL,
    PRIMARY KEY (topic_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_subscriptions_agent ON topic_subscriptions(agent_id);

-- Topic-specific messages (envelope: kind, fromPeerId, toPeerId, payload)
CREATE TABLE IF NOT EXISTS topic_messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',  -- request|notify|subscribe|message
    content TEXT NOT NULL,
    payload TEXT,  -- JSON
    created_at INTEGER NOT NULL,
    INDEX idx_topic_messages_topic_created ON topic_id, created_at
);

-- Message ACK per subscriber
CREATE TABLE IF NOT EXISTS topic_message_acks (
    message_id TEXT NOT NULL REFERENCES topic_messages(id) ON DELETE CASCADE,
    subscriber_agent_id TEXT NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    PRIMARY KEY (message_id, subscriber_agent_id)
);
```

---

## Summary: What Exists vs. What's Needed

| Capability | Today | Gap |
|-----------|-------|-----|
| Direct agent messaging | ✅ LocalTransport + HttpTransport (mature) | N/A |
| Topic subscription | ❌ | Add to LocalTransport + SDK + CLI |
| Envelope versioning | ⚠️ ConduitMessage has no kind/payload | Extend ConduitMessage + update codepaths |
| Spawn-prompt integration | ❌ | Add `## CONDUIT Subscription` section |
| Dead-letter replay | ⚠️ dead_letters table exists, no replay | Add replay queue + notifier |
| Per-project agent queries | ⚠️ project_agent_refs exists, no accessor | Add accessor in store/ |
| Multi-transport topic routing | ❌ | LocalTransport only (HttpTransport out of scope for this Lead) |
| End-to-end A2A test | ❌ | Add coordinated two-agent test to test suite |

---

## Files Affected Summary

**No changes needed** (audit-only):
- `conduit-client.ts` — will be extended by Lead B1
- `local-transport.ts` — will be extended with topic methods
- `http-transport.ts` — out of scope (LocalTransport is priority per D016)
- `sse-transport.ts` — out of scope for this wave
- `factory.ts` — no changes (already selects LocalTransport first)
- `conduit-sqlite.ts` — new schema additions (topics, topic_subscriptions, topic_messages, topic_message_acks)
- `conduit.ts` (contracts) — extend ConduitMessage type
- `operations/conduit.ts` (contracts) — add subscribe/publish/listen operation contracts
- `dispatch/domains/conduit.ts` — add subscribe/publish/listen operations
- `hooks/handlers/conduit-hooks.ts` — no changes (lifecycle messages can use new envelope later)
- `spawn-prompt.ts` — inject topic subscription instructions

---

**Total lines audited**: ~2000 (source) + ~1500 (tests)  
**Total lines written for A2A**: ~400 (new schema, handlers, SDK methods)  
**Total lines for CLI**: ~200 (new operations)

All information is current as of v2026.4.115 (April 23, 2026).
