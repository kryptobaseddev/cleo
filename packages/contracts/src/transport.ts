/**
 * Transport — Low-level wire protocol adapters for agent messaging.
 *
 * Transport is the HOW layer: it moves messages over the wire using
 * HTTP polling, SSE, WebSocket, or in-process napi-rs calls.
 *
 * The Conduit interface (conduit.ts) wraps Transport to provide
 * high-level messaging semantics (WHAT the agent wants to do).
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4
 * @module transport
 */

import type { TransportConfig } from './agent-registry.js';
import type { ConduitMessage } from './conduit.js';

// ============================================================================
// Transport connection config
// ============================================================================

/** Configuration passed to Transport.connect(). */
export interface TransportConnectConfig extends TransportConfig {
  /** Agent ID to connect as. */
  agentId: string;
  /** API key for authentication. */
  apiKey: string;
  /** Base URL of the messaging API. */
  apiBaseUrl: string;
}

// ============================================================================
// Transport interface
// ============================================================================

/** Low-level wire transport for agent messaging. */
export interface Transport {
  /** Transport name for logging/debugging (e.g. 'http', 'sse', 'ws', 'local'). */
  readonly name: string;

  /** Connect to the messaging backend. */
  connect(config: TransportConnectConfig): Promise<void>;

  /** Disconnect from the messaging backend. */
  disconnect(): Promise<void>;

  /** Send a message payload. */
  push(
    to: string,
    content: string,
    options?: {
      conversationId?: string;
      replyTo?: string;
    },
  ): Promise<{ messageId: string }>;

  /** Poll for new messages (non-destructive peek). */
  poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]>;

  /** Acknowledge processed messages (marks as delivered). */
  ack(messageIds: string[]): Promise<void>;

  /** Subscribe to real-time events (SSE/WebSocket). Returns unsubscribe. */
  subscribe?(handler: (message: ConduitMessage) => void): () => void;
}

// ============================================================================
// Legacy adapter (kept for backward compatibility during migration)
// ============================================================================

/** @deprecated Use Transport instead. Will be removed after unification. */
export interface AdapterTransportProvider {
  /** Create a transport instance for inter-agent communication. */
  createTransport(): unknown;
  /** Name of this transport type for logging/debugging. */
  readonly transportName: string;
}
