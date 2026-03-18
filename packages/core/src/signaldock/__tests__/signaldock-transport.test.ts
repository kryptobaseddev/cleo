/**
 * Unit tests for SignalDockTransport HTTP client.
 *
 * All HTTP calls are mocked via vi.stubGlobal('fetch') — no daemon needed.
 *
 * @task T5671
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalDockTransportConfig } from '../signaldock-transport.js';
import { SignalDockTransport } from '../signaldock-transport.js';
import type { Agent, ApiResponse, Conversation, Message } from '../types.js';

function makeConfig(overrides?: Partial<SignalDockTransportConfig>): SignalDockTransportConfig {
  return {
    endpoint: 'http://localhost:4000',
    agentPrefix: 'cleo-',
    privacyTier: 'private',
    ...overrides,
  };
}

function mockFetchResponse<T>(data: T, status = 200): Response {
  const envelope: ApiResponse<T> = { success: true, data };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(envelope),
    text: () => Promise.resolve(JSON.stringify(envelope)),
  } as unknown as Response;
}

function mockFetchError(status: number, body = 'Internal Server Error'): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function mock204Response(): Response {
  return {
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error('no content')),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function mockFetchEnvelopeError<T>(code: string, message: string): Response {
  const envelope: ApiResponse<T> = {
    success: false,
    error: { code, message },
  };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(envelope),
    text: () => Promise.resolve(JSON.stringify(envelope)),
  } as unknown as Response;
}

const mockAgent: Agent = {
  id: 'agent-uuid-1',
  name: 'cleo-orchestrator',
  agentClass: 'code_dev',
  privacyTier: 'private',
  status: 'online',
  createdAt: '2026-03-08T00:00:00Z',
  updatedAt: '2026-03-08T00:00:00Z',
};

const mockConversation: Conversation = {
  id: 'conv-uuid-1',
  participants: ['agent-1', 'agent-2'],
  visibility: 'private',
  messageCount: 0,
  createdAt: '2026-03-08T00:00:00Z',
  updatedAt: '2026-03-08T00:00:00Z',
};

const mockMessage: Message = {
  id: 'msg-uuid-1',
  conversationId: 'conv-uuid-1',
  fromAgentId: 'agent-1',
  toAgentId: 'agent-2',
  content: 'Hello from CLEO',
  contentType: 'text',
  status: 'delivered',
  createdAt: '2026-03-08T00:00:00Z',
  deliveredAt: '2026-03-08T00:00:01Z',
};

describe('SignalDockTransport', () => {
  let transport: SignalDockTransport;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    transport = new SignalDockTransport(makeConfig());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name "signaldock"', () => {
    expect(transport.name).toBe('signaldock');
  });

  describe('register', () => {
    it('registers an agent with prefixed name', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockAgent));

      const result = await transport.register('orchestrator', 'code_dev', 'private');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/agents');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.name).toBe('cleo-orchestrator');
      expect(body.agentClass).toBe('code_dev');
      expect(body.privacyTier).toBe('private');

      expect(result).toEqual({
        agentId: 'agent-uuid-1',
        name: 'cleo-orchestrator',
        agentClass: 'code_dev',
        privacyTier: 'private',
      });
    });

    it('uses custom prefix from config', async () => {
      const customTransport = new SignalDockTransport(makeConfig({ agentPrefix: 'test-' }));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ ...mockAgent, name: 'test-worker' }));

      await customTransport.register('worker', 'code_dev', 'private');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.name).toBe('test-worker');
    });

    it('throws on non-200 response', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchError(409, 'Agent already exists'));

      await expect(transport.register('orchestrator', 'code_dev', 'private')).rejects.toThrow(
        /SignalDock API error.*409.*Agent already exists/,
      );
    });

    it('throws on envelope error with success:false', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchEnvelopeError('DUPLICATE', 'Agent name already taken'),
      );

      await expect(transport.register('orchestrator', 'code_dev', 'private')).rejects.toThrow(
        /SignalDock error \[DUPLICATE\]: Agent name already taken/,
      );
    });
  });

  describe('deregister', () => {
    it('sends DELETE request for agent ID', async () => {
      fetchMock.mockResolvedValueOnce(mock204Response());

      await transport.deregister('agent-uuid-1');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/agents/agent-uuid-1');
      expect(init.method).toBe('DELETE');
    });

    it('encodes agent ID in URL', async () => {
      fetchMock.mockResolvedValueOnce(mock204Response());

      await transport.deregister('agent/with special+chars');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/agents/agent%2Fwith%20special%2Bchars');
    });

    it('throws on non-200 DELETE response', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchError(404, 'Not found'));

      await expect(transport.deregister('nonexistent')).rejects.toThrow(
        /SignalDock API error.*404/,
      );
    });
  });

  describe('send', () => {
    it('creates a conversation then sends message when no conversationId given', async () => {
      // First call: createConversation
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockConversation));
      // Second call: send message
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockMessage));

      const result = await transport.send('agent-1', 'agent-2', 'Hello from CLEO');

      expect(fetchMock).toHaveBeenCalledTimes(2);

      // First call was POST /conversations
      const [convUrl, convInit] = fetchMock.mock.calls[0];
      expect(convUrl).toBe('http://localhost:4000/conversations');
      expect(convInit.method).toBe('POST');

      // Second call was POST /messages
      const [msgUrl, msgInit] = fetchMock.mock.calls[1];
      expect(msgUrl).toBe('http://localhost:4000/messages');
      expect(msgInit.method).toBe('POST');
      const msgBody = JSON.parse(msgInit.body);
      expect(msgBody.conversationId).toBe('conv-uuid-1');
      expect(msgBody.fromAgentId).toBe('agent-1');
      expect(msgBody.toAgentId).toBe('agent-2');
      expect(msgBody.content).toBe('Hello from CLEO');

      expect(result).toEqual({
        messageId: 'msg-uuid-1',
        conversationId: 'conv-uuid-1',
        status: 'delivered',
      });
    });

    it('skips conversation creation when conversationId is provided', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockMessage));

      await transport.send('agent-1', 'agent-2', 'Hello', 'existing-conv-id');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/messages');
    });

    it('maps non-delivered status to pending', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ ...mockMessage, status: 'pending' }));

      const result = await transport.send('agent-1', 'agent-2', 'Hello', 'conv-id');
      expect(result.status).toBe('pending');
    });

    it('maps read status to pending (not delivered)', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ ...mockMessage, status: 'read' }));

      const result = await transport.send('agent-1', 'agent-2', 'Hello', 'conv-id');
      // 'read' !== 'delivered', so maps to 'pending' per the ternary
      expect(result.status).toBe('pending');
    });

    it('sends X-Agent-Id header as fromAgentId', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockMessage));

      await transport.send('agent-1', 'agent-2', 'test', 'conv-id');

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['X-Agent-Id']).toBe('agent-1');
    });
  });

  describe('poll', () => {
    it('polls new messages for an agent', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse([mockMessage]));

      const result = await transport.poll('agent-2');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/messages/poll/new');
      expect(init.method).toBe('GET');
      expect(init.headers['X-Agent-Id']).toBe('agent-2');
      expect(result).toEqual([mockMessage]);
    });

    it('returns empty array when no messages', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse([]));

      const result = await transport.poll('agent-2');
      expect(result).toEqual([]);
    });

    it('throws on server error during poll', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchError(500, 'Server error'));

      await expect(transport.poll('agent-2')).rejects.toThrow(/SignalDock API error.*500/);
    });
  });

  describe('heartbeat', () => {
    it('sends heartbeat POST for agent', async () => {
      fetchMock.mockResolvedValueOnce(mock204Response());

      await transport.heartbeat('agent-uuid-1');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/agents/agent-uuid-1/heartbeat');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Agent-Id']).toBe('agent-uuid-1');
    });

    it('throws on heartbeat failure', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchError(404, 'Agent not found'));

      await expect(transport.heartbeat('nonexistent')).rejects.toThrow(/SignalDock API error.*404/);
    });
  });

  describe('createConversation', () => {
    it('creates a private conversation with sorted participants', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockConversation));

      const result = await transport.createConversation(['agent-2', 'agent-1'], 'private');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.participants).toEqual(['agent-1', 'agent-2']);
      expect(body.visibility).toBe('private');
      expect(result).toEqual(mockConversation);
    });

    it('defaults visibility to private', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockConversation));

      await transport.createConversation(['a', 'b']);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.visibility).toBe('private');
    });
  });

  describe('getAgent', () => {
    it('returns agent data for valid ID', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockAgent));

      const result = await transport.getAgent('agent-uuid-1');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:4000/agents/agent-uuid-1');
      expect(init.method).toBe('GET');
      expect(result).toEqual(mockAgent);
    });

    it('returns null when agent not found (swallows error)', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchError(404, 'Not found'));

      const result = await transport.getAgent('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null on network failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const result = await transport.getAgent('agent-uuid-1');
      expect(result).toBeNull();
    });
  });

  describe('error handling edge cases', () => {
    it('handles network failure (fetch throws)', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(transport.register('test', 'code_dev', 'private')).rejects.toThrow(
        'fetch failed',
      );
    });

    it('handles response.text() failure gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('body read failed')),
      });

      await expect(transport.register('test', 'code_dev', 'private')).rejects.toThrow(
        /SignalDock API error.*500/,
      );
    });

    it('handles malformed JSON response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
        text: () => Promise.resolve('not json'),
      });

      await expect(transport.register('test', 'code_dev', 'private')).rejects.toThrow();
    });

    it('sets Content-Type and Accept headers on all requests', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockAgent));

      await transport.register('test', 'code_dev', 'private');

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Accept']).toBe('application/json');
    });

    it('does not set X-Agent-Id when agentId param is not provided', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(mockAgent));

      // register() does not pass agentId to request()
      await transport.register('test', 'code_dev', 'private');

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['X-Agent-Id']).toBeUndefined();
    });

    it('does not include body for GET requests', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse([mockMessage]));

      await transport.poll('agent-1');

      const init = fetchMock.mock.calls[0][1];
      expect(init.body).toBeUndefined();
    });
  });
});
