/**
 * Conduit Domain Operations (5 operations)
 *
 * Query operations: 2
 * Mutate operations: 3
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
 * Registry note (ADR-042): the dispatcher currently registers these
 * operations under `domain: 'orchestrate'` with the `operation: 'conduit.*'`
 * identifier. The public/HTTP identifier is still `conduit.*` — that is the
 * stable wire-format surface and what these contracts describe.
 *
 * @task T910 — Orchestration Coherence v4 (contract surface completion)
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
/** Result of `conduit.send`. */
export interface ConduitSendResult {
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
