/**
 * SseTransport — Server-Sent Events transport with HTTP polling fallback.
 *
 * Receives messages in real-time via SSE from the SignalDock v2 API.
 * Sends messages and acks via HTTP POST (SSE is receive-only).
 * Falls back to HTTP polling when SSE is unavailable or disconnects.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.4
 * @task T216
 */

import type { ConduitMessage, Transport, TransportConnectConfig } from '@cleocode/contracts';

/** Maximum reconnect attempts before permanent HTTP fallback. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** SSE transport mode. */
type SseMode = 'sse' | 'http-fallback';

/** Internal connection state. */
interface SseTransportState {
  agentId: string;
  apiKey: string;
  apiBaseUrl: string;
  sseEndpoint: string;
  eventSource: EventSource | null;
  mode: SseMode;
  messageBuffer: ConduitMessage[];
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connected: boolean;
}

/** SseTransport — real-time SSE with HTTP polling fallback. */
export class SseTransport implements Transport {
  readonly name = 'sse';
  private state: SseTransportState | null = null;

  /**
   * Connect to the SSE endpoint for real-time message delivery.
   *
   * If SSE connection fails, falls back to HTTP polling mode.
   * Auth is conveyed via query parameter (SSE doesn't support custom headers).
   */
  async connect(config: TransportConnectConfig): Promise<void> {
    if (this.state?.connected) {
      throw new Error('SseTransport already connected. Disconnect first.');
    }

    const sseEndpoint = config.sseEndpoint;
    if (!sseEndpoint && !config.apiBaseUrl) {
      throw new Error('SseTransport requires sseEndpoint or apiBaseUrl in config.');
    }

    const endpoint = sseEndpoint ?? `${config.apiBaseUrl}/sse`;

    this.state = {
      agentId: config.agentId,
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      sseEndpoint: endpoint,
      eventSource: null,
      mode: 'sse',
      messageBuffer: [],
      reconnectAttempts: 0,
      reconnectTimer: null,
      connected: false,
    };

    try {
      await this.connectSse();
    } catch {
      // SSE failed — fall back to HTTP polling
      this.state.mode = 'http-fallback';
      this.state.connected = true;
    }
  }

  /** Disconnect the transport, closing SSE and clearing all state. */
  async disconnect(): Promise<void> {
    if (!this.state) return;

    if (this.state.eventSource) {
      this.state.eventSource.close();
    }
    if (this.state.reconnectTimer) {
      clearTimeout(this.state.reconnectTimer);
    }
    this.state.messageBuffer = [];
    this.state.connected = false;
    this.state = null;
  }

  /**
   * Send a message via HTTP POST.
   *
   * SSE is receive-only — all sends go through HTTP regardless of SSE state.
   */
  async push(
    to: string,
    content: string,
    options?: { conversationId?: string; replyTo?: string },
  ): Promise<{ messageId: string }> {
    this.ensureConnected();

    const body: Record<string, string> = { content, toAgentId: to };
    let path = '/messages';

    if (options?.conversationId) {
      path = `/conversations/${options.conversationId}/messages`;
      if (options.replyTo) {
        body['replyTo'] = options.replyTo;
      }
    }

    const response = await this.httpFetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SseTransport push failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      data?: { message?: { id?: string }; id?: string };
    };
    return { messageId: data.data?.message?.id ?? data.data?.id ?? 'unknown' };
  }

  /**
   * Poll for messages.
   *
   * In SSE mode: drains the internal message buffer (no HTTP request).
   * In HTTP fallback mode: fetches via GET /messages/peek.
   */
  async poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    this.ensureConnected();

    if (this.state!.mode === 'sse' && this.state!.eventSource) {
      // Drain buffer — messages arrived via SSE push
      let messages = this.state!.messageBuffer.splice(0);

      if (options?.since) {
        messages = messages.filter((m) => m.timestamp > options.since!);
      }
      if (options?.limit && messages.length > options.limit) {
        // Put excess back in buffer
        const excess = messages.splice(options.limit);
        this.state!.messageBuffer.unshift(...excess);
      }
      return messages;
    }

    // HTTP fallback mode
    return this.httpPoll(options);
  }

  /** Acknowledge messages via HTTP POST. */
  async ack(messageIds: string[]): Promise<void> {
    this.ensureConnected();
    if (messageIds.length === 0) return;

    await this.httpFetch('/messages/ack', {
      method: 'POST',
      body: JSON.stringify({ messageIds }),
    });
  }

  /**
   * Subscribe to real-time messages.
   *
   * In SSE mode, messages are pushed to the handler as they arrive.
   * In HTTP fallback mode, polls on an interval.
   */
  subscribe(handler: (message: ConduitMessage) => void): () => void {
    this.ensureConnected();

    // For SSE mode, we intercept messages as they arrive in the buffer
    // by wrapping the buffer push with a notification
    const originalPush = this.state!.messageBuffer.push.bind(this.state!.messageBuffer);
    const wrappedPush = (...items: ConduitMessage[]): number => {
      for (const item of items) {
        handler(item);
      }
      return originalPush(...items);
    };
    this.state!.messageBuffer.push = wrappedPush;

    // Also start HTTP polling interval for fallback mode
    const interval = setInterval(async () => {
      if (this.state?.mode === 'http-fallback') {
        const messages = await this.httpPoll({ limit: 20 });
        for (const msg of messages) handler(msg);
        if (messages.length > 0) {
          await this.ack(messages.map((m) => m.id));
        }
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      if (this.state) {
        // Restore original push
        this.state.messageBuffer.push = originalPush;
      }
    };
  }

  // --------------------------------------------------------------------------
  // SSE connection management
  // --------------------------------------------------------------------------

  /** Establish SSE connection. Resolves when open, rejects on error. */
  private connectSse(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.state) {
        reject(new Error('No state'));
        return;
      }

      // SSE doesn't support custom headers — auth via query param
      const url = `${this.state.sseEndpoint}?token=${encodeURIComponent(this.state.apiKey)}&agent_id=${encodeURIComponent(this.state.agentId)}`;

      const es = new EventSource(url);
      this.state.eventSource = es;

      const timeout = setTimeout(() => {
        es.close();
        reject(new Error('SSE connection timeout'));
      }, 10_000);

      es.addEventListener('open', () => {
        clearTimeout(timeout);
        this.state!.connected = true;
        this.state!.reconnectAttempts = 0;
        resolve();
      });

      es.addEventListener('message', (event: MessageEvent) => {
        this.handleSseMessage(event);
      });

      es.addEventListener('error', () => {
        clearTimeout(timeout);
        if (!this.state!.connected) {
          // Initial connection failed
          es.close();
          reject(new Error('SSE connection failed'));
        } else {
          // Connection dropped — attempt reconnect
          this.handleSseDisconnect();
        }
      });
    });
  }

  /** Handle an incoming SSE message event. */
  private handleSseMessage(event: MessageEvent): void {
    if (!this.state) return;

    try {
      const data = JSON.parse(event.data as string) as {
        id?: string;
        from_agent_id?: string;
        from?: string;
        content?: string;
        conversation_id?: string;
        threadId?: string;
        created_at?: string;
        timestamp?: string;
        type?: string;
      };

      // Skip heartbeat events
      if (data.type === 'heartbeat' || data.type === 'ping') return;

      // Skip self-sent messages
      const from = data.from_agent_id ?? data.from ?? 'unknown';
      if (from === this.state.agentId) return;

      const message: ConduitMessage = {
        id: data.id ?? `sse-${Date.now()}`,
        from,
        content: data.content ?? '',
        threadId: data.conversation_id ?? data.threadId,
        timestamp: data.created_at ?? data.timestamp ?? new Date().toISOString(),
      };

      this.state.messageBuffer.push(message);
    } catch {
      // Malformed SSE data — skip silently
    }
  }

  /** Handle SSE connection drop — attempt reconnect with backoff. */
  private handleSseDisconnect(): void {
    if (!this.state) return;

    this.state.eventSource?.close();
    this.state.eventSource = null;
    this.state.reconnectAttempts++;

    if (this.state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      // Switch to permanent HTTP fallback
      this.state.mode = 'http-fallback';
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, ...
    const delay = Math.min(
      1000 * 2 ** (this.state.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    this.state.reconnectTimer = setTimeout(() => {
      void this.connectSse().catch(() => {
        this.handleSseDisconnect();
      });
    }, delay);
  }

  // --------------------------------------------------------------------------
  // HTTP helpers
  // --------------------------------------------------------------------------

  /** HTTP poll for messages (used in fallback mode). */
  private async httpPoll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    const params = new URLSearchParams();
    params.set('mentioned', this.state!.agentId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.since) params.set('since', options.since);

    const response = await this.httpFetch(`/messages/peek?${params}`, { method: 'GET' });
    if (!response.ok) return [];

    const data = (await response.json()) as {
      data?: {
        messages?: Array<{
          id: string;
          fromAgentId?: string;
          content?: string;
          conversationId?: string;
          createdAt?: string;
        }>;
      };
    };

    return (data.data?.messages ?? []).map((m) => ({
      id: m.id,
      from: m.fromAgentId ?? 'unknown',
      content: m.content ?? '',
      threadId: m.conversationId,
      timestamp: m.createdAt ?? new Date().toISOString(),
    }));
  }

  /** Make an authenticated HTTP request to the API. */
  private async httpFetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.state!.apiBaseUrl}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.state!.apiKey}`,
        'X-Agent-Id': this.state!.agentId,
        ...(init.headers as Record<string, string>),
      },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  }

  /** Throw if not connected. */
  private ensureConnected(): void {
    if (!this.state?.connected) {
      throw new Error('SseTransport not connected. Call connect() first.');
    }
  }
}
