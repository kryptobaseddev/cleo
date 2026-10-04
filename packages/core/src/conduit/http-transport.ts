/**
 * HttpTransport — HTTP polling transport against an agent's cloud messaging API.
 *
 * Connects to the configured API base URL and exposes push/poll/ack over
 * HTTP. A retired SignalDock base URL is refused at connect, and every request
 * goes through {@link conduitFetch} (T13169).
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.4
 * @task T177
 */

import type { ConduitMessage, Transport, TransportConnectConfig } from '@cleocode/contracts';
import { assertCloudUrlAllowed, conduitFetch } from './cloud-endpoint.js';

/** Internal connection state. */
interface HttpTransportState {
  agentId: string;
  apiKey: string;
  apiBaseUrl: string;
  connected: boolean;
}

/** HTTP polling transport for an agent's cloud messaging API. */
export class HttpTransport implements Transport {
  readonly name = 'http';
  private state: HttpTransportState | null = null;

  /**
   * Connect to the cloud messaging API.
   *
   * @throws {SignalDockRetiredError} When the base URL is a retired SignalDock host.
   */
  async connect(config: TransportConnectConfig): Promise<void> {
    assertCloudUrlAllowed(config.apiBaseUrl);
    this.state = {
      agentId: config.agentId,
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      connected: true,
    };
  }

  /** Disconnect and clear connection state. */
  async disconnect(): Promise<void> {
    this.state = null;
  }

  /** Send a message to an agent (direct or within a conversation thread). */
  async push(
    to: string,
    content: string,
    options?: { conversationId?: string; replyTo?: string },
  ): Promise<{ messageId: string }> {
    this.ensureConnected();

    const body: Record<string, string> = { content };

    let path: string;
    if (options?.conversationId) {
      path = `/conversations/${options.conversationId}/messages`;
      if (options.replyTo) {
        body['replyTo'] = options.replyTo;
      }
    } else {
      path = '/messages';
      body['toAgentId'] = to;
    }

    const response = await this.request(path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HttpTransport push failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      success?: boolean;
      data?: { message?: { id?: string }; id?: string };
    };
    const messageId = data.data?.message?.id ?? data.data?.id ?? 'unknown';
    return { messageId };
  }

  /** Poll for new messages for this agent. Returns empty array on HTTP error. */
  async poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    this.ensureConnected();

    const params = new URLSearchParams();
    // Don't filter by mentioned — the API already scopes by X-Agent-Id header.
    // Using mentioned= misses messages sent TO this agent without @-mentions.
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.since) params.set('since', options.since);

    const response = await this.request(`/messages/peek?${params}`, {
      method: 'GET',
      headers: this.headers(),
    });

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

  /** Acknowledge messages by ID so they are not returned by future polls. */
  async ack(messageIds: string[]): Promise<void> {
    this.ensureConnected();

    await this.request('/messages/ack', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messageIds }),
    });
  }

  /** Request against the configured API base URL with a 10s timeout. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(10000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return conduitFetch(`${this.state!.apiBaseUrl}${path}`, { ...init, signal });
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.state!.apiKey}`,
      'X-Agent-Id': this.state!.agentId,
    };
  }

  private ensureConnected(): void {
    if (!this.state?.connected) {
      throw new Error('HttpTransport not connected. Call connect() first.');
    }
  }
}
