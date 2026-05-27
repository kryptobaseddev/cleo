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
  ConduitTopicPublishOptions,
  ConduitTopicSubscribeOptions,
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

  /** One-shot poll for new messages. Delegates to the transport's poll method. */
  async poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    return this.transport.poll(options);
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

  // ── A2A Topic Pub-Sub (T1252) ────────────────────────────────────────────

  /**
   * Subscribe this agent to a named topic for broadcast messages.
   *
   * Delegates to the underlying transport's `subscribeTopic()` method.
   * Only `LocalTransport` supports topic operations in this release;
   * calling this on transports that lack the method throws.
   *
   * @param topicName - Topic name, e.g. `"epic-T1149.wave-2"`.
   * @param options   - Optional subscription filter.
   * @throws When the underlying transport does not support topic subscriptions.
   * @task T1252
   */
  async subscribeTopic(topicName: string, options?: ConduitTopicSubscribeOptions): Promise<void> {
    if (!this.transport.subscribeTopic) {
      throw new Error(
        'ConduitClient.subscribeTopic: underlying transport does not support topic subscriptions. Use LocalTransport.',
      );
    }
    await this.transport.subscribeTopic(topicName, options);
  }

  /**
   * Publish a message to a named topic (broadcast to all subscribers).
   *
   * @param topicName - Target topic name.
   * @param content   - Human-readable message content.
   * @param options   - Message kind and optional structured payload.
   * @returns Send result with the assigned message ID.
   * @throws When the underlying transport does not support topic publishing.
   * @task T1252
   */
  async publishToTopic(
    topicName: string,
    content: string,
    options?: ConduitTopicPublishOptions,
  ): Promise<ConduitSendResult> {
    if (!this.transport.publishToTopic) {
      throw new Error(
        'ConduitClient.publishToTopic: underlying transport does not support topic publishing. Use LocalTransport.',
      );
    }
    const result = await this.transport.publishToTopic(topicName, content, options);
    return {
      messageId: result.messageId,
      deliveredAt: new Date().toISOString(),
    };
  }

  /**
   * Register a real-time handler for messages on a named topic.
   *
   * @param topicName - Topic name to watch.
   * @param handler   - Callback invoked for each message.
   * @returns Unsubscribe function that stops delivery to this handler.
   * @throws When the underlying transport does not support topic handlers.
   * @task T1252
   */
  onTopic(topicName: string, handler: (message: ConduitMessage) => void): ConduitUnsubscribe {
    if (!this.transport.onTopic) {
      throw new Error(
        'ConduitClient.onTopic: underlying transport does not support topic handlers. Use LocalTransport.',
      );
    }
    return this.transport.onTopic(topicName, handler);
  }

  /**
   * Unsubscribe this agent from a named topic.
   *
   * @param topicName - Topic name to leave.
   * @throws When the underlying transport does not support topic unsubscription.
   * @task T1252
   */
  async unsubscribeTopic(topicName: string): Promise<void> {
    if (!this.transport.unsubscribeTopic) {
      throw new Error(
        'ConduitClient.unsubscribeTopic: underlying transport does not support topic unsubscription. Use LocalTransport.',
      );
    }
    await this.transport.unsubscribeTopic(topicName);
  }

  /** Disconnect the transport and reset state to disconnected. */
  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this.state = 'disconnected';
  }
}
