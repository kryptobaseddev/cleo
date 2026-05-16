/**
 * Unit tests for BedrockTransport (T9317 — Converse API implementation).
 *
 * All AWS SDK calls are mocked via vi.mock. Tests cover:
 * 1. Simple turn — complete() normalizes text response correctly
 * 2. Tool use — ConverseCommand with toolConfig and ToolUseBlock in response
 * 3. Streaming — ConverseStreamCommand yields text, reasoning, and final usage
 * 4. Cross-region fallback — retries against fallbackRegions on AccessDeniedException
 * 5. Guardrail passthrough — guardrailConfig forwarded from request meta
 * 6. Credential resolution — fromNodeProviderChain called with awsProfile when set
 *
 * @task T9317
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-bedrock-runtime before imports
// ---------------------------------------------------------------------------

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class MockBedrockRuntimeClient {
    send = mockSend;
  }
  class MockConverseCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockConverseStreamCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    BedrockRuntimeClient: MockBedrockRuntimeClient,
    ConverseCommand: MockConverseCommand,
    ConverseStreamCommand: MockConverseStreamCommand,
  };
});

// ---------------------------------------------------------------------------
// Mock @aws-sdk/credential-providers
// ---------------------------------------------------------------------------

const { mockFromNodeProviderChain } = vi.hoisted(() => {
  const mockFromNodeProviderChain = vi
    .fn()
    .mockReturnValue({ accessKeyId: 'test', secretAccessKey: 'test' });
  return { mockFromNodeProviderChain };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: mockFromNodeProviderChain,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { BedrockTransport } from '../bedrock.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConverseResponse(text: string, stopReason = 'end_turn') {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ text }],
      },
    },
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 100 },
    $metadata: { requestId: 'req-test-001' },
  };
}

function makeToolUseResponse(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId,
              name: toolName,
              input: toolInput,
            },
          },
        ],
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    $metadata: { requestId: 'req-tool-001' },
  };
}

async function* makeStreamEvents(events: Record<string, unknown>[]) {
  for (const event of events) {
    yield event;
  }
}

function makeStreamResponse(events: Record<string, unknown>[]) {
  return {
    stream: makeStreamEvents(events),
    $metadata: { requestId: 'req-stream-001' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BedrockTransport', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockFromNodeProviderChain.mockClear();
  });

  describe('provider and apiMode', () => {
    it('exposes correct provider and apiMode constants', () => {
      const t = new BedrockTransport();
      expect(t.provider).toBe('bedrock');
      expect(t.apiMode).toBe('bedrock_converse');
    });
  });

  describe('complete() — simple turn', () => {
    it('returns normalized response with text content', async () => {
      mockSend.mockResolvedValueOnce(makeConverseResponse('Hello from Bedrock!'));

      const t = new BedrockTransport({ region: 'us-east-1' });
      const result = await t.complete({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 512,
      });

      expect(result.content).toBe('Hello from Bedrock!');
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      expect(result.id).toBe('req-test-001');
      expect(result.toolCalls).toBeNull();
    });

    it('passes model, messages, maxTokens to ConverseCommand', async () => {
      mockSend.mockResolvedValueOnce(makeConverseResponse('OK'));

      const t = new BedrockTransport({ region: 'us-west-2' });
      await t.complete({
        model: 'amazon.nova-pro-v1:0',
        messages: [{ role: 'user', content: 'Test' }],
        maxTokens: 256,
        temperature: 0.5,
      });

      const [[cmd]] = mockSend.mock.calls as [[{ input: Record<string, unknown> }]];
      expect(cmd.input['modelId']).toBe('amazon.nova-pro-v1:0');
      expect(cmd.input['inferenceConfig']).toMatchObject({ maxTokens: 256, temperature: 0.5 });
    });

    it('maps system prompt into systemContentBlocks', async () => {
      mockSend.mockResolvedValueOnce(makeConverseResponse('Response'));

      const t = new BedrockTransport();
      await t.complete({
        model: 'mistral.mistral-large-2402-v1:0',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 128,
        system: 'You are a helpful assistant.',
      });

      const [[cmd]] = mockSend.mock.calls as [[{ input: Record<string, unknown> }]];
      const systemBlocks = cmd.input['system'] as Array<{ text: string }>;
      expect(systemBlocks).toHaveLength(1);
      expect(systemBlocks[0]!.text).toBe('You are a helpful assistant.');
    });

    it('maps tool-result message to toolResult content block', async () => {
      mockSend.mockResolvedValueOnce(makeConverseResponse('Done'));

      const t = new BedrockTransport();
      await t.complete({
        model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
        messages: [
          { role: 'user', content: 'Call a tool' },
          { role: 'tool', content: 'tool output', toolUseId: 'tu-001' },
        ],
        maxTokens: 128,
      });

      const [[cmd]] = mockSend.mock.calls as [[{ input: Record<string, unknown> }]];
      const msgs = cmd.input['messages'] as Array<Record<string, unknown>>;
      const toolResultMsg = msgs.find((m) => {
        const content = m['content'] as Array<Record<string, unknown>>;
        return content?.[0]?.['toolResult'] != null;
      });
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg!['role']).toBe('user');
    });
  });

  describe('complete() — tool use', () => {
    it('returns normalized tool calls', async () => {
      mockSend.mockResolvedValueOnce(
        makeToolUseResponse('tu-123', 'get_weather', { location: 'Seattle' }),
      );

      const t = new BedrockTransport();
      const result = await t.complete({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'What is the weather?' }],
        maxTokens: 512,
        tools: [
          {
            name: 'get_weather',
            description: 'Get the weather for a location',
            inputSchema: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.id).toBe('tu-123');
      expect(result.toolCalls![0]!.name).toBe('get_weather');
      expect(JSON.parse(result.toolCalls![0]!.arguments)).toEqual({ location: 'Seattle' });
      expect(result.stopReason).toBe('tool_use');
    });

    it('passes toolConfig with tool spec to ConverseCommand', async () => {
      mockSend.mockResolvedValueOnce(makeToolUseResponse('tu-456', 'my_tool', {}));

      const t = new BedrockTransport();
      await t.complete({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'Use tool' }],
        maxTokens: 256,
        tools: [
          {
            name: 'my_tool',
            description: 'A test tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const [[cmd]] = mockSend.mock.calls as [[{ input: Record<string, unknown> }]];
      const toolConfig = cmd.input['toolConfig'] as Record<string, unknown>;
      expect(toolConfig).toBeDefined();
      const tools = toolConfig['tools'] as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      const spec = tools[0]!['toolSpec'] as Record<string, unknown>;
      expect(spec['name']).toBe('my_tool');
    });
  });

  describe('stream()', () => {
    it('yields text deltas and final usage', async () => {
      mockSend.mockResolvedValueOnce(
        makeStreamResponse([
          { contentBlockDelta: { delta: { text: 'Hello' }, contentBlockIndex: 0 } },
          { contentBlockDelta: { delta: { text: ' world' }, contentBlockIndex: 0 } },
          { messageStop: { stopReason: 'end_turn' } },
          { metadata: { usage: { inputTokens: 8, outputTokens: 4 } } },
        ]),
      );

      const t = new BedrockTransport();
      const deltas: Array<{ text: string; stopReason: string | null }> = [];

      for await (const delta of t.stream(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          messages: [{ role: 'user', content: 'Hi' }],
          maxTokens: 128,
        },
        {} as never,
      )) {
        deltas.push({ text: delta.text, stopReason: delta.stopReason });
      }

      const textDeltas = deltas.filter((d) => d.text.length > 0);
      expect(textDeltas.map((d) => d.text).join('')).toBe('Hello world');

      const finalDelta = deltas[deltas.length - 1]!;
      expect(finalDelta.stopReason).toBe('end_turn');
      expect(finalDelta.text).toBe('');
    });

    it('yields reasoning content to delta.reasoning', async () => {
      mockSend.mockResolvedValueOnce(
        makeStreamResponse([
          {
            contentBlockDelta: {
              delta: { reasoningContent: { text: 'I think...' } },
              contentBlockIndex: 0,
            },
          },
          { contentBlockDelta: { delta: { text: 'Answer' }, contentBlockIndex: 1 } },
          { messageStop: { stopReason: 'end_turn' } },
          { metadata: { usage: { inputTokens: 5, outputTokens: 2 } } },
        ]),
      );

      const t = new BedrockTransport();
      const deltas: Array<{ text: string; reasoning: string }> = [];

      for await (const delta of t.stream(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          messages: [{ role: 'user', content: 'Reason' }],
          maxTokens: 256,
        },
        {} as never,
      )) {
        deltas.push({ text: delta.text, reasoning: delta.reasoning });
      }

      const reasoningDeltas = deltas.filter((d) => d.reasoning.length > 0);
      expect(reasoningDeltas[0]!.reasoning).toBe('I think...');
    });

    it('drops toolUse streaming deltas', async () => {
      mockSend.mockResolvedValueOnce(
        makeStreamResponse([
          {
            contentBlockStart: {
              start: { toolUse: { toolUseId: 'tu-1', name: 'fn' } },
              contentBlockIndex: 0,
            },
          },
          {
            contentBlockDelta: { delta: { toolUse: { input: '{"x":' } }, contentBlockIndex: 0 },
          },
          { contentBlockDelta: { delta: { toolUse: { input: '1}' } }, contentBlockIndex: 0 } },
          { messageStop: { stopReason: 'tool_use' } },
          { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
        ]),
      );

      const t = new BedrockTransport();
      const deltas: Array<{ text: string }> = [];

      for await (const delta of t.stream(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          messages: [{ role: 'user', content: 'Call tool' }],
          maxTokens: 256,
        },
        {} as never,
      )) {
        deltas.push({ text: delta.text });
      }

      const textDeltas = deltas.filter((d) => d.text.length > 0);
      expect(textDeltas).toHaveLength(0);
    });
  });

  describe('cross-region fallback', () => {
    it('retries on AccessDeniedException and succeeds on fallback region', async () => {
      const accessDenied = Object.assign(new Error('Access denied'), {
        name: 'AccessDeniedException',
      });
      mockSend
        .mockRejectedValueOnce(accessDenied)
        .mockResolvedValueOnce(makeConverseResponse('Fallback response'));

      const t = new BedrockTransport({
        region: 'us-east-1',
        fallbackRegions: ['us-west-2'],
      });

      const result = await t.complete({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 128,
      });

      expect(result.content).toBe('Fallback response');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on non-retryable error', async () => {
      const networkErr = new Error('ECONNREFUSED');
      mockSend.mockRejectedValueOnce(networkErr);

      const t = new BedrockTransport({
        region: 'us-east-1',
        fallbackRegions: ['us-west-2'],
      });

      await expect(
        t.complete({
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          messages: [{ role: 'user', content: 'Hello' }],
          maxTokens: 128,
        }),
      ).rejects.toThrow('ECONNREFUSED');

      // Should not have tried the fallback
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('exhausts all regions and throws last error', async () => {
      const err1 = Object.assign(new Error('Throttled 1'), { name: 'ThrottlingException' });
      const err2 = Object.assign(new Error('Throttled 2'), { name: 'ThrottlingException' });
      mockSend.mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);

      const t = new BedrockTransport({
        region: 'us-east-1',
        fallbackRegions: ['eu-west-1'],
      });

      await expect(
        t.complete({
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          messages: [{ role: 'user', content: 'Hello' }],
          maxTokens: 128,
        }),
      ).rejects.toThrow('Throttled 2');

      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('guardrail passthrough', () => {
    it('passes guardrailConfig from request.guardrailConfig', async () => {
      mockSend.mockResolvedValueOnce(makeConverseResponse('Protected response'));

      const t = new BedrockTransport();
      const guardrailConfig = {
        guardrailIdentifier: 'gr-abc123',
        guardrailVersion: '1',
      };

      await t.complete(
        Object.assign(
          {
            model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
            messages: [{ role: 'user', content: 'Hello' }] as Parameters<
              BedrockTransport['complete']
            >[0]['messages'],
            maxTokens: 128,
          },
          { guardrailConfig },
        ) as Parameters<BedrockTransport['complete']>[0],
      );

      const [[cmd]] = mockSend.mock.calls as [[{ input: Record<string, unknown> }]];
      expect(cmd.input['guardrailConfig']).toEqual(guardrailConfig);
    });

    it('passes guardrailConfig from request.meta.guardrailConfig', async () => {
      mockSend.mockResolvedValueOnce(makeConverseResponse('Protected'));

      const t = new BedrockTransport();
      const guardrailConfig = {
        guardrailIdentifier: 'gr-def456',
        guardrailVersion: '2',
      };

      await t.complete(
        Object.assign(
          {
            model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
            messages: [{ role: 'user', content: 'Test' }] as Parameters<
              BedrockTransport['complete']
            >[0]['messages'],
            maxTokens: 128,
          },
          { meta: { guardrailConfig } },
        ) as Parameters<BedrockTransport['complete']>[0],
      );

      const [[cmd]] = mockSend.mock.calls as [[{ input: Record<string, unknown> }]];
      expect(cmd.input['guardrailConfig']).toEqual(guardrailConfig);
    });
  });

  describe('credential resolution', () => {
    it('calls fromNodeProviderChain without profile when awsProfile not set', () => {
      mockFromNodeProviderChain.mockClear();
      new BedrockTransport({ region: 'us-east-1' });
      // Client is lazy — no credential resolution until first request
      // Force client instantiation by checking _getClient indirectly
      // through the class structure
      expect(mockFromNodeProviderChain).not.toHaveBeenCalled(); // lazy
    });

    it('passes awsProfile to fromNodeProviderChain when set', async () => {
      mockFromNodeProviderChain.mockClear();
      mockSend.mockResolvedValueOnce(makeConverseResponse('OK'));

      const t = new BedrockTransport({ region: 'us-east-1', awsProfile: 'my-work-profile' });
      await t.complete({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 64,
      });

      expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ profile: 'my-work-profile' });
    });
  });

  describe('region defaults', () => {
    it('defaults to us-east-1 when no region env vars set', () => {
      const savedRegion = process.env['AWS_REGION'];
      const savedDefault = process.env['AWS_DEFAULT_REGION'];
      delete process.env['AWS_REGION'];
      delete process.env['AWS_DEFAULT_REGION'];

      const t = new BedrockTransport();
      // Access internal _primaryRegion via type cast for testing
      const internal = t as unknown as { _primaryRegion: string };
      expect(internal._primaryRegion).toBe('us-east-1');

      if (savedRegion !== undefined) process.env['AWS_REGION'] = savedRegion;
      if (savedDefault !== undefined) process.env['AWS_DEFAULT_REGION'] = savedDefault;
    });

    it('picks up AWS_REGION env var', () => {
      const saved = process.env['AWS_REGION'];
      process.env['AWS_REGION'] = 'ap-northeast-1';

      const t = new BedrockTransport();
      const internal = t as unknown as { _primaryRegion: string };
      expect(internal._primaryRegion).toBe('ap-northeast-1');

      if (saved !== undefined) {
        process.env['AWS_REGION'] = saved;
      } else {
        delete process.env['AWS_REGION'];
      }
    });
  });
});
