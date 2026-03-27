/**
 * HttpTransport — HTTP polling transport to cloud SignalDock API.
 *
 * Implements the Transport interface using HTTP requests to the SignalDock
 * (currently clawmsgr.com) REST API. This is the default transport for
 * cloud-connected agents.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.4
 * @task T177
 */

import type { ConduitMessage, Transport, TransportConnectConfig } from '@cleocode/contracts';

/** Internal connection state. */
interface HttpTransportState {
  agentId: string;
  apiKey: string;
  apiBaseUrl: string;
  connected: boolean;
}

/** HTTP polling transport to cloud SignalDock API. */
export class HttpTransport implements Transport {
  readonly name = 'http';
  private state: HttpTransportState | null = null;

  async connect(config: TransportConnectConfig): Promise<void> {
    this.state = {
      agentId: config.agentId,
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      connected: true,
    };
  }

  async disconnect(): Promise<void> {
    this.state = null;
  }

  async push(
    to: string,
    content: string,
    options?: { conversationId?: string; replyTo?: string },
  ): Promise<{ messageId: string }> {
    this.ensureConnected();

    const body: Record<string, string> = { content };

    let url: string;
    if (options?.conversationId) {
      url = `${this.state!.apiBaseUrl}/conversations/${options.conversationId}/messages`;
      if (options.replyTo) {
        body['replyTo'] = options.replyTo;
      }
    } else {
      url = `${this.state!.apiBaseUrl}/messages`;
      body['toAgentId'] = to;
    }

    const response = await fetch(url, {
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

  async poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    this.ensureConnected();

    const params = new URLSearchParams();
    params.set('mentioned', this.state!.agentId);
    if (options?.limit) params.set('limit', String(options.limit));

    const url = `${this.state!.apiBaseUrl}/messages/peek?${params}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      data?: {
        messages?: Array<{
          id: string;
          senderAgentId?: string;
          content?: string;
          conversationId?: string;
          createdAt?: string;
        }>;
      };
    };

    return (data.data?.messages ?? []).map((m) => ({
      id: m.id,
      from: m.senderAgentId ?? 'unknown',
      content: m.content ?? '',
      threadId: m.conversationId,
      timestamp: m.createdAt ?? new Date().toISOString(),
    }));
  }

  async ack(messageIds: string[]): Promise<void> {
    this.ensureConnected();

    await fetch(`${this.state!.apiBaseUrl}/messages/ack`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messageIds }),
    });
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
