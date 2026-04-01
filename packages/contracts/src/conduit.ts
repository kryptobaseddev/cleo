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
