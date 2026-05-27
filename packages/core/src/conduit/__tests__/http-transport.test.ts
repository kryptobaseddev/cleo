/**
 * HttpTransport test suite.
 *
 * Uses `vi.stubGlobal('fetch', ...)` to mock the global fetch API so
 * no real network I/O occurs. Tests cover:
 * - connect with primary-only URL
 * - connect with primary/fallback failover
 * - push (send message)
 * - poll (receive messages)
 * - ack
 * - automatic failover on push/poll network failure
 * - error propagation on non-2xx responses
 * - not-connected guards
 *
 * @see packages/core/src/conduit/http-transport.ts
 * @task T180
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../http-transport.js';

// ============================================================================
// Fetch mock helpers
// ============================================================================

/** Build a mock Response object. */
function mockResponse(status: number, body: unknown, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

/** Standard connect config for tests. */
const CONFIG = {
  agentId: 'agent-001',
  apiKey: 'sk_live_test_key',
  apiBaseUrl: 'https://api.signaldock.io',
};

/** Config with a fallback URL. */
const CONFIG_WITH_FALLBACK = {
  ...CONFIG,
  apiBaseUrlFallback: 'https://api.clawmsgr.com',
};

// ============================================================================
// Test lifecycle
// ============================================================================

describe('HttpTransport', () => {
  let transport: HttpTransport;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    transport = new HttpTransport();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await transport.disconnect().catch(() => undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --------------------------------------------------------------------------
  // name
  // --------------------------------------------------------------------------

  describe('name', () => {
    it('is "http"', () => {
      expect(transport.name).toBe('http');
    });
  });

  // --------------------------------------------------------------------------
  // connect — primary only
  // --------------------------------------------------------------------------

  describe('connect (primary only)', () => {
    it('connects without probing health when no fallback is configured', async () => {
      await transport.connect(CONFIG);
      // No health probe issued — fetch should NOT have been called
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses primaryUrl as activeUrl when no fallback is provided', async () => {
      await transport.connect(CONFIG);
      // Verify activeUrl is used by making a push
      fetchMock.mockResolvedValue(mockResponse(200, { data: { message: { id: 'msg-1' } } }));
      await transport.push('to', 'content');
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api.signaldock.io');
    });
  });

  // --------------------------------------------------------------------------
  // connect — failover
  // --------------------------------------------------------------------------

  describe('connect (primary/fallback failover)', () => {
    it('stays on primary when both URLs are healthy', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(200, {})) // primary /health
        .mockResolvedValueOnce(mockResponse(200, {})); // fallback /health

      await transport.connect(CONFIG_WITH_FALLBACK);

      // Push to verify activeUrl is primary
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'p' } } }));
      await transport.push('to', 'x');
      const url = fetchMock.mock.calls[2][0] as string;
      expect(url).toContain('api.signaldock.io');
    });

    it('switches to fallback when primary health check fails', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('primary unreachable')) // primary /health
        .mockResolvedValueOnce(mockResponse(200, {})); // fallback /health

      await transport.connect(CONFIG_WITH_FALLBACK);

      // Push to verify activeUrl switched to fallback
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'f' } } }));
      await transport.push('to', 'x');
      const url = fetchMock.mock.calls[2][0] as string;
      expect(url).toContain('api.clawmsgr.com');
    });

    it('stays on primary when fallback health check fails', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(200, {})) // primary /health OK
        .mockRejectedValueOnce(new Error('fallback unreachable')); // fallback /health fails

      await transport.connect(CONFIG_WITH_FALLBACK);

      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'x' } } }));
      await transport.push('to', 'x');
      const url = fetchMock.mock.calls[2][0] as string;
      expect(url).toContain('api.signaldock.io');
    });
  });

  // --------------------------------------------------------------------------
  // disconnect
  // --------------------------------------------------------------------------

  describe('disconnect', () => {
    it('clears state so subsequent push throws', async () => {
      await transport.connect(CONFIG);
      await transport.disconnect();
      await expect(transport.push('to', 'msg')).rejects.toThrow('not connected');
    });

    it('is idempotent — safe to call twice', async () => {
      await transport.connect(CONFIG);
      await transport.disconnect();
      await expect(transport.disconnect()).resolves.not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // push
  // --------------------------------------------------------------------------

  describe('push', () => {
    beforeEach(async () => {
      await transport.connect(CONFIG);
    });

    it('sends POST to /messages with toAgentId and content', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'msg-001' } } }));

      const result = await transport.push('recipient', 'hello');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/messages');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.content).toBe('hello');
      expect(body.toAgentId).toBe('recipient');
      expect(result.messageId).toBe('msg-001');
    });

    it('sends POST to /conversations/{id}/messages when conversationId is provided', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { id: 'msg-conv-1' } }));

      const result = await transport.push('recipient', 'in-thread', { conversationId: 'conv-abc' });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/conversations/conv-abc/messages');
      expect(result.messageId).toBe('msg-conv-1');
    });

    it('includes Authorization and X-Agent-Id headers', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'x' } } }));

      await transport.push('to', 'msg');

      const [, init] = fetchMock.mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk_live_test_key');
      expect(headers['X-Agent-Id']).toBe('agent-001');
    });

    it('throws on non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(500, { error: 'server error' }, false));

      await expect(transport.push('to', 'msg')).rejects.toThrow('push failed');
    });

    it('falls back to alternateUrl on primary network error', async () => {
      // First connect to fresh transport with fallback
      const t = new HttpTransport();
      fetchMock
        .mockResolvedValueOnce(mockResponse(200, {})) // primary /health
        .mockResolvedValueOnce(mockResponse(200, {})); // fallback /health
      await t.connect(CONFIG_WITH_FALLBACK);

      // Push: primary fetch fails, fallback succeeds
      fetchMock
        .mockRejectedValueOnce(new Error('primary down'))
        .mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'fb-1' } } }));

      const result = await t.push('to', 'msg');
      expect(result.messageId).toBe('fb-1');

      await t.disconnect();
    });

    it('throws when not connected', async () => {
      const t = new HttpTransport();
      await expect(t.push('to', 'msg')).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // poll
  // --------------------------------------------------------------------------

  describe('poll', () => {
    beforeEach(async () => {
      await transport.connect(CONFIG);
    });

    it('returns messages from the API', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, {
          data: {
            messages: [
              {
                id: 'msg-1',
                fromAgentId: 'sender',
                content: 'hello',
                conversationId: 'c1',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: 'msg-2',
                fromAgentId: 'sender',
                content: 'world',
                conversationId: null,
                createdAt: '2026-01-01T00:01:00.000Z',
              },
            ],
          },
        }),
      );

      const messages = await transport.poll();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: 'msg-1',
        from: 'sender',
        content: 'hello',
        threadId: 'c1',
      });
      expect(messages[1]).toMatchObject({ id: 'msg-2', from: 'sender', content: 'world' });
    });

    it('returns empty array on non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(503, {}, false));
      const messages = await transport.poll();
      expect(messages).toHaveLength(0);
    });

    it('returns empty array when data.messages is absent', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: {} }));
      const messages = await transport.poll();
      expect(messages).toHaveLength(0);
    });

    it('appends limit and since to query string', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { messages: [] } }));

      await transport.poll({ limit: 20, since: '2026-01-01T00:00:00.000Z' });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('limit=20');
      expect(url).toContain('since=2026-01-01');
    });

    it('throws when not connected', async () => {
      const t = new HttpTransport();
      await expect(t.poll()).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // ack
  // --------------------------------------------------------------------------

  describe('ack', () => {
    beforeEach(async () => {
      await transport.connect(CONFIG);
    });

    it('sends POST to /messages/ack with messageIds', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, {}));

      await transport.ack(['id-1', 'id-2']);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/messages/ack');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.messageIds).toEqual(['id-1', 'id-2']);
    });

    it('handles empty messageIds array without error', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, {}));
      await expect(transport.ack([])).resolves.not.toThrow();
    });

    it('throws when not connected', async () => {
      const t = new HttpTransport();
      await expect(t.ack(['id'])).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // Timeout / AbortSignal
  // --------------------------------------------------------------------------

  describe('timeout handling', () => {
    beforeEach(async () => {
      await transport.connect(CONFIG);
    });

    it('propagates fetch AbortError on timeout', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      fetchMock.mockRejectedValueOnce(abortError);

      await expect(transport.push('to', 'msg')).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Full integration lifecycle
  // --------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('connect → push → poll → ack → disconnect', async () => {
      await transport.connect(CONFIG);

      // Push
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: { message: { id: 'sent-1' } } }));
      const sendResult = await transport.push('target', 'task complete');
      expect(sendResult.messageId).toBe('sent-1');

      // Poll
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, {
          data: {
            messages: [
              {
                id: 'recv-1',
                fromAgentId: 'orchestrator',
                content: 'next task',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      );
      const messages = await transport.poll();
      expect(messages).toHaveLength(1);

      // Ack
      fetchMock.mockResolvedValueOnce(mockResponse(200, {}));
      await transport.ack(['recv-1']);

      // Disconnect
      await transport.disconnect();
      await expect(transport.poll()).rejects.toThrow('not connected');
    });
  });
});
