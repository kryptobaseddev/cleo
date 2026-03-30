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

  /** Connect to the SignalDock API, probing primary/fallback health when both are configured. */
  async connect(config: TransportConnectConfig): Promise<void> {
    const primaryUrl = config.apiBaseUrl;
    const fallbackUrl = config.apiBaseUrlFallback ?? null;

    // Only probe health when there's a fallback to choose between
    let activeUrl = primaryUrl;
    if (fallbackUrl) {
      const [primaryResult, fallbackResult] = await Promise.allSettled([
        fetch(`${primaryUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(5000) }),
        fetch(`${fallbackUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(5000) }),
      ]);
      const primaryOk =
        primaryResult.status === 'fulfilled' && primaryResult.value.ok;
      const fallbackOk =
        fallbackResult.status === 'fulfilled' && fallbackResult.value.ok;
      if (!primaryOk && fallbackOk) {
        activeUrl = fallbackUrl;
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

  /** Poll for new messages mentioning this agent. Returns empty array on HTTP error. */
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

  /** Acknowledge messages by ID so they are not returned by future polls. */
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
    const timeout = AbortSignal.timeout(10000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const url = `${this.state!.activeUrl}${path}`;

    try {
      return await fetch(url, { ...init, signal });
    } catch (primaryErr) {
      const otherUrl =
        this.state!.activeUrl === this.state!.primaryUrl
          ? this.state!.fallbackUrl
          : this.state!.primaryUrl;

      if (!otherUrl) throw primaryErr;

      try {
        const fallbackSignal = init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000);
        const fallbackResponse = await fetch(`${otherUrl}${path}`, {
          ...init,
          signal: fallbackSignal,
        });
        this.state!.activeUrl = otherUrl;
        return fallbackResponse;
      } catch {
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
