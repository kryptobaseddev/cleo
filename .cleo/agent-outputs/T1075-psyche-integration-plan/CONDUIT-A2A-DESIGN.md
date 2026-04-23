# CONDUIT A2A Envelope Design — T1251 Lead A1

**Date**: 2026-04-23  
**Task**: T1251 (CONDUIT Audit + A2A Envelope Design)  
**Parent Epic**: T1149 (Wave 9: Conduit Agent-to-Agent Communication)  
**Decision**: D023 (SDK-first), D028 (Core/CLI boundary), D029 (Worktree canonical paths)

---

## Executive Summary

This design extends CONDUIT from bilateral agent-to-agent messaging to a multi-peer orchestration protocol. The A2A (Agent-to-Agent) envelope provides structured message routing with `fromPeerId`, `toPeerId`, `threadId`, and `kind` (request|notify|subscribe), enabling:

1. **Lead-to-Lead Coordination** — Leads publish wave-completion findings to topic `<epicId>.<waveId>`, blocking subsequent Leads
2. **Orchestrator Signals** — Meta-topic `<epicId>.coordination` broadcasts wave-complete, unblock-next-wave events
3. **Structured Payload Delivery** — `{kind, payload}` envelope allows JSON-serialized structured data (findings, errors, context)
4. **Topic Lifecycle** — Subscribe at spawn, publish at completion, teardown after wave finishes

---

## Part 1: Envelope Specification

### Core Message Envelope

The **A2A Message Envelope** extends `ConduitMessage` with peer identity and message semantics.

#### TypeScript Interface

```typescript
/**
 * Agent-to-Agent (A2A) message envelope for orchestration coordination.
 *
 * Extends the base ConduitMessage with structured peer identity, message kind,
 * and optional typed payload. Used for Lead-to-Lead coordination in Wave 9
 * multi-peer orchestration (T1149).
 *
 * @example
 * ```ts
 * const msg: ConduitA2AMessage = {
 *   id: 'msg-uuid',
 *   from: 'cleo-lead-2',
 *   to: 'epic-T1149.wave-2',  // topic, not direct agent
 *   fromPeerId: 'cleo-lead-2',
 *   toPeerId: undefined,  // topic broadcast (one-to-many)
 *   threadId: 'epic-T1149.wave-2',
 *   kind: 'notify',
 *   content: 'Wave 2 findings ready',
 *   payload: { findings: [...], completedAt: '2026-04-23T...' },
 *   timestamp: '2026-04-23T15:42:00Z'
 * };
 * ```
 *
 * @see T1149 Wave 9 design
 */
export interface ConduitA2AMessage {
  /** Unique message identifier (UUID v4). */
  id: string;

  /**
   * Sender agent ID (legacy ConduitMessage compatibility).
   * Matches `fromPeerId` for direct messages; set to sending agent for broadcasts.
   * @example `"cleo-lead-2"`, `"cleo-orchestrator"`
   */
  from: string;

  /**
   * Recipient agent ID or topic name (legacy ConduitMessage compatibility).
   * For direct messages: agent ID. For topics: `<epicId>.<waveId>` or `<epicId>.coordination`.
   * @example `"cleo-lead-3"`, `"epic-T1149.wave-3"`, `"epic-T1149.coordination"`
   */
  to: string;

  /**
   * Sender peer identity — stable name derived from PeerIdentity.peerId.
   * Used to correlate multiple messages from the same orchestration peer.
   * @example `"cleo-lead-2"` (matches PeerIdentity.peerId)
   */
  fromPeerId: string;

  /**
   * Recipient peer identity — null for topic broadcasts, agent peerId for direct messages.
   * Direct message: `"cleo-lead-3"`. Topic broadcast: `null`.
   */
  toPeerId?: string | null;

  /**
   * Thread/conversation/topic identifier for grouping related messages.
   * Topics: `<epicId>.<waveId>` or `<epicId>.coordination`.
   * Direct conversation: internal conversation ID from conduit.db.
   * @example `"epic-T1149.wave-2"`, `"epic-T1149.coordination"`, `"conv-uuid"`
   */
  threadId: string;

  /**
   * Message semantics — determines handling on receive side.
   *
   * - `request` — sender expects a response; receiver should reply
   * - `notify` — informational; no response expected
   * - `subscribe` — sender subscribes to a topic; payload contains subscription params
   * - `message` — backward-compat fallback (default for legacy ConduitMessage)
   *
   * @default `"message"` (for backward compatibility with existing messages)
   */
  kind: 'request' | 'notify' | 'subscribe' | 'message';

  /**
   * Message content (text) — human-readable summary or structured JSON as text.
   * For JSON payload delivery, set content to serialized JSON and provide payload.
   * @example `"Wave 2 findings ready"`, `"{"status":"complete","count":42}"`
   */
  content: string;

  /**
   * Structured payload — typed data accompanying the message (optional).
   * JSON-serializable object; stored as TEXT in database.
   * SDK serializes to JSON; database stores as `JSON` type where supported.
   *
   * @example
   * ```ts
   * {
   *   event: 'wave-complete',
   *   waveId: 2,
   *   findings: { /* theory-of-mind insights */ },
   *   completedAt: '2026-04-23T15:42:00Z',
   *   nextWave: 3
   * }
   * ```
   */
  payload?: Record<string, unknown>;

  /**
   * ISO 8601 timestamp of message creation (server-assigned or client-sent).
   * @example `"2026-04-23T15:42:00.000Z"`
   */
  timestamp: string;

  /**
   * Optional tags for message classification (inherited from ConduitMessage).
   * @example `["#status", "#wave-2"]`
   */
  tags?: string[];

  /**
   * Optional metadata for transport/routing (inherited from ConduitMessage).
   * Used by transports to carry protocol-level state (e.g., delivery attempts, DLQ reason).
   */
  metadata?: Record<string, unknown>;
}
```

#### JSON Wire Format

Messages are serialized to JSON for storage and transmission. Example:

```json
{
  "id": "msg-a1b2c3d4-e5f6-4789-a1b2-c3d4e5f6a7b8",
  "from": "cleo-lead-2",
  "to": "epic-T1149.wave-2",
  "fromPeerId": "cleo-lead-2",
  "toPeerId": null,
  "threadId": "epic-T1149.wave-2",
  "kind": "notify",
  "content": "Wave 2 findings ready",
  "payload": {
    "event": "wave-complete",
    "waveId": 2,
    "findings": {
      "dialectic_insights": [{"trait": "verbose_output", "confidence": 0.92}],
      "peer_insights": {"cleo-lead-1": "confirmed peer cohesion"}
    },
    "completedAt": "2026-04-23T15:42:00.000Z",
    "nextWaveUnblocks": 3
  },
  "timestamp": "2026-04-23T15:42:00.000Z",
  "tags": ["#wave-2", "#completion-notify"],
  "metadata": { "transport": "local", "delivered_at": 1713886920 }
}
```

---

## Part 2: Topic-Naming Convention

### Canonical Topic Names

All topics follow a two-part naming scheme: **`<scope>.<subcomponent>`**

#### 1. Wave-Scoped Topics

Topics for intra-wave Lead coordination:

```
<epicId>.<waveId>

Format:
  epicId    — Task ID of the Wave epic (e.g., "T1149", "T1075")
  waveId    — Wave number (e.g., "1", "2", "3", ..., "9")

Examples:
  epic-T1149.wave-1     — Wave 1 Leads + workers publish/subscribe findings
  epic-T1149.wave-9     — Wave 9 (A2A coordination) Leads exchange A2A envelopes
  epic-T1075.wave-0     — Wave 0 (prerequisites) PSYCHE integration audit

Semantics:
  - All agents spawned in a wave subscribe to their wave topic at startup
  - Leads publish findings/completions to the wave topic when done
  - Subsequent waves (if dependent) listen to topic to detect unblock signal
  - Topic is created on first subscribe; destroyed after wave lifecycle ends
```

#### 2. Orchestration Meta-Topic

Centralized coordination topic for orchestrator signals:

```
<epicId>.coordination

Examples:
  epic-T1149.coordination    — Orchestrator publishes wave-complete + next-wave signals
  epic-T1075.coordination    — PSYCHE integration orchestrator broadcast

Semantics:
  - Orchestrator publishes to this topic only (not bidirectional)
  - All active agents subscribe to this topic
  - Used for: "Wave 2 complete, unblock Wave 3", "Epic failed, abort all waves"
  - Single orchestrator publishes; many agents receive
```

#### 3. Persistent vs. Ephemeral Topics

- **Wave-scoped topics** (`epic-T<id>.wave-<n>`) — ephemeral, destroyed after wave completes
- **Coordination topic** (`epic-T<id>.coordination`) — persistent for epic lifetime

### Topic Lifecycle

| Phase | Topic | Publisher | Subscribers |
|-------|-------|-----------|-------------|
| **Wave spawn** | `epic-T.wave-N` | (created on first subscribe) | Leads + workers for wave-N |
| **Intra-wave work** | `epic-T.wave-N` | Any Lead can publish findings | All subscribers listen |
| **Wave completion** | `epic-T.coordination` | Orchestrator | All Leads (watches for unblock) |
| **Next wave dispatch** | `epic-T.wave-(N+1)` | (created on first subscribe) | Leads + workers for wave-(N+1) |
| **Epic completion** | `epic-T.coordination` | Orchestrator (final signal) | All agents (teardown signal) |

---

## Part 3: Subscription Lifecycle

### 1. Subscribe at Spawn (Prompt-Driven)

When an agent is spawned (via `cleo orchestrate spawn`), the tier-2 prompt includes a **CONDUIT Subscription** section.

#### Spawn-Prompt Template Section

```markdown
## CONDUIT Subscription (Wave 9 A2A Coordination)

Your peer identity: {{PEER_ID}}
Your wave: {{EPIC_ID}}.{{WAVE_ID}}
Epic: {{EPIC_ID}}

The following topics are active for your peer group:

### Primary Topic: Your Wave
- **Topic**: `{{EPIC_ID}}.{{WAVE_ID}}`
- **Role**: Leads in your wave publish findings; other Leads listen for unblock signals
- **Action**: Subscribe on startup; publish when your work completes

### Meta-Topic: Orchestrator Signals
- **Topic**: `{{EPIC_ID}}.coordination`
- **Role**: Orchestrator publishes wave-complete + next-wave-unblock signals
- **Action**: Always subscribed; listen for teardown signals

### Implementation (TypeScript SDK)

```ts
import { createConduit } from '@cleocode/core';
import { PeerIdentity } from '@cleocode/contracts';

// Load peer identity (injected by spawn harness)
const peer: PeerIdentity = {{PEER_IDENTITY_JSON}};

const conduit = await createConduit(registry, peer.peerId);
await conduit.connect();

// Subscribe to your wave topic
await conduit.subscribeTopic('{{EPIC_ID}}.{{WAVE_ID}}');

// Subscribe to orchestrator signals (meta-topic)
await conduit.subscribeTopic('{{EPIC_ID}}.coordination', {
  filter: { kind: 'notify', event: ['wave-complete', 'abort', 'teardown'] }
});

// When your work completes, publish findings
await conduit.publishToTopic('{{EPIC_ID}}.{{WAVE_ID}}', 'Work complete', {
  kind: 'notify',
  payload: {
    event: 'work-complete',
    peerId: peer.peerId,
    findings: { /* your structured output */ },
    completedAt: new Date().toISOString()
  }
});

// Listen for orchestrator signals
conduit.onTopic('{{EPIC_ID}}.coordination', (msg) => {
  if (msg.kind === 'notify' && msg.payload?.event === 'wave-complete') {
    console.log(`Wave {{WAVE_ID}} complete! Unblocking: ${msg.payload.nextWave}`);
  } else if (msg.payload?.event === 'abort') {
    process.exit(0);  // Graceful shutdown on abort
  }
});

// Keep conduit connected for the duration of your work
// Don't disconnect until you see 'teardown' signal or reach cleo complete
```
```

**Key points**:
- Spawn harness injects `{{PEER_IDENTITY_JSON}}` (from `packages/contracts/src/peer.ts`)
- Both wave topic and coordination topic are subscribed
- Agents listen for two kinds of notifications: wave-completion (local) + orchestrator signals (global)
- Topics are injected by the orchestrator via `cleo orchestrate spawn --tier 2`

### 2. Publish at Completion (Finding Notification)

When a Lead finishes its task, it publishes findings to its wave topic.

#### Publish Example

```typescript
async function notifyWaveComplete(conduit: Conduit, findings: unknown) {
  await conduit.publishToTopic('epic-T1149.wave-2', 'Wave 2 work complete', {
    kind: 'notify',
    payload: {
      event: 'work-complete',
      peerId: 'cleo-lead-2',
      findings: findings,  // Structured: dialectic insights, peer cards, etc.
      completedAt: new Date().toISOString(),
      taskId: 'T1084'  // (optional) reference back to task
    }
  });
}
```

**Semantics**:
- `kind: 'notify'` — no response expected
- `event: 'work-complete'` — signals to other Leads that unblock logic should check dependencies
- Subscribers (typically orchestrator + dependent Leads) listen and unblock when all dependent Leads publish

### 3. Teardown After Wave Finishes

Orchestrator broadcasts a final teardown signal after the wave completes and all dependent work is scheduled.

#### Orchestrator Teardown Signal

```typescript
async function teardownWave(conduit: Conduit, epicId: string, waveId: number) {
  await conduit.publishToTopic(`${epicId}.coordination`, 'Wave teardown', {
    kind: 'notify',
    payload: {
      event: 'teardown',
      waveId: waveId,
      completedAt: new Date().toISOString()
    }
  });

  // After teardown, the topic is archived (no new messages accepted)
  // Subscribers can safely disconnect
}
```

**Semantics**:
- Signals all agents that the wave is no longer active
- Agents can safely disconnect from the wave topic
- The wave topic transitions to read-only archive state

---

## Part 4: Failure Modes & DLQ Semantics

### Message Delivery Failures

The LocalTransport implementation uses the existing `delivery_jobs` table to queue failed messages with exponential retry.

#### Retry Strategy

```sql
-- delivery_jobs tracks async delivery attempts
CREATE TABLE delivery_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, delivered, dead
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

#### Retry Schedule

- **Attempt 1**: Immediate (0s delay)
- **Attempt 2**: 1s delay
- **Attempt 3**: 4s delay (2² seconds)
- **Attempt 4**: 16s delay (4² seconds)
- **Attempt 5**: 64s delay (8² seconds)
- **Attempt 6**: 256s delay (16² seconds)
- **Attempt 7+**: → dead-letter queue (DLQ)

**Total time to DLQ**: ~341 seconds (~5.7 minutes for local delivery, network timeouts accelerate this)

### Dead-Letter Queue (DLQ)

Messages that exceed `max_attempts` are moved to the DLQ for manual inspection.

```sql
CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  reason TEXT NOT NULL,  -- 'max_attempts_exceeded', 'subscriber_offline', 'subscription_invalid'
  attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

#### DLQ Handling for A2A

When a Lead publishes findings and the message lands in the DLQ:

1. **Detect**: Orchestrator or monitoring process queries `dead_letters` for wave-related topics
2. **Notify**: Send notification back to originating peer via `epic-T.coordination` meta-topic
   ```json
   {
     "kind": "notify",
     "event": "delivery-failure",
     "failedMessageId": "msg-uuid",
     "failedTopic": "epic-T1149.wave-2",
     "reason": "max_attempts_exceeded",
     "fromPeerId": "cleo-orchestrator",
     "payload": {
       "originatingPeer": "cleo-lead-2",
       "recommendation": "replay with context or abort wave"
     }
   }
   ```
3. **Replay**: Originating peer can choose to replay (with enhanced context) or abort
4. **Archive**: After action, DLQ entry is marked as resolved (not deleted, for audit)

#### Implementation in LocalTransport

```typescript
// In LocalTransport class:

async notifyDeliveryFailure(jobId: string, messageId: string, reason: string) {
  const job = await this.db.prepare(
    `SELECT payload FROM delivery_jobs WHERE id = ?`
  ).get(jobId) as { payload: string } | undefined;
  
  if (!job) return;
  
  const msg = JSON.parse(job.payload) as ConduitA2AMessage;
  
  // Route to orchestrator meta-topic
  await this.publishToTopic(
    `${msg.payload?.epicId || 'system'}.coordination`,
    `Delivery failure: ${messageId}`,
    {
      kind: 'notify',
      payload: {
        event: 'delivery-failure',
        failedMessageId: messageId,
        failedTopic: msg.threadId,
        originatingPeer: msg.fromPeerId,
        reason: reason
      }
    }
  );
}
```

---

## Part 5: Session/Peer Resolution

### PeerIdentity Resolution

Each spawned agent receives a `PeerIdentity` (defined in `packages/contracts/src/peer.ts`) that includes:

```typescript
export interface PeerIdentity {
  peerId: string;        // "cleo-lead-2"
  peerKind: PeerKind;    // "lead" | "worker" | "orchestrator" | "subagent"
  cantFile: string;      // Absolute path to .cant source
  displayName: string;   // "CLEO Lead Wave 2"
  description: string;   // "Responsible for Wave 2 integration"
}
```

### From/To Mapping in Envelope

The `fromPeerId` and `toPeerId` fields in `ConduitA2AMessage` are derived from `PeerIdentity.peerId`.

#### Direct Message (Agent-to-Agent)

```
Message: Lead 2 → Lead 3 (request for findings)

Envelope:
  from: "cleo-lead-2"         (ConduitMessage compat)
  fromPeerId: "cleo-lead-2"
  to: "cleo-lead-3"           (ConduitMessage compat)
  toPeerId: "cleo-lead-3"
  threadId: "conv-<uuid>"     (internal conversation ID from conduit.db)
  kind: "request"
  content: "Can you share your findings?"
  payload: {request_id: "req-123"}
```

#### Topic Broadcast (One-to-Many)

```
Message: Lead 2 → Wave 2 Topic (notify all listeners)

Envelope:
  from: "cleo-lead-2"
  fromPeerId: "cleo-lead-2"
  to: "epic-T1149.wave-2"     (topic name, not agent ID)
  toPeerId: null              (broadcast, not unicast)
  threadId: "epic-T1149.wave-2"
  kind: "notify"
  content: "Wave 2 findings ready"
  payload: {findings: {...}, completedAt: "..."}
```

### Peer Lookup in LocalTransport

When resolving `fromPeerId` → actual agent registry entry:

```typescript
// In dispatch/domains/conduit.ts or new PeerResolver:

async function resolvePeerIdentity(peerId: string): Promise<PeerIdentity> {
  const registry = new AgentRegistryAccessor(process.cwd());
  
  // Try project-tier CANT loader first
  const seedAgents = await loadSeedAgentIdentities();
  const found = seedAgents.find(p => p.peerId === peerId);
  if (found) return found;
  
  // Fallback: global registry lookup
  const credential = await registry.get(peerId);
  if (!credential) {
    throw new Error(`Peer not found: ${peerId}`);
  }
  
  // Convert credential → PeerIdentity (simplified)
  return {
    peerId: credential.agentId,
    peerKind: 'subagent',
    cantFile: '',  // Not available from registry
    displayName: credential.agentId,
    description: ''
  };
}
```

---

## Part 6: Spawn-Prompt Integration Hook Points

### Location: `packages/core/src/orchestrate/spawn-prompt.ts`

Current structure (existing hooks):

```typescript
// spawn-prompt.ts sections:
- ## Task Identity
- ## File Paths (absolute — do not guess)
- ## Session Linkage
- ## Stage-Specific Guidance
- ## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)
- ## Quality Gates
- ## Return Format Contract (MANDATORY)
```

### New Section: CONDUIT Subscription

Add after `## Stage-Specific Guidance`:

```markdown
## CONDUIT Subscription (Wave 9 A2A Coordination)

Orchestrator-injected topic configuration.
```

### Implementation Signature

```typescript
/**
 * Inject CONDUIT subscription instructions into spawn prompt.
 *
 * Called by spawnPrompt() after stage-specific guidance.
 * Resolves orchestrator context to determine wave/epic/topics.
 *
 * @param epicId - Parent epic ID (e.g., "T1149")
 * @param waveId - Wave number (e.g., 2)
 * @param peerId - Spawned agent peer ID (e.g., "cleo-lead-2")
 * @returns Markdown section for prompt
 */
export function injectConduitSubscription(
  epicId: string,
  waveId: number,
  peerId: string
): string {
  const waveTopic = `epic-${epicId}.wave-${waveId}`;
  const coordTopic = `epic-${epicId}.coordination`;
  
  return `## CONDUIT Subscription (Wave 9 A2A Coordination)

Your peer identity: {{PEER_ID}} = ${peerId}
Your wave: {{EPIC_ID}}.{{WAVE_ID}} = ${epicId}.${waveId}

### Topics

**Wave Topic** (intra-wave coordination):
- Name: \`${waveTopic}\`
- Role: Leads in your wave exchange findings; listen for peer completion
- Action: Subscribe on startup; publish when work completes

**Meta-Topic** (orchestrator signals):
- Name: \`${coordTopic}\`
- Role: Orchestrator publishes wave-complete + abort signals
- Action: Always subscribed; listen for completion signals

### SDK Usage Example

\`\`\`ts
import { createConduit } from '@cleocode/core';

const conduit = await createConduit(registry, '${peerId}');
await conduit.subscribeTopic('${waveTopic}');
await conduit.subscribeTopic('${coordTopic}');

// Listen for peer findings
conduit.onTopic('${waveTopic}', (msg) => {
  if (msg.kind === 'notify' && msg.payload?.event === 'work-complete') {
    console.log('Peer completed: ', msg.fromPeerId);
  }
});

// When done, publish findings
await conduit.publishToTopic('${waveTopic}', 'Work complete', {
  kind: 'notify',
  payload: {
    event: 'work-complete',
    peerId: '${peerId}',
    findings: { /* ... */ },
    completedAt: new Date().toISOString()
  }
});
\`\`\`
`;
}
```

### Integration Point in `spawnPrompt()`

```typescript
// In spawnPrompt() function:

const stageSections = buildStageSections(task, parentEpic);
const conduitSection = injectConduitSubscription(
  parentEpic.id,
  parentEpic.waveNumber || 1,
  peer.peerId
);

return `
${basePrompt}

${stageSections}

${conduitSection}

${evidenceGates}

${qualityGates}

${returnContract}
`;
```

---

## Part 7: Topic Operations — SDK & CLI Contract

### SDK Layer (`packages/core/src/conduit/`)

#### ConduitClient Extensions

```typescript
/**
 * Subscribe to a topic for broadcast messages.
 *
 * Creates or reuses a topic subscription in the local project.
 * On subscribe, LocalTransport creates the topic if missing.
 *
 * @param topicName - Topic name (e.g., "epic-T1149.wave-2")
 * @param options - Subscription options (optional)
 *   - filter?: {kind?: string[], event?: string[]} — limit message kinds/events
 * @throws When LocalTransport is unavailable and cloud topics not implemented
 */
async subscribeTopic(
  topicName: string,
  options?: {
    filter?: {
      kind?: Array<'request' | 'notify' | 'subscribe' | 'message'>;
      event?: string[];
    };
  }
): Promise<void>

/**
 * Publish a message to a topic (broadcast to all subscribers).
 *
 * @param topicName - Topic name
 * @param content - Human-readable content
 * @param options - Message kind and payload
 *   - kind: 'request' | 'notify' | 'subscribe' | 'message'
 *   - payload?: unknown — structured data (JSON-serializable)
 */
async publishToTopic(
  topicName: string,
  content: string,
  options: {
    kind: 'request' | 'notify' | 'subscribe' | 'message';
    payload?: Record<string, unknown>;
  }
): Promise<ConduitSendResult>

/**
 * Subscribe to a topic with a handler (real-time listener).
 *
 * @param topicName - Topic name
 * @param handler - Callback for each message
 * @returns Unsubscribe function
 */
onTopic(
  topicName: string,
  handler: (message: ConduitA2AMessage) => void
): ConduitUnsubscribe

/**
 * Unsubscribe from a topic.
 *
 * @param topicName - Topic name to unsubscribe from
 */
async unsubscribeTopic(topicName: string): Promise<void>
```

#### LocalTransport Extensions

```typescript
// In LocalTransport class:

/**
 * Subscribe to a topic in conduit.db.
 * Creates topic if missing (idempotent).
 */
async subscribeTopic(
  topicName: string,
  options?: { filter?: unknown }
): Promise<void> {
  const db = this.ensureConnected();
  const nowUnix = Math.floor(Date.now() / 1000);
  
  // Parse topic name: epic-T<id>.wave-N or epic-T<id>.coordination
  const topicId = randomUUID();
  
  db.prepare(`
    INSERT INTO topics (id, name, epic_id, wave_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO NOTHING
  `).run(topicId, topicName, extractEpicId(topicName), extractWaveId(topicName), 
         this.state!.agentId, nowUnix);
  
  // Insert subscription record
  const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as {id: string};
  db.prepare(`
    INSERT INTO topic_subscriptions (topic_id, agent_id, subscribed_at)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(topic.id, this.state!.agentId, nowUnix);
}

/**
 * Publish a message to a topic (broadcasts to all subscribers).
 */
async publishToTopic(
  topicName: string,
  content: string,
  options: {kind?: string; payload?: unknown}
): Promise<{messageId: string}> {
  const db = this.ensureConnected();
  const messageId = randomUUID();
  const nowUnix = Math.floor(Date.now() / 1000);
  
  const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as {id: string};
  
  db.prepare(`
    INSERT INTO topic_messages (id, topic_id, from_agent_id, kind, content, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId, topic.id, this.state!.agentId, options.kind ?? 'message',
    content, JSON.stringify(options.payload), nowUnix
  );
  
  // Notify local subscribers
  this.notifyTopicSubscribers(topicName, {
    id: messageId,
    from: this.state!.agentId,
    fromPeerId: this.state!.agentId,
    toPeerId: null,
    to: topicName,
    threadId: topicName,
    kind: options.kind ?? 'message',
    content: content,
    payload: options.payload,
    timestamp: new Date(nowUnix * 1000).toISOString()
  });
  
  return {messageId};
}

/**
 * Poll topic messages (query-based fallback for real-time subscriptions).
 */
async pollTopic(
  topicName: string,
  options?: {limit?: number; since?: string}
): Promise<ConduitA2AMessage[]> {
  const db = this.ensureConnected();
  const limit = options?.limit ?? 50;
  
  const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as {id: string};
  
  let query = `
    SELECT id, from_agent_id, kind, content, payload, created_at
    FROM topic_messages
    WHERE topic_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `;
  
  const rows = db.prepare(query).all(topic.id, limit) as Array<{
    id: string; from_agent_id: string; kind: string; content: string;
    payload: string | null; created_at: number;
  }>;
  
  return rows.map((r) => ({
    id: r.id,
    from: r.from_agent_id,
    fromPeerId: r.from_agent_id,
    toPeerId: null,
    to: topicName,
    threadId: topicName,
    kind: r.kind as any,
    content: r.content,
    payload: r.payload ? JSON.parse(r.payload) : undefined,
    timestamp: new Date(r.created_at * 1000).toISOString()
  }));
}
```

### CLI Operations (`packages/cleo/src/dispatch/domains/conduit.ts`)

#### New Operation Contracts

```typescript
// In packages/contracts/src/operations/conduit.ts:

export interface ConduitSubscribeParams {
  agentId?: string;
  topicName: string;
  filter?: { kind?: string[]; event?: string[] };
}
export interface ConduitSubscribeResult {
  agentId: string;
  topicName: string;
  message: string;
}

export interface ConduitPublishParams {
  agentId?: string;
  topicName: string;
  content: string;
  kind?: 'request' | 'notify' | 'subscribe' | 'message';
  payload?: Record<string, unknown>;
}
export interface ConduitPublishResult {
  messageId: string;
  from: string;
  topicName: string;
  transport: ConduitTransportKind;
  publishedAt: string;
}

export interface ConduitListenParams {
  agentId?: string;
  topicName: string;
  timeoutMs?: number;
}
export interface ConduitListenResult {
  topicName: string;
  messages: ConduitInboxMessage[];
  listenedFor: number;  // ms
}
```

#### Dispatch Handler Extensions

```typescript
// In ConduitHandler class:

async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
  // ... existing cases ...
  
  case 'subscribe': {
    const result = await this.subscribeTopic(
      params?.topicName as string,
      params?.agentId as string | undefined,
      params?.filter as unknown
    );
    return wrapResult(result, 'mutate', 'conduit', operation, startTime);
  }
  
  case 'publish': {
    const result = await this.publishToTopic(
      params?.topicName as string,
      params?.content as string,
      params?.kind as string | undefined,
      params?.payload as Record<string, unknown> | undefined,
      params?.agentId as string | undefined
    );
    return wrapResult(result, 'mutate', 'conduit', operation, startTime);
  }
}

async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
  // ... existing cases ...
  
  case 'listen': {
    const result = await this.listenTopic(
      params?.topicName as string,
      params?.agentId as string | undefined,
      params?.timeoutMs as number | undefined
    );
    return wrapResult(result, 'query', 'conduit', operation, startTime);
  }
}

// Implementation:

async subscribeTopic(topicName: string, agentId?: string, filter?: unknown) {
  const credential = await this.resolveCredential(agentId);
  const { LocalTransport } = await import('@cleocode/core/conduit');
  
  const transport = new LocalTransport();
  await transport.connect({agentId: credential.agentId, apiKey: credential.apiKey, apiBaseUrl: credential.apiBaseUrl});
  
  try {
    await transport.subscribeTopic(topicName, {filter});
    return {
      success: true,
      data: {agentId: credential.agentId, topicName, message: `Subscribed to ${topicName}`}
    };
  } finally {
    await transport.disconnect();
  }
}

async publishToTopic(topicName: string, content: string, kind?: string, payload?: unknown, agentId?: string) {
  const credential = await this.resolveCredential(agentId);
  const { LocalTransport } = await import('@cleocode/core/conduit');
  
  const transport = new LocalTransport();
  await transport.connect({agentId: credential.agentId, apiKey: credential.apiKey, apiBaseUrl: credential.apiBaseUrl});
  
  try {
    const result = await transport.publishToTopic(topicName, content, {kind, payload});
    return {
      success: true,
      data: {
        messageId: result.messageId,
        from: credential.agentId,
        topicName,
        transport: 'local',
        publishedAt: new Date().toISOString()
      }
    };
  } finally {
    await transport.disconnect();
  }
}

async listenTopic(topicName: string, agentId?: string, timeoutMs?: number) {
  const credential = await this.resolveCredential(agentId);
  const { LocalTransport } = await import('@cleocode/core/conduit');
  
  const startTime = Date.now();
  const timeout = timeoutMs ?? 5000;
  
  const transport = new LocalTransport();
  await transport.connect({agentId: credential.agentId, apiKey: credential.apiKey, apiBaseUrl: credential.apiBaseUrl});
  
  try {
    const messages = await transport.pollTopic(topicName, {limit: 100});
    return {
      success: true,
      data: {
        topicName,
        messages: messages.map(m => ({id: m.id, from: m.from, content: m.content, timestamp: m.timestamp})),
        listenedFor: Date.now() - startTime
      }
    };
  } finally {
    await transport.disconnect();
  }
}
```

---

## Part 8: Reuse of Existing CONDUIT Infrastructure

This design **reuses and extends** existing shipped code:

| Component | Shipped | Reused | Extended |
|-----------|---------|--------|----------|
| `conduit-client.ts` | ✅ | ✅ (Agent class) | ✅ (add topic methods) |
| `local-transport.ts` | ✅ | ✅ (push, poll, ack) | ✅ (add topic tables + methods) |
| `http-transport.ts` | ✅ | ✅ | ❌ (out of scope, LocalTransport priority) |
| `factory.ts` | ✅ | ✅ | ❌ (no changes needed) |
| `conduit-sqlite.ts` | ✅ | ✅ (path helper, schema applier) | ✅ (add topics schema) |
| `dispatch/domains/conduit.ts` | ✅ | ✅ (5 ops) | ✅ (add 3 new ops) |
| `hooks/handlers/conduit-hooks.ts` | ✅ | ✅ (best-effort writes) | ✅ (use new envelope later) |

**Zero breaking changes** — existing agent messaging continues to work. New functionality is additive.

---

## Summary

This design provides:

1. **Structured A2A envelope** with `fromPeerId`, `toPeerId`, `threadId`, `kind`, and `payload`
2. **Topic-based pub-sub** for one-to-many orchestration coordination
3. **Spawn-prompt integration** to inject topic subscription instructions
4. **DLQ semantics** for delivery failures with originating-peer notification
5. **Peer resolution** via PeerIdentity contracts
6. **SDK + CLI surface** for subscribe/publish/listen operations

All design points reuse existing CONDUIT infrastructure (LocalTransport, ConduitClient, conduit.db) and add only necessary extensions for Wave 9 requirements.

**Total new schema**: 4 tables (topics, topic_subscriptions, topic_messages, topic_message_acks)  
**Total new SDK methods**: 4 (subscribeTopic, publishToTopic, onTopic, unsubscribeTopic)  
**Total new CLI operations**: 3 (subscribe, publish, listen)

Backward compatible with all existing bilateral agent messaging.
