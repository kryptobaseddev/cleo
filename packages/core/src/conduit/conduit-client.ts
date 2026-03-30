/**
 * ConduitClient — High-level agent messaging that wraps a Transport adapter.
 *
 * This is the WHAT layer: send messages, subscribe to events, manage presence.
 * The Transport adapter (HttpTransport, LocalTransport, etc.) handles the HOW.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.3
 * @task T177
 */

import type {
  AgentCredential,
  Conduit,
  ConduitMessage,
  ConduitSendOptions,
  ConduitSendResult,
  ConduitState,
  ConduitUnsubscribe,
  Transport,
} from '@cleocode/contracts';

/** ConduitClient wraps a Transport, adding high-level messaging semantics. */
export class ConduitClient implements Conduit {
  private transport: Transport;
  private credential: AgentCredential;
  private state: ConduitState = 'disconnected';

  /** Create a ConduitClient backed by the given transport and credential. */
  constructor(transport: Transport, credential: AgentCredential) {
    this.transport = transport;
    this.credential = credential;
  }

  /** The agent ID from the bound credential. */
  get agentId(): string {
    return this.credential.agentId;
  }

  /** Current connection state (disconnected → connecting → connected | error). */
  getState(): ConduitState {
    return this.state;
  }

  /** Connect the underlying transport using the bound credential. */
  async connect(): Promise<void> {
    this.state = 'connecting';
    try {
      await this.transport.connect({
        agentId: this.credential.agentId,
        apiKey: this.credential.apiKey,
        apiBaseUrl: this.credential.apiBaseUrl,
        ...this.credential.transportConfig,
      });
      this.state = 'connected';
    } catch (err) {
      // H6 fix: transition to 'error' state instead of stuck at 'connecting'
      this.state = 'error';
      throw err;
    }
  }

  /** Send a message to another agent, optionally within a thread. */
  async send(
    to: string,
    content: string,
    options?: ConduitSendOptions,
  ): Promise<ConduitSendResult> {
    const result = await this.transport.push(to, content, {
      conversationId: options?.threadId,
    });
    return {
      messageId: result.messageId,
      deliveredAt: new Date().toISOString(),
    };
  }

  /** Subscribe to incoming messages. Uses real-time transport when available, else polls. */
  onMessage(handler: (message: ConduitMessage) => void): ConduitUnsubscribe {
    // Prefer real-time subscription if transport supports it
    if (this.transport.subscribe) {
      return this.transport.subscribe(handler);
    }
    // Fallback: polling loop
    const interval = setInterval(async () => {
      const messages = await this.transport.poll();
      for (const msg of messages) handler(msg);
      if (messages.length > 0) {
        await this.transport.ack(messages.map((m) => m.id));
      }
    }, this.credential.transportConfig.pollIntervalMs ?? 5000);
    return () => clearInterval(interval);
  }

  /** Send an empty heartbeat to maintain presence on the relay. */
  async heartbeat(): Promise<void> {
    // Send empty heartbeat via transport
    await this.transport.push(this.credential.agentId, '', {});
  }

  /** Check whether a remote agent is currently online via the cloud API. */
  async isOnline(agentId: string): Promise<boolean> {
    // Delegate to cloud API check — stub for now
    try {
      const response = await fetch(`${this.credential.apiBaseUrl}/agents/${agentId}`, {
        headers: {
          Authorization: `Bearer ${this.credential.apiKey}`,
          'X-Agent-Id': this.credential.agentId,
        },
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { data?: { agent?: { status?: string } } };
      return data.data?.agent?.status === 'online';
    } catch {
      return false;
    }
  }

  /** Disconnect the transport and reset state to disconnected. */
  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this.state = 'disconnected';
  }
}
