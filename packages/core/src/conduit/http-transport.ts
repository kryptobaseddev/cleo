/**
 * HttpTransport — HTTP polling transport with automatic failover.
 *
 * Tries the primary API URL (api.signaldock.io) first. If unreachable,
 * falls back to the legacy URL (api.clawmsgr.com). Failover is transparent
 * to callers — they see a single transport that always works if either
 * endpoint is up.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.4
 * @task T177
 */

import type { ConduitMessage, Transport, TransportConnectConfig } from '@cleocode/contracts';

/** Internal connection state. */
interface HttpTransportState {
  agentId: string;
  apiKey: string;
  primaryUrl: string;
  fallbackUrl: string | null;
  activeUrl: string;
  connected: boolean;
}

/** HTTP transport with automatic primary/fallback failover. */
export class HttpTransport implements Transport {
  readonly name = 'http';
  private state: HttpTransportState | null = null;

  async connect(config: TransportConnectConfig): Promise<void> {
    const primaryUrl = config.apiBaseUrl;
    const fallbackUrl = config.apiBaseUrlFallback ?? null;

    // Test primary with a health check
    let activeUrl = primaryUrl;
    try {
      const health = await fetch(`${primaryUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!health.ok) throw new Error(`Health check returned ${health.status}`);
    } catch {
      // Primary unreachable — try fallback
      if (fallbackUrl) {
        try {
          const fallbackHealth = await fetch(`${fallbackUrl}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });
          if (fallbackHealth.ok) {
            activeUrl = fallbackUrl;
          }
        } catch {
          // Both down — use primary anyway, calls will fail with clear errors
        }
      }
    }

    this.state = {
      agentId: config.agentId,
      apiKey: config.apiKey,
      primaryUrl,
      fallbackUrl,
      activeUrl,
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

    const response = await this.fetchWithFallback(path, {
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
    if (options?.since) params.set('since', options.since);

    const response = await this.fetchWithFallback(`/messages/peek?${params}`, {
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

  async ack(messageIds: string[]): Promise<void> {
    this.ensureConnected();

    await this.fetchWithFallback('/messages/ack', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messageIds }),
    });
  }

  /**
   * Fetch with automatic failover. Tries activeUrl first.
   * If it fails and a fallback exists, retries on the other URL
   * and swaps activeUrl for subsequent calls.
   */
  private async fetchWithFallback(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.state!.activeUrl}${path}`;

    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10000),
      });
      return response;
    } catch (primaryErr) {
      // Primary failed — try fallback
      const otherUrl =
        this.state!.activeUrl === this.state!.primaryUrl
          ? this.state!.fallbackUrl
          : this.state!.primaryUrl;

      if (!otherUrl) throw primaryErr;

      try {
        const fallbackResponse = await fetch(`${otherUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(10000),
        });

        // Fallback worked — swap active URL for future calls
        this.state!.activeUrl = otherUrl;
        return fallbackResponse;
      } catch {
        // Both failed — throw original error
        throw primaryErr;
      }
    }
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
