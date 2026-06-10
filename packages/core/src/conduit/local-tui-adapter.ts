/**
 * LocalTuiChannelAdapter — the first reference {@link ChannelAdapter} (T11952).
 *
 * A fully-offline, daemon-OFF terminal channel that rides the EXISTING conduit
 * {@link Transport} (the project-local `LocalTransport` over conduit.db). It
 * needs no network and no platform credential: the single local operator on the
 * other end of stdin/stdout is treated as a verified sender.
 *
 * The adapter translates between the channel-native surface and the normalized
 * {@link InboundMsg} / {@link OutboundReply} shapes the {@link DeliveryRouter}
 * consumes. It does NOT reinvent the transport — every wire operation delegates
 * to the injected {@link Transport} (push/poll/subscribe), so the SAME adapter
 * works over `LocalTransport` in production and an in-memory transport in tests.
 *
 * Platform adapters (Telegram/Discord/Slack/WhatsApp — T11855) implement the
 * same {@link ChannelAdapter} contract but are credential+network gated and are
 * out of scope for this contained increment.
 *
 * @epic T11854
 * @saga T10419
 * @module conduit/local-tui-adapter
 */

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelHealth,
  ChannelHealthStatus,
  ConduitMessage,
  InboundMsg,
  OutboundReply,
  Transport,
  TransportConnectConfig,
} from '@cleocode/contracts';

/** Default channel id for the Local-TUI adapter. */
export const LOCAL_TUI_CHANNEL_ID = 'local-tui';

/** Default session key used when no explicit thread is supplied (single TTY session). */
const DEFAULT_SESSION_KEY = 'tui';

/** Options for constructing a {@link LocalTuiChannelAdapter}. */
export interface LocalTuiChannelAdapterOptions {
  /** The transport this channel rides (e.g. conduit `LocalTransport`). */
  transport: Transport;
  /** Transport connect config (agentId / apiKey / apiBaseUrl). */
  connectConfig: TransportConnectConfig;
  /** Per-channel configuration. */
  config?: ChannelConfig;
  /** Channel id override (defaults to {@link LOCAL_TUI_CHANNEL_ID}). */
  id?: string;
}

/**
 * A bounded async queue that lets a push-style transport subscription be
 * consumed as a pull-style {@link AsyncIterable}.
 *
 * @internal
 */
class MessageQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  /** Enqueue a value (or hand it directly to a waiting consumer). */
  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  /** Close the queue: pending and future consumers receive `done`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined, done: true });
      waiter = this.waiters.shift();
    }
  }

  /** Pull the next value, awaiting one if the buffer is empty. */
  next(): Promise<IteratorResult<T>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/**
 * Local terminal channel adapter over a conduit {@link Transport}.
 *
 * @see T11952
 */
export class LocalTuiChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly config: ChannelConfig;

  private readonly transport: Transport;
  private readonly connectConfig: TransportConnectConfig;
  private status: ChannelHealthStatus = 'disconnected';
  private detail: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private queue: MessageQueue<InboundMsg> | undefined;

  /** Create a Local-TUI channel adapter. */
  constructor(options: LocalTuiChannelAdapterOptions) {
    this.transport = options.transport;
    this.connectConfig = options.connectConfig;
    this.id = options.id ?? LOCAL_TUI_CHANNEL_ID;
    this.config = options.config ?? {};
  }

  /**
   * Connect the transport and begin buffering inbound messages.
   *
   * Idempotent: a second `start()` while already connected is a no-op.
   */
  async start(): Promise<void> {
    if (this.status === 'connected') return;
    try {
      await this.transport.connect(this.connectConfig);
      if (this.transport.subscribe) {
        this.queue = new MessageQueue<InboundMsg>();
        this.unsubscribe = this.transport.subscribe((m) => this.onTransportMessage(m));
        this.status = 'connected';
      } else {
        // No real-time subscription — the channel still functions via poll(),
        // but inbound streaming is degraded (no queue: receive() drains poll()).
        this.queue = undefined;
        this.status = 'degraded';
        this.detail = 'transport has no subscribe(); receive() falls back to poll()';
      }
    } catch (err) {
      this.status = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Detach the subscription, end the inbound stream, and disconnect. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue?.close();
    this.queue = undefined;
    await this.transport.disconnect();
    this.status = 'disconnected';
    this.detail = undefined;
  }

  /**
   * Stream inbound messages as they arrive on the transport.
   *
   * Yields each {@link InboundMsg} until {@link LocalTuiChannelAdapter.stop}
   * ends the iterator. When the transport lacks `subscribe()`, falls back to a
   * single drain of `poll()` so the channel is still usable.
   */
  async *receive(): AsyncIterable<InboundMsg> {
    if (this.status !== 'connected' && this.status !== 'degraded') {
      throw new Error(`LocalTuiChannelAdapter.receive: channel "${this.id}" not started`);
    }

    // Degraded path: no real-time subscription — drain what poll() returns now.
    if (!this.queue) {
      const polled = await this.transport.poll();
      for (const m of polled) {
        const inbound = this.toInbound(m);
        if (inbound) yield inbound;
      }
      return;
    }

    const queue = this.queue;
    for (;;) {
      const result = await queue.next();
      if (result.done) return;
      yield result.value;
    }
  }

  /**
   * Send a reply back to the channel over the transport.
   *
   * @param reply - The reply. The destination session resolves from
   *   `reply.sessionKey` then `config.homeChannel` then the default TTY session.
   */
  async send(reply: OutboundReply): Promise<void> {
    if (this.status !== 'connected' && this.status !== 'degraded') {
      throw new Error(`LocalTuiChannelAdapter.send: channel "${this.id}" not started`);
    }
    const sessionKey = reply.sessionKey ?? this.config.homeChannel ?? DEFAULT_SESSION_KEY;
    // Reply is addressed back to the connected operator id; the conversation is
    // keyed by sessionKey so the originating thread is preserved.
    await this.transport.push(this.connectConfig.agentId, reply.content, {
      conversationId: sessionKey,
    });
  }

  /** Sample the adapter's current health. */
  health(): ChannelHealth {
    return {
      channelId: this.id,
      status: this.status,
      transport: this.transport.name,
      detail: this.detail,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Push a transport message onto the inbound queue (after policy filtering). */
  private onTransportMessage(message: ConduitMessage): void {
    const inbound = this.toInbound(message);
    if (inbound) {
      this.queue?.push(inbound);
    }
  }

  /**
   * Normalize a {@link ConduitMessage} into an {@link InboundMsg}, applying the
   * channel's allowlist + require-mention policy. Returns `undefined` when the
   * message is filtered out.
   */
  private toInbound(message: ConduitMessage): InboundMsg | undefined {
    const allowed = this.config.allowedUsers;
    if (allowed && allowed.length > 0 && !allowed.includes(message.from)) {
      return undefined;
    }
    if (this.config.requireMention && !this.mentionsAgent(message.content)) {
      return undefined;
    }
    return {
      id: message.id,
      channelId: this.id,
      from: message.from,
      content: message.content,
      sessionKey: message.threadId ?? this.config.homeChannel ?? DEFAULT_SESSION_KEY,
      timestamp: message.timestamp,
      payload: message.payload,
    };
  }

  /** Whether the message content mentions the connected agent id. */
  private mentionsAgent(content: string): boolean {
    return content.includes(`@${this.connectConfig.agentId}`);
  }
}
