/**
 * SseConnectionService — Persistent SSE connection manager.
 *
 * Maintains a persistent SSE connection to the SignalDock API for
 * real-time message delivery. Wraps SseTransport with lifecycle
 * management: start, stop, reconnect, and message forwarding.
 *
 * When SSE is available, messages arrive in real-time. When it falls
 * back to HTTP polling (managed by SseTransport internally), the
 * service continues operating transparently.
 *
 * @task T218
 */

import type { ConduitMessage, Transport } from '@cleocode/contracts';

/** SSE connection service configuration. */
export interface SseConnectionConfig {
  /** Agent ID to connect as. */
  agentId: string;
  /** API key for authentication. */
  apiKey: string;
  /** API base URL. */
  apiBaseUrl: string;
  /** SSE endpoint URL. If omitted, uses apiBaseUrl + /sse. */
  sseEndpoint?: string;
  /** Transport instance to use. Injected by createRuntime. */
  transport: Transport;
}

/** Message handler callback. */
export type SseMessageHandler = (message: ConduitMessage) => void;

/** SseConnectionService manages a persistent transport with subscribe() support. */
export class SseConnectionService {
  private config: SseConnectionConfig;
  private handler: SseMessageHandler | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;

  constructor(config: SseConnectionConfig) {
    this.config = config;
  }

  /** Register a message handler for incoming messages. */
  onMessage(handler: SseMessageHandler): void {
    this.handler = handler;
  }

  /** Start the SSE connection. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.config.transport.connect({
      agentId: this.config.agentId,
      apiKey: this.config.apiKey,
      apiBaseUrl: this.config.apiBaseUrl,
      sseEndpoint: this.config.sseEndpoint,
    });

    // Subscribe to incoming messages if transport supports it
    if (this.handler && this.config.transport.subscribe) {
      this.unsubscribe = this.config.transport.subscribe(this.handler);
    }
  }

  /** Stop the connection and clean up. */
  async stop(): Promise<void> {
    this.running = false;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    await this.config.transport.disconnect();
  }

  /** Get connection service status. */
  status(): { running: boolean; transportName: string } {
    return {
      running: this.running,
      transportName: this.config.transport.name,
    };
  }
}
