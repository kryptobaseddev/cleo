/**
 * Conduit Domain Operations (8 operations: 3 query, 5 mutate)
 *
 * Query operations: 3
 *   - conduit.status   — connection status + unread count
 *   - conduit.peek     — one-shot poll for messages
 *   - conduit.listen   — one-shot poll for topic messages (A2A, T1252)
 * Mutate operations: 5
 *   - conduit.start    — start continuous polling
 *   - conduit.stop     — stop polling
 *   - conduit.send     — send a message
 *   - conduit.subscribe — subscribe agent to a topic (A2A, T1252)
 *   - conduit.publish  — publish message to a topic (A2A, T1252)
 *
 * CONDUIT is the agent-to-agent messaging subsystem. The protocol wraps a
 * pluggable Transport (HTTP to cloud SignalDock, LocalTransport over
 * `conduit.db`, future SSE). These wire-format contracts describe the CLI +
 * HTTP dispatch surface for `cleo agent` and equivalent programmatic calls.
 *
 * SYNC: Canonical runtime implementation at
 *   packages/cleo/src/dispatch/domains/conduit.ts (ConduitHandler)
 * and the lower-level interfaces at
 *   packages/contracts/src/conduit.ts (Conduit, ConduitMessage, ...).
 *
 * Registry note (T964 — supersedes ADR-042 Decision 1): the dispatcher
 * registers these operations under `domain: 'conduit'` with short operation
 * names (`status`, `peek`, `start`, `stop`, `send`, `subscribe`, `publish`,
 * `listen`). The public/HTTP identifier `conduit.<op>` remains the stable
 * wire-format surface and what these contracts describe; CLI and HTTP adapters
 * map between the two forms.
 *
 * @task T910 — Orchestration Coherence v4 (contract surface completion)
 * @task T964 — CONDUIT promotion to canonical domain #15
 * @task T1422 — Typed-dispatch migration (Wave D, T975 follow-on)
 * @see packages/cleo/src/dispatch/domains/conduit.ts
 * @see packages/contracts/src/conduit.ts
 */

// ============================================================================
// Shared Conduit wire-format types
// ============================================================================

/** Transport implementation backing a conduit call. */
export type ConduitTransportKind = 'local' | 'http' | 'sse' | 'ws';

/**
 * Compact inbox message projection returned by `conduit.peek`.
 *
 * @remarks
 * This is the LAFS-friendly wire format — a reduction of the richer
 * `ConduitMessage` interface at `../conduit.ts` that drops internal fields
 * (tags, metadata, threadId) unless the receiving client needs them. Clients
 * that want the full envelope should use the transport directly.
 */
export interface ConduitInboxMessage {
  /** Unique message id. */
  id: string;
  /** Sender agent id. */
  from: string;
  /** Message content (text). */
  content: string;
  /** Conversation / thread id when the message belongs to one. */
  conversationId?: string;
  /** ISO 8601 timestamp of delivery. */
  timestamp?: string;
}

// ============================================================================
// Query Operations
// ============================================================================

// --------------------------------------------------------------------------
// conduit.status → connection + unread count
// --------------------------------------------------------------------------

/** Parameters for `conduit.status`. */
export interface ConduitStatusParams {
  /** Agent id to check. Omit to use the registry's active agent. */
  agentId?: string;
}
/** Result of `conduit.status`. */
export interface ConduitStatusResult {
  /** The agent id checked. */
  agentId: string;
  /** Whether the transport reports a healthy connection. */
  connected: boolean;
  /** Transport backing this call. */
  transport: ConduitTransportKind;
  /** True if a long-running polling loop is active for this agent. */
  pollerRunning: boolean;
  /** Total unread messages in the agent's inbox. */
  unreadTotal?: number;
  /** Count of action-required messages (subset of unread). */
  actionItems?: number;
  /** Error summary when `connected=false`. */
  error?: string;
}

// --------------------------------------------------------------------------
// conduit.peek → one-shot poll for new messages (ACKs as it reads)
// --------------------------------------------------------------------------

/** Parameters for `conduit.peek`. */
export interface ConduitPeekParams {
  /** Agent id to poll as. Omit to use the active agent. */
  agentId?: string;
  /** Max messages to fetch (default 20). */
  limit?: number;
}
/** Result of `conduit.peek`. */
export interface ConduitPeekResult {
  /** The agent id polled. */
  agentId: string;
  /** Messages retrieved. Empty array when the inbox is empty. */
  messages: ConduitInboxMessage[];
}

// ============================================================================
// Mutate Operations
// ============================================================================

// --------------------------------------------------------------------------
// conduit.start → begin continuous polling
// --------------------------------------------------------------------------

/** Parameters for `conduit.start`. */
export interface ConduitStartParams {
  /** Agent id to poll as. Omit to use the active agent. */
  agentId?: string;
  /** Poll interval in milliseconds (default 5000). */
  pollIntervalMs?: number;
  /** Group conversation ids to monitor for @-mentions. */
  groupConversationIds?: string[];
}
/** Result of `conduit.start`. */
export interface ConduitStartResult {
  /** Agent id polling was started for. */
  agentId: string;
  /** Effective poll interval (after defaulting). */
  pollIntervalMs: number;
  /** Group conversation ids being watched. */
  groupConversationIds: string[];
  /** Transport backing the poller. */
  transport: ConduitTransportKind;
  /** Human-readable status line. */
  message: string;
  /** True when `start` was a no-op because a poller was already running. */
  alreadyRunning?: boolean;
}

// --------------------------------------------------------------------------
// conduit.stop → terminate active polling loop
// --------------------------------------------------------------------------

/** Parameters for `conduit.stop` — none. */
export type ConduitStopParams = Record<string, never>;
/** Result of `conduit.stop`. */
export interface ConduitStopResult {
  /** Agent id whose poller was stopped (null if no poller was active). */
  agentId: string | null;
  /** Human-readable status line. */
  message: string;
}

// --------------------------------------------------------------------------
// conduit.send → send a message to an agent or conversation
// --------------------------------------------------------------------------

/**
 * Parameters for `conduit.send`.
 *
 * @remarks
 * Caller MUST provide exactly one of `to` (direct message) or
 * `conversationId` (group/thread message). Supplying neither yields
 * `E_ARGS`; supplying both is a client-side mistake.
 */
export interface ConduitSendParams {
  /** Message content (required). */
  content: string;
  /** Target agent id for a direct message. */
  to?: string;
  /** Target conversation id for a group / thread message. */
  conversationId?: string;
  /** Send as this agent. Omit to use the active agent from the registry. */
  agentId?: string;
}

/**
 * Operation result of `conduit.send`.
 *
 * @remarks
 * This is the wire-format result for the `conduit.send` CLI/HTTP dispatch
 * operation. It carries transport metadata (`from`, `to`, `transport`,
 * `sentAt`) not present in the transport-layer {@link ConduitSendResult}
 * defined in `../conduit.ts`.
 *
 * The transport-layer type (`@cleocode/contracts` top-level `ConduitSendResult`)
 * covers the `Conduit` interface (ConduitClient / publishToTopic). This type
 * covers the CLI dispatch surface.
 */
export interface ConduitSendOperationResult {
  /** The assigned message id. */
  messageId: string;
  /** Sender agent id. */
  from: string;
  /** Target of the send — agent id or conversation id. */
  to: string;
  /** Transport that was used. */
  transport: ConduitTransportKind;
  /** ISO 8601 send timestamp. */
  sentAt: string;
}

// ============================================================================
// A2A Topic Operations (T1252 — Wave 9 Agent-to-Agent coordination)
// ============================================================================

// --------------------------------------------------------------------------
// conduit.subscribe → register agent subscription to a named topic
// --------------------------------------------------------------------------

/**
 * Parameters for `conduit.subscribe`.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitSubscribeParams {
  /** Topic name to subscribe to, e.g. `"epic-T1149.wave-2"`. */
  topicName: string;
  /** Send as this agent. Omit to use the active agent from the registry. */
  agentId?: string;
  /** Optional message kind / event filter. */
  filter?: { kind?: string[]; event?: string[] };
}

/**
 * Result of `conduit.subscribe`.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitSubscribeResult {
  /** The agent id that was subscribed. */
  agentId: string;
  /** Topic name subscribed to. */
  topicName: string;
  /** Human-readable status message. */
  message: string;
}

// --------------------------------------------------------------------------
// conduit.publish → broadcast a message to a topic
// --------------------------------------------------------------------------

/**
 * Parameters for `conduit.publish`.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitPublishParams {
  /** Target topic name. */
  topicName: string;
  /** Message content (human-readable). */
  content: string;
  /** Message kind (default `"message"`). */
  kind?: 'message' | 'request' | 'notify' | 'subscribe';
  /** Optional structured payload (JSON-serializable). */
  payload?: Record<string, unknown>;
  /** Publish as this agent. Omit to use the active agent from the registry. */
  agentId?: string;
}

/**
 * Result of `conduit.publish`.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitPublishResult {
  /** Assigned message id. */
  messageId: string;
  /** Publisher agent id. */
  from: string;
  /** Topic the message was published to. */
  topicName: string;
  /** Transport backing this call. */
  transport: ConduitTransportKind;
  /** ISO 8601 publish timestamp. */
  publishedAt: string;
}

// --------------------------------------------------------------------------
// conduit.listen → one-shot poll for topic messages
// --------------------------------------------------------------------------

/**
 * Parameters for `conduit.listen`.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitListenParams {
  /** Topic name to poll. */
  topicName: string;
  /** Listen as this agent. Omit to use the active agent from the registry. */
  agentId?: string;
  /** Maximum messages to return (default 50). */
  limit?: number;
  /** Only return messages created after this ISO 8601 timestamp. */
  since?: string;
}

/**
 * Result of `conduit.listen`.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitListenResult {
  /** Topic that was polled. */
  topicName: string;
  /** Messages received (may be empty). */
  messages: ConduitInboxMessage[];
  /** Duration of the listen call in milliseconds. */
  listenedForMs: number;
}

// ============================================================================
// Typed Operation Record (T1422 — Wave D typed-dispatch)
// ============================================================================

/**
 * Typed operation record for the conduit domain.
 *
 * Each key is an operation name, and each value is a tuple of
 * `[Params, Result]` types. Used by the typed dispatch adapter
 * (`packages/cleo/src/dispatch/adapters/typed.ts`) to provide
 * compile-time narrowing on all conduit handler params.
 *
 * @task T1422 — Typed-dispatch migration (T975 follow-on)
 * @see packages/cleo/src/dispatch/domains/conduit.ts (ConduitHandler)
 */
export type ConduitOps = {
  status: [ConduitStatusParams, ConduitStatusResult];
  peek: [ConduitPeekParams, ConduitPeekResult];
  listen: [ConduitListenParams, ConduitListenResult];
  start: [ConduitStartParams, ConduitStartResult];
  stop: [ConduitStopParams, ConduitStopResult];
  send: [ConduitSendParams, ConduitSendOperationResult];
  subscribe: [ConduitSubscribeParams, ConduitSubscribeResult];
  publish: [ConduitPublishParams, ConduitPublishResult];
};
