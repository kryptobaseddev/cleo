/**
 * ConduitClient test suite.
 *
 * Tests state transitions (disconnected → connecting → connected | error),
 * message send/receive delegation to the transport, polling fallback,
 * heartbeat, and disconnect lifecycle.
 *
 * Uses a mock transport to avoid network I/O.
 *
 * @see packages/core/src/conduit/conduit-client.ts
 * @task T180
 */

import type { AgentCredential, ConduitMessage, Transport } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConduitClient } from '../conduit-client.js';

// ============================================================================
// Mock transport factory
// ============================================================================

/** Create a fully-controlled mock Transport. */
function makeMockTransport(overrides?: Partial<Transport>): Transport {
  return {
    name: 'mock',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue({ messageId: 'mock-msg-id' }),
    poll: vi.fn().mockResolvedValue([]),
    ack: vi.fn().mockResolvedValue(undefined),
    subscribe: undefined,
    ...overrides,
  };
}

/** A minimal AgentCredential for testing. */
function makeCredential(overrides?: Partial<AgentCredential>): AgentCredential {
  return {
    agentId: 'test-agent',
    displayName: 'Test Agent',
    apiKey: 'sk_live_test123',
    apiBaseUrl: 'https://api.signaldock.io',
    privacyTier: 'private',
    capabilities: [],
    skills: [],
    transportType: 'http',
    transportConfig: { pollIntervalMs: 5000 },
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Create a message fixture. */
function makeMessage(overrides?: Partial<ConduitMessage>): ConduitMessage {
  return {
    id: 'msg-001',
    from: 'sender-agent',
    content: 'hello world',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// State transitions
// ============================================================================

describe('ConduitClient', () => {
  let transport: Transport;
  let credential: AgentCredential;

  beforeEach(() => {
    transport = makeMockTransport();
    credential = makeCredential();
  });

  describe('initial state', () => {
    it('starts in disconnected state', () => {
      const client = new ConduitClient(transport, credential);
      expect(client.getState()).toBe('disconnected');
    });

    it('exposes agentId from the credential', () => {
      const client = new ConduitClient(transport, credential);
      expect(client.agentId).toBe('test-agent');
    });
  });

  // --------------------------------------------------------------------------
  // connect()
  // --------------------------------------------------------------------------

  describe('connect', () => {
    it('transitions disconnected → connecting → connected on success', async () => {
      const states: string[] = [];
      // Capture state mid-connect by spying before + after
      const connectMock = vi.fn().mockImplementation(async () => {
        // State should be 'connecting' while transport.connect runs
        states.push(client.getState());
      });
      transport = makeMockTransport({ connect: connectMock });
      const client = new ConduitClient(transport, credential);

      states.push(client.getState()); // initial: disconnected
      await client.connect();
      states.push(client.getState()); // final: connected

      expect(states).toEqual(['disconnected', 'connecting', 'connected']);
    });

    it('transitions to error state when transport.connect throws', async () => {
      const connectMock = vi.fn().mockRejectedValue(new Error('network unreachable'));
      transport = makeMockTransport({ connect: connectMock });
      const client = new ConduitClient(transport, credential);

      await expect(client.connect()).rejects.toThrow('network unreachable');
      expect(client.getState()).toBe('error');
    });

    it('passes agentId, apiKey, and apiBaseUrl to transport.connect', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'test-agent',
          apiKey: 'sk_live_test123',
          apiBaseUrl: 'https://api.signaldock.io',
        }),
      );
    });

    it('passes transportConfig fields to transport.connect', async () => {
      const cred = makeCredential({
        transportConfig: { pollIntervalMs: 1000, sseEndpoint: 'https://sse.example.com' },
      });
      const client = new ConduitClient(transport, cred);
      await client.connect();

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          pollIntervalMs: 1000,
          sseEndpoint: 'https://sse.example.com',
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // disconnect()
  // --------------------------------------------------------------------------

  describe('disconnect', () => {
    it('transitions connected → disconnected', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();
      expect(client.getState()).toBe('connected');

      await client.disconnect();
      expect(client.getState()).toBe('disconnected');
    });

    it('delegates to transport.disconnect()', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();
      await client.disconnect();

      expect(transport.disconnect).toHaveBeenCalledOnce();
    });

    it('is safe to call without connecting first (no throw)', async () => {
      const client = new ConduitClient(transport, credential);
      await expect(client.disconnect()).resolves.not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  describe('send', () => {
    it('delegates to transport.push and returns messageId + deliveredAt', async () => {
      transport = makeMockTransport({ push: vi.fn().mockResolvedValue({ messageId: 'msg-xyz' }) });
      const client = new ConduitClient(transport, credential);
      await client.connect();

      const result = await client.send('target-agent', 'hello');
      expect(result.messageId).toBe('msg-xyz');
      expect(result.deliveredAt).toBeDefined();
      expect(new Date(result.deliveredAt).toString()).not.toBe('Invalid Date');
    });

    it('forwards threadId as conversationId to transport.push', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();

      await client.send('target', 'msg', { threadId: 'conv-001' });
      expect(transport.push).toHaveBeenCalledWith(
        'target',
        'msg',
        expect.objectContaining({ conversationId: 'conv-001' }),
      );
    });

    it('calls push without conversationId when threadId is not provided', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();

      await client.send('target', 'msg');
      expect(transport.push).toHaveBeenCalledWith(
        'target',
        'msg',
        expect.objectContaining({ conversationId: undefined }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // poll()
  // --------------------------------------------------------------------------

  describe('poll', () => {
    it('delegates to transport.poll and returns messages', async () => {
      const messages = [makeMessage(), makeMessage({ id: 'msg-002', content: 'second' })];
      transport = makeMockTransport({ poll: vi.fn().mockResolvedValue(messages) });
      const client = new ConduitClient(transport, credential);
      await client.connect();

      const result = await client.poll();
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('hello world');
      expect(result[1].content).toBe('second');
    });

    it('forwards limit and since options to transport.poll', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();

      await client.poll({ limit: 10, since: '2026-01-01T00:00:00.000Z' });
      expect(transport.poll).toHaveBeenCalledWith({ limit: 10, since: '2026-01-01T00:00:00.000Z' });
    });

    it('returns empty array when there are no messages', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();

      const result = await client.poll();
      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // onMessage() — subscribe delegation
  // --------------------------------------------------------------------------

  describe('onMessage', () => {
    it('uses transport.subscribe when it is available', () => {
      const subscribeMock = vi.fn().mockReturnValue(() => undefined);
      transport = makeMockTransport({ subscribe: subscribeMock });
      const client = new ConduitClient(transport, credential);

      const handler = vi.fn();
      client.onMessage(handler);

      expect(subscribeMock).toHaveBeenCalledWith(handler);
    });

    it('returns an unsubscribe function that cleans up the interval when transport has no subscribe', async () => {
      vi.useFakeTimers();
      transport = makeMockTransport({ subscribe: undefined });
      const client = new ConduitClient(transport, credential);
      await client.connect();

      const handler = vi.fn();
      const unsub = client.onMessage(handler);

      // Advance timer to trigger a poll cycle
      await vi.advanceTimersByTimeAsync(6000);
      expect(transport.poll).toHaveBeenCalled();

      // Unsubscribe and confirm poll stops being called
      const callCountBefore = (transport.poll as ReturnType<typeof vi.fn>).mock.calls.length;
      unsub();
      await vi.advanceTimersByTimeAsync(12000);
      const callCountAfter = (transport.poll as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);

      vi.useRealTimers();
    });

    it('delivers polled messages to handler in fallback polling mode', async () => {
      vi.useFakeTimers();
      const msg = makeMessage();
      transport = makeMockTransport({
        subscribe: undefined,
        poll: vi.fn().mockResolvedValue([msg]),
        ack: vi.fn().mockResolvedValue(undefined),
      });
      const client = new ConduitClient(transport, credential);
      await client.connect();

      const received: ConduitMessage[] = [];
      client.onMessage((m) => received.push(m));

      await vi.advanceTimersByTimeAsync(6000);
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0].content).toBe('hello world');

      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // heartbeat()
  // --------------------------------------------------------------------------

  describe('heartbeat', () => {
    it('sends an empty push to own agentId', async () => {
      const client = new ConduitClient(transport, credential);
      await client.connect();

      await client.heartbeat();

      expect(transport.push).toHaveBeenCalledWith('test-agent', '', {});
    });
  });

  // --------------------------------------------------------------------------
  // Integration: full lifecycle
  // --------------------------------------------------------------------------

  describe('full message lifecycle', () => {
    it('connect → send → poll → disconnect without errors', async () => {
      const sentMessages: ConduitMessage[] = [
        makeMessage({ id: 'sent-1', content: 'task-result' }),
      ];
      transport = makeMockTransport({
        push: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
        poll: vi.fn().mockResolvedValue(sentMessages),
      });
      const client = new ConduitClient(transport, credential);

      await client.connect();
      expect(client.getState()).toBe('connected');

      const sendResult = await client.send('orchestrator', 'task-result');
      expect(sendResult.messageId).toBe('sent-1');

      const polled = await client.poll({ limit: 5 });
      expect(polled).toHaveLength(1);
      expect(polled[0].content).toBe('task-result');

      await client.disconnect();
      expect(client.getState()).toBe('disconnected');
    });
  });
});
