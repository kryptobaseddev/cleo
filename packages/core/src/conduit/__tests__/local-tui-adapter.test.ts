/**
 * LocalTuiChannelAdapter + DeliveryRouter + SessionStore test suite.
 *
 * Exercises the channel layer (T11952) over an IN-MEMORY {@link Transport}
 * implementation — no conduit.db, no network, no daemon. Verifies:
 *   - inbound message → router → adapter.send round-trips back to the channel,
 *   - per-channel session affinity is preserved across the round-trip,
 *   - allowlist + require-mention policy filtering,
 *   - health reporting,
 *   - SessionStore touch/get/list semantics,
 *   - DeliveryRouter registration + dispatch resolution order.
 *
 * @see packages/core/src/conduit/local-tui-adapter.ts
 * @see packages/core/src/conduit/delivery-router.ts
 * @task T11952
 * @epic T11854
 */

import { randomUUID } from 'node:crypto';
import type {
  ConduitMessage,
  InboundMsg,
  Transport,
  TransportConnectConfig,
} from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { DeliveryRouter, SessionStore } from '../delivery-router.js';
import { LOCAL_TUI_CHANNEL_ID, LocalTuiChannelAdapter } from '../local-tui-adapter.js';

// ============================================================================
// In-memory transport (test double)
// ============================================================================

/**
 * A minimal in-process {@link Transport} backed by arrays. Mirrors the
 * LocalTransport surface the adapter depends on (connect/disconnect/push/poll/
 * ack/subscribe) without any database or network.
 */
class InMemoryTransport implements Transport {
  readonly name = 'memory';
  connected = false;
  readonly sent: Array<{ to: string; content: string; conversationId?: string }> = [];
  private inbox: ConduitMessage[] = [];
  private subscribers = new Set<(m: ConduitMessage) => void>();

  async connect(_config: TransportConnectConfig): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subscribers.clear();
  }

  async push(
    to: string,
    content: string,
    options?: { conversationId?: string; replyTo?: string },
  ): Promise<{ messageId: string }> {
    const messageId = randomUUID();
    this.sent.push({ to, content, conversationId: options?.conversationId });
    return { messageId };
  }

  async poll(): Promise<ConduitMessage[]> {
    const drained = this.inbox;
    this.inbox = [];
    return drained;
  }

  async ack(_messageIds: string[]): Promise<void> {
    // no-op for the test double
  }

  subscribe(handler: (m: ConduitMessage) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Simulate an external party delivering an inbound message to the channel. */
  deliver(message: ConduitMessage): void {
    if (this.subscribers.size > 0) {
      for (const h of this.subscribers) h(message);
    } else {
      this.inbox.push(message);
    }
  }
}

/**
 * A transport WITHOUT a real-time `subscribe()` method — exercises the adapter's
 * degraded (poll-fallback) path. `subscribe` is intentionally absent so the
 * adapter takes the `if (this.transport.subscribe)` else-branch.
 */
class PollOnlyTransport implements Transport {
  readonly name = 'poll-only';
  private inbox: ConduitMessage[] = [];

  async connect(_config: TransportConnectConfig): Promise<void> {}

  async disconnect(): Promise<void> {}

  async push(): Promise<{ messageId: string }> {
    return { messageId: randomUUID() };
  }

  async poll(): Promise<ConduitMessage[]> {
    const drained = this.inbox;
    this.inbox = [];
    return drained;
  }

  async ack(_messageIds: string[]): Promise<void> {}

  /** Buffer an inbound message for the next poll(). */
  deliver(message: ConduitMessage): void {
    this.inbox.push(message);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function connectConfig(agentId = 'agent-1'): TransportConnectConfig {
  return { agentId, apiKey: 'sk_test_fake', apiBaseUrl: 'local' };
}

function inboundMessage(overrides: Partial<ConduitMessage> = {}): ConduitMessage {
  return {
    id: randomUUID(),
    from: 'operator',
    content: 'hello agent',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// LocalTuiChannelAdapter
// ============================================================================

describe('LocalTuiChannelAdapter', () => {
  it('has the canonical channel id + reports health', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });
    expect(adapter.id).toBe(LOCAL_TUI_CHANNEL_ID);

    const before = adapter.health();
    expect(before.status).toBe('disconnected');
    expect(before.transport).toBe('memory');

    await adapter.start();
    expect(adapter.health().status).toBe('connected');

    await adapter.stop();
    expect(adapter.health().status).toBe('disconnected');
  });

  it('streams inbound messages via receive() and normalizes them', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });
    await adapter.start();

    const received: InboundMsg[] = [];
    const pump = (async () => {
      for await (const msg of adapter.receive()) {
        received.push(msg);
        if (received.length === 2) {
          await adapter.stop();
        }
      }
    })();

    transport.deliver(inboundMessage({ content: 'first', threadId: 'thread-A' }));
    transport.deliver(inboundMessage({ content: 'second', threadId: 'thread-A' }));
    await pump;

    expect(received).toHaveLength(2);
    expect(received[0]?.content).toBe('first');
    expect(received[0]?.channelId).toBe(LOCAL_TUI_CHANNEL_ID);
    expect(received[0]?.sessionKey).toBe('thread-A');
  });

  it('send() pushes the reply over the transport keyed by session', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });
    await adapter.start();

    await adapter.send({ content: 'pong', sessionKey: 'thread-A' });
    await adapter.stop();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.content).toBe('pong');
    expect(transport.sent[0]?.conversationId).toBe('thread-A');
  });

  it('honors allowedUsers — filters out non-allowlisted senders', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({
      transport,
      connectConfig: connectConfig(),
      config: { allowedUsers: ['operator'] },
    });
    await adapter.start();

    const received: InboundMsg[] = [];
    const pump = (async () => {
      for await (const msg of adapter.receive()) {
        received.push(msg);
        await adapter.stop();
      }
    })();

    transport.deliver(inboundMessage({ from: 'stranger', content: 'blocked' }));
    transport.deliver(inboundMessage({ from: 'operator', content: 'allowed' }));
    await pump;

    expect(received).toHaveLength(1);
    expect(received[0]?.from).toBe('operator');
    expect(received[0]?.content).toBe('allowed');
  });

  it('honors requireMention — only yields messages mentioning the agent', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({
      transport,
      connectConfig: connectConfig('agent-1'),
      config: { requireMention: true },
    });
    await adapter.start();

    const received: InboundMsg[] = [];
    const pump = (async () => {
      for await (const msg of adapter.receive()) {
        received.push(msg);
        await adapter.stop();
      }
    })();

    transport.deliver(inboundMessage({ content: 'no mention here' }));
    transport.deliver(inboundMessage({ content: 'hey @agent-1 help' }));
    await pump;

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toContain('@agent-1');
  });

  it('reports degraded health + drains poll() when transport lacks subscribe()', async () => {
    const transport = new PollOnlyTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });

    transport.deliver(inboundMessage({ content: 'polled' }));
    await adapter.start();
    expect(adapter.health().status).toBe('degraded');

    const received: InboundMsg[] = [];
    for await (const msg of adapter.receive()) {
      received.push(msg);
    }
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe('polled');
    await adapter.stop();
  });

  it('rejects send()/receive() before start()', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });
    await expect(adapter.send({ content: 'x' })).rejects.toThrow('not started');

    const drain = async (): Promise<void> => {
      const iterator = adapter.receive()[Symbol.asyncIterator]();
      await iterator.next();
    };
    await expect(drain()).rejects.toThrow('not started');
  });
});

// ============================================================================
// SessionStore
// ============================================================================

describe('SessionStore', () => {
  it('touch() records and get() retrieves per (channel, session) affinity', () => {
    const store = new SessionStore();
    const msg: InboundMsg = {
      id: 'm1',
      channelId: LOCAL_TUI_CHANNEL_ID,
      from: 'operator',
      content: 'hi',
      sessionKey: 'thread-A',
      timestamp: new Date().toISOString(),
    };
    store.touch(msg);

    const session = store.get(LOCAL_TUI_CHANNEL_ID, 'thread-A');
    expect(session?.lastFrom).toBe('operator');
    expect(session?.lastInboundId).toBe('m1');
    expect(store.get(LOCAL_TUI_CHANNEL_ID, 'nope')).toBeUndefined();
  });

  it('list() returns all sessions newest-first; clear() empties', () => {
    const store = new SessionStore();
    store.touch({
      id: 'a',
      channelId: 'c',
      from: 'u',
      content: 'x',
      sessionKey: 's1',
      timestamp: '2026-06-10T10:00:00.000Z',
    });
    store.touch({
      id: 'b',
      channelId: 'c',
      from: 'u',
      content: 'x',
      sessionKey: 's2',
      timestamp: '2026-06-10T11:00:00.000Z',
    });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.sessionKey).toBe('s2');
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

// ============================================================================
// DeliveryRouter — end-to-end round-trip with session affinity
// ============================================================================

describe('DeliveryRouter', () => {
  it('ingest() routes inbound → handler → reply back to the originating channel', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });
    await adapter.start();

    const router = new DeliveryRouter();
    router.register(adapter);

    const inbound: InboundMsg = {
      id: 'in-1',
      channelId: LOCAL_TUI_CHANNEL_ID,
      from: 'operator',
      content: 'ping',
      sessionKey: 'thread-A',
      timestamp: new Date().toISOString(),
    };

    await router.ingest(inbound, async (msg) => ({ content: `re: ${msg.content}` }));

    // Reply round-tripped back to the SAME channel + session (affinity).
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.content).toBe('re: ping');
    expect(transport.sent[0]?.conversationId).toBe('thread-A');

    // Session affinity persisted in the store.
    const session = router.sessions.get(LOCAL_TUI_CHANNEL_ID, 'thread-A');
    expect(session?.lastInboundId).toBe('in-1');

    await adapter.stop();
  });

  it('run() drains the adapter stream and round-trips each message', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({ transport, connectConfig: connectConfig() });
    await adapter.start();

    const router = new DeliveryRouter();
    router.register(adapter);

    let seen = 0;
    const runner = router.run(LOCAL_TUI_CHANNEL_ID, async (msg) => {
      seen += 1;
      // Close the stream once both messages have been fully handled (reply
      // dispatched) — scheduled on a later tick so this handler's own reply
      // dispatch completes before the adapter disconnects.
      if (seen === 2) {
        setTimeout(() => void adapter.stop(), 0);
      }
      return { content: `ack ${msg.content}` };
    });

    transport.deliver(inboundMessage({ content: 'one', threadId: 't1' }));
    transport.deliver(inboundMessage({ content: 'two', threadId: 't1' }));
    await runner;

    expect(seen).toBe(2);
    expect(transport.sent.map((s) => s.content)).toEqual(['ack one', 'ack two']);
  });

  it('register() rejects duplicate channel ids', () => {
    const router = new DeliveryRouter();
    const t = new InMemoryTransport();
    router.register(new LocalTuiChannelAdapter({ transport: t, connectConfig: connectConfig() }));
    expect(() =>
      router.register(new LocalTuiChannelAdapter({ transport: t, connectConfig: connectConfig() })),
    ).toThrow('already registered');
  });

  it('dispatch() resolves homeChannel when no session is supplied', async () => {
    const transport = new InMemoryTransport();
    const adapter = new LocalTuiChannelAdapter({
      transport,
      connectConfig: connectConfig(),
      config: { homeChannel: 'home-thread' },
    });
    await adapter.start();

    const router = new DeliveryRouter();
    router.register(adapter);

    await router.dispatch({ channelId: LOCAL_TUI_CHANNEL_ID, content: 'fallback' });
    expect(transport.sent[0]?.conversationId).toBe('home-thread');
    await adapter.stop();
  });

  it('dispatch() throws when no target channel can be resolved', async () => {
    const router = new DeliveryRouter();
    await expect(router.dispatch({ content: 'orphan' })).rejects.toThrow('no target channel');
  });

  it('dispatch() throws when the target channel is unregistered', async () => {
    const router = new DeliveryRouter();
    await expect(router.dispatch({ channelId: 'ghost', content: 'x' })).rejects.toThrow(
      'not registered',
    );
  });
});
