/**
 * Conduit Protocol — Agent-to-agent communication interface.
 *
 * This is a CLIENT-SIDE interface. Implementations call a messaging
 * backend (SignalDock REST API, local napi-rs, etc.). SignalDock is
 * the canonical backend; it does NOT implement this TypeScript interface.
 *
 * CLEO Core defines the contract in @cleocode/contracts.
 *
 * This is the canonical TypeScript interface for the Conduit Protocol
 * described in CLEO-VISION.md and CLEOOS-VISION.md.
 *
 * @module conduit
 */

// ============================================================================
// Message types
// ============================================================================

/** A message received through the Conduit. */
export interface ConduitMessage {
  /** Unique message ID. */
  id: string;
  /** Sender agent ID. */
  from: string;
  /** Message content (text). */
  content: string;
  /** Optional tags for message classification (e.g. #status, #decision). */
  tags?: string[];
  /** Thread ID for conversation threading. */
  threadId?: string;
  /** Group ID if sent to a group conversation. */
  groupId?: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Optional structured metadata. */
  metadata?: Record<string, unknown>;
  /**
   * Message semantics for A2A (Agent-to-Agent) coordination.
   *
   * - `message` — default, backward-compat direct message
   * - `request` — sender expects a response; receiver should reply
   * - `notify`  — informational broadcast; no response expected
   * - `subscribe` — sender subscribes to a topic
   *
   * @default `"message"` for backward compatibility
   * @see T1252 CONDUIT A2A
   */
  kind?: 'message' | 'request' | 'notify' | 'subscribe';
  /**
   * Sender peer identity — stable peer ID from PeerIdentity.peerId.
   * Populated for A2A topic messages; absent on legacy direct messages.
   *
   * @see T1252 CONDUIT A2A
   */
  fromPeerId?: string;
  /**
   * Recipient peer identity — agent peerId for direct messages, `null` for
   * topic broadcasts (one-to-many).
   *
   * @see T1252 CONDUIT A2A
   */
  toPeerId?: string | null;
  /**
   * Structured payload accompanying the message.
   *
   * JSON-serializable object; stored as TEXT in the database.
   * Used for structured A2A coordination data (findings, events, etc.).
   *
   * @see T1252 CONDUIT A2A
   */
  payload?: Record<string, unknown>;
}

/**
 * A2A (Agent-to-Agent) topic subscription options.
 *
 * Passed to `subscribeTopic()` to filter messages by kind or event.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitTopicSubscribeOptions {
  /**
   * Filter messages by kind. When absent, all kinds are delivered.
   * @example `['notify', 'request']`
   */
  filter?: {
    /** Accept only these message kinds. */
    kind?: Array<'message' | 'request' | 'notify' | 'subscribe'>;
    /** Accept only messages whose `payload.event` is in this list. */
    event?: string[];
  };
}

/**
 * Options for publishing a message to a topic.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitTopicPublishOptions {
  /**
   * Message kind.
   * @default `"message"`
   */
  kind?: 'message' | 'request' | 'notify' | 'subscribe';
  /** Structured payload to attach to the message. */
  payload?: Record<string, unknown>;
}

/** Options for sending a message. */
export interface ConduitSendOptions {
  /** Tags to attach to the message. */
  tags?: string[];
  /** Thread ID for threading. */
  threadId?: string;
  /** Group ID to send to a group. */
  groupId?: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Result of sending a message. */
export interface ConduitSendResult {
  /** The assigned message ID. */
  messageId: string;
  /** ISO 8601 timestamp of delivery. */
  deliveredAt: string;
}

/** Unsubscribe function returned by event subscriptions. */
export type ConduitUnsubscribe = () => void;

// ============================================================================
// Connection state
// ============================================================================

/** Conduit connection states. */
export type ConduitState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** Connection state change event. */
export interface ConduitStateChange {
  /** Previous state. */
  from: ConduitState;
  /** New state. */
  to: ConduitState;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Error details if state is 'error'. */
  error?: string;
}

// ============================================================================
// Conduit interface
// ============================================================================

/**
 * The Conduit Protocol interface — high-level agent messaging.
 *
 * Conduit wraps a Transport adapter, adding messaging semantics.
 *
 * Implementations:
 * - `ConduitClient` (`@cleocode/core` — wraps any Transport)
 * - `HttpTransport` (HTTP polling to cloud SignalDock API)
 * - `LocalTransport` (napi-rs in-process — embedded SignalDock, future)
 * - `SseTransport` (Server-Sent Events — real-time cloud, future)
 *
 * Consumers:
 * - `@cleocode/cleo` CLI (`cleo agent watch/poll/send`)
 * - `@cleocode/runtime` (background polling, SSE connections)
 * - CleoOS Electron (embedded SignalDock via LocalTransport)
 * - Agent spawners (deliver task assignments, collect results)
 */
export interface Conduit {
  // --- Messaging ---

  /** Send a message to an agent or group. */
  send(to: string, content: string, options?: ConduitSendOptions): Promise<ConduitSendResult>;

  /** Subscribe to incoming messages. Returns unsubscribe function. */
  onMessage(handler: (message: ConduitMessage) => void): ConduitUnsubscribe;

  /** One-shot poll for new messages. Returns messages without subscribing. */
  poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]>;

  // --- Presence ---

  /** Send a heartbeat to indicate this agent is alive. */
  heartbeat(): Promise<void>;

  /** Check if a specific agent is currently online. */
  isOnline(agentId: string): Promise<boolean>;

  /** List currently online agents (optional — may not be supported by all implementations). */
  listOnline?(): Promise<string[]>;

  // --- A2A Topic Pub-Sub (T1252) ---

  /**
   * Subscribe this agent to a named topic for broadcast messages.
   *
   * Creates the topic in conduit.db if it does not yet exist (idempotent).
   * The agent will receive messages published to this topic via `onTopic()`.
   *
   * @param topicName - Topic name, e.g. `"epic-T1149.wave-2"` or `"epic-T1149.coordination"`.
   * @param options   - Optional subscription filter (kind, event).
   * @throws When no local transport is available (LocalTransport required for topic ops).
   * @see T1252 CONDUIT A2A
   */
  subscribeTopic?(topicName: string, options?: ConduitTopicSubscribeOptions): Promise<void>;

  /**
   * Publish a message to a topic (broadcast to all current subscribers).
   *
   * @param topicName - Target topic name.
   * @param content   - Human-readable message content.
   * @param options   - Message kind and optional structured payload.
   * @returns Send result with the assigned message ID.
   * @see T1252 CONDUIT A2A
   */
  publishToTopic?(
    topicName: string,
    content: string,
    options?: ConduitTopicPublishOptions,
  ): Promise<ConduitSendResult>;

  /**
   * Register a real-time handler for messages on a named topic.
   *
   * @param topicName - Topic name to watch.
   * @param handler   - Callback invoked for each message (includes A2A fields).
   * @returns Unsubscribe function that stops delivery to this handler.
   * @see T1252 CONDUIT A2A
   */
  onTopic?(topicName: string, handler: (message: ConduitMessage) => void): ConduitUnsubscribe;

  /**
   * Unsubscribe this agent from a named topic.
   *
   * Removes the subscription record from conduit.db. The agent will no longer
   * receive messages published to the topic.
   *
   * @param topicName - Topic name to leave.
   * @see T1252 CONDUIT A2A
   */
  unsubscribeTopic?(topicName: string): Promise<void>;

  // --- Connection lifecycle ---

  /** Connect to the messaging backend. */
  connect(): Promise<void>;

  /** Disconnect from the messaging backend. */
  disconnect(): Promise<void>;

  /** Get the current connection state. */
  getState(): ConduitState;

  /** Subscribe to connection state changes. */
  onStateChange?(handler: (change: ConduitStateChange) => void): ConduitUnsubscribe;

  // --- Identity ---

  /** The agent ID this conduit instance is connected as. */
  readonly agentId: string;
}

// ============================================================================
// Factory
// ============================================================================

/** Configuration for creating a Conduit instance. */
export interface ConduitConfig {
  /** Agent ID to connect as. */
  agentId: string;
  /** API base URL (for cloud implementations). */
  apiBaseUrl?: string;
  /** API key for authentication. */
  apiKey?: string;
  /** Poll interval in milliseconds (for polling implementations). Default: 5000. */
  pollIntervalMs?: number;
  /** WebSocket URL (for local SignalDock implementations). */
  wsUrl?: string;
}
