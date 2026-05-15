/**
 * Unit tests for `injectCacheBreakpoints` and `AnthropicBackend` prompt-caching
 * wiring.
 *
 * Coverage:
 * 1. `system_and_3` on a 5-message conversation: system + last 3 user messages
 *    get ttl 300; earlier user message is NOT marked.
 * 2. `system_and_3` with string content auto-converts to block array.
 * 3. `prefix_and_2`: first system block at ttl 3600; last 2 user messages at
 *    ttl 300.
 * 4. `none` strategy: no cache_control fields added.
 * 5. `system_and_3` with no system array: only user messages marked.
 * 6. `AnthropicBackend.complete` with mocked SDK verifies breakpoints are
 *    applied for each strategy variant.
 *
 * @task T9269
 * @epic T9261
 */

// Shared hoisted spy so all AnthropicTransport instances share the same create mock.
const { sharedMockCreate } = vi.hoisted(() => ({ sharedMockCreate: vi.fn() }));

// Mock @anthropic-ai/sdk before any module that imports it is loaded.
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: sharedMockCreate,
      stream: vi.fn(),
    };
  }
  return { default: MockAnthropic, Anthropic: MockAnthropic };
});

// Also mock jsonrepair (imported by structured-output.ts which is transitively
// pulled in by backends/anthropic.ts).
vi.mock('jsonrepair', () => ({
  jsonrepair: (s: string) => s,
}));

import { describe, expect, it, vi } from 'vitest';
import type { AnthropicKwargs } from '../prompt-caching.js';
import { injectCacheBreakpoints } from '../prompt-caching.js';
import { AnthropicTransport } from '../transports/anthropic.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AnthropicKwargs with one optional system block and N messages. */
function makeKwargs(systemText: string | null, userMessages: string[]): AnthropicKwargs {
  const messages = userMessages.map((text, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: text,
  }));
  if (systemText !== null) {
    return {
      system: [{ type: 'text', text: systemText }],
      messages,
    };
  }
  return { messages };
}

/** Extract `cache_control` from the last block of a message's content. */
function lastBlockCacheControl(
  msg: AnthropicKwargs['messages'][number],
): Record<string, unknown> | undefined {
  if (typeof msg.content === 'string') return undefined;
  const blocks = msg.content as Array<Record<string, unknown>>;
  const last = blocks[blocks.length - 1];
  return last?.['cache_control'] as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// injectCacheBreakpoints — system_and_3
// ---------------------------------------------------------------------------

describe('injectCacheBreakpoints — system_and_3', () => {
  it('marks every system block with ttl 300', () => {
    const kwargs = makeKwargs('You are a helpful assistant.', ['u1', 'u2']);
    injectCacheBreakpoints(kwargs, 'system_and_3');

    expect(kwargs.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: 300 });
  });

  it('marks last 3 user messages with ttl 300 in a 5-message conversation', () => {
    // 5 user messages: u1 (oldest) … u5 (newest)
    const kwargs: AnthropicKwargs = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'user', content: 'u3' },
        { role: 'user', content: 'u4' },
        { role: 'user', content: 'u5' },
      ],
    };

    injectCacheBreakpoints(kwargs, 'system_and_3');

    // u1 and u2 must NOT be marked (they're the first two, beyond the window)
    expect(lastBlockCacheControl(kwargs.messages[0]!)).toBeUndefined();
    expect(lastBlockCacheControl(kwargs.messages[1]!)).toBeUndefined();

    // u3, u4, u5 must be marked
    expect(lastBlockCacheControl(kwargs.messages[2]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    expect(lastBlockCacheControl(kwargs.messages[3]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    expect(lastBlockCacheControl(kwargs.messages[4]!)).toEqual({ type: 'ephemeral', ttl: 300 });
  });

  it('auto-converts string content to block array when marking user messages', () => {
    const kwargs: AnthropicKwargs = {
      messages: [{ role: 'user', content: 'plain string message' }],
    };

    injectCacheBreakpoints(kwargs, 'system_and_3');

    // content should now be an array
    expect(Array.isArray(kwargs.messages[0]!.content)).toBe(true);
    const blocks = kwargs.messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.['type']).toBe('text');
    expect(blocks[0]?.['text']).toBe('plain string message');
    expect(blocks[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: 300 });
  });

  it('handles missing system gracefully — only user messages marked', () => {
    const kwargs: AnthropicKwargs = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    };

    injectCacheBreakpoints(kwargs, 'system_and_3');

    // No system — no error, no system property added
    expect(kwargs.system).toBeUndefined();

    // Both user messages are within the last-3 window — both marked
    expect(lastBlockCacheControl(kwargs.messages[0]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    expect(lastBlockCacheControl(kwargs.messages[1]!)).toEqual({ type: 'ephemeral', ttl: 300 });
  });

  it('skips assistant messages when counting user-message window', () => {
    const kwargs: AnthropicKwargs = {
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
        { role: 'user', content: 'u4' },
      ],
    };

    injectCacheBreakpoints(kwargs, 'system_and_3');

    // u1 is the 4th user message from the end — outside the window of 3
    expect(lastBlockCacheControl(kwargs.messages[0]!)).toBeUndefined();
    // u2, u3, u4 are last 3 user messages — all marked
    expect(lastBlockCacheControl(kwargs.messages[2]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    expect(lastBlockCacheControl(kwargs.messages[4]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    expect(lastBlockCacheControl(kwargs.messages[6]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    // Assistant messages must never be marked
    expect(lastBlockCacheControl(kwargs.messages[1]!)).toBeUndefined();
    expect(lastBlockCacheControl(kwargs.messages[3]!)).toBeUndefined();
    expect(lastBlockCacheControl(kwargs.messages[5]!)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// injectCacheBreakpoints — prefix_and_2
// ---------------------------------------------------------------------------

describe('injectCacheBreakpoints — prefix_and_2', () => {
  it('marks first system block with ttl 3600 (long-cache prefix)', () => {
    const kwargs: AnthropicKwargs = {
      system: [
        { type: 'text', text: 'stable prefix' },
        { type: 'text', text: 'dynamic part' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    };

    injectCacheBreakpoints(kwargs, 'prefix_and_2');

    // Only the first system block gets the 1-hour marker
    expect(kwargs.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: 3600 });
    // Second system block must NOT be marked
    expect(kwargs.system?.[1]?.cache_control).toBeUndefined();
  });

  it('marks last 2 user messages with ttl 300 (rolling window)', () => {
    const kwargs: AnthropicKwargs = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'user', content: 'u3' },
      ],
    };

    injectCacheBreakpoints(kwargs, 'prefix_and_2');

    // u1 is outside the 2-message rolling window
    expect(lastBlockCacheControl(kwargs.messages[0]!)).toBeUndefined();
    // u2 and u3 are the last 2 user messages — marked at ttl 300
    expect(lastBlockCacheControl(kwargs.messages[1]!)).toEqual({ type: 'ephemeral', ttl: 300 });
    expect(lastBlockCacheControl(kwargs.messages[2]!)).toEqual({ type: 'ephemeral', ttl: 300 });
  });
});

// ---------------------------------------------------------------------------
// injectCacheBreakpoints — none
// ---------------------------------------------------------------------------

describe('injectCacheBreakpoints — none', () => {
  it('returns kwargs unchanged with no cache_control fields', () => {
    const kwargs: AnthropicKwargs = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
    };

    const result = injectCacheBreakpoints(kwargs, 'none');

    // Same reference returned
    expect(result).toBe(kwargs);
    // No cache_control anywhere
    expect(kwargs.system?.[0]?.cache_control).toBeUndefined();
    expect(lastBlockCacheControl(kwargs.messages[0]!)).toBeUndefined();
    expect(lastBlockCacheControl(kwargs.messages[1]!)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AnthropicTransport.complete — prompt-caching wiring (migrated from AnthropicBackend W1c T9285)
// ---------------------------------------------------------------------------

// sharedMockCreate is declared at the top of this file via vi.hoisted().

const MOCK_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  model: 'claude-sonnet-4-6',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

describe('AnthropicTransport.complete — prompt-caching wiring', () => {
  it('applies system_and_3 breakpoints when promptCaching is system_and_3', async () => {
    sharedMockCreate.mockResolvedValue(MOCK_RESPONSE);
    const transport = new AnthropicTransport({ apiKey: 'test', promptCaching: 'system_and_3' });

    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello!' }],
      system: 'You are helpful.',
      maxTokens: 100,
    });

    const callArgs = sharedMockCreate.mock.calls[0]?.[0] as Record<string, unknown>;

    // System block should have cache_control with ttl 300
    const systemBlocks = callArgs['system'] as Array<Record<string, unknown>>;
    expect(systemBlocks).toBeDefined();
    expect(systemBlocks[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: 300 });

    // User message block should have cache_control with ttl 300
    const msgs = callArgs['messages'] as Array<{ role: string; content: unknown }>;
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const userBlocks = userMsg?.content as Array<Record<string, unknown>>;
    const lastBlock = userBlocks[userBlocks.length - 1];
    expect(lastBlock?.['cache_control']).toEqual({ type: 'ephemeral', ttl: 300 });
  });

  it('applies no breakpoints when promptCaching is none', async () => {
    sharedMockCreate.mockClear();
    sharedMockCreate.mockResolvedValue(MOCK_RESPONSE);
    const transport = new AnthropicTransport({ apiKey: 'test', promptCaching: 'none' });

    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello!' }],
      system: 'You are helpful.',
      maxTokens: 100,
    });

    const callArgs = sharedMockCreate.mock.calls[0]?.[0] as Record<string, unknown>;

    // System block must NOT have cache_control when strategy is 'none'
    const systemBlocks = callArgs['system'] as Array<Record<string, unknown>>;
    expect(systemBlocks[0]?.['cache_control']).toBeUndefined();
  });

  it('defaults to system_and_3 when promptCaching is omitted', async () => {
    sharedMockCreate.mockClear();
    sharedMockCreate.mockResolvedValue(MOCK_RESPONSE);
    // No promptCaching option — should default to system_and_3
    const transport = new AnthropicTransport({ apiKey: 'test' });

    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello!' }],
      system: 'You are helpful.',
      maxTokens: 100,
    });

    const callArgs = sharedMockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const systemBlocks = callArgs['system'] as Array<Record<string, unknown>>;
    expect(systemBlocks[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: 300 });
  });

  it('applies prefix_and_2 breakpoints: first system at 3600, users at 300', async () => {
    sharedMockCreate.mockClear();
    sharedMockCreate.mockResolvedValue(MOCK_RESPONSE);
    const transport = new AnthropicTransport({ apiKey: 'test', promptCaching: 'prefix_and_2' });

    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'Turn 1' },
        { role: 'user', content: 'Turn 2' },
      ],
      system: 'Stable system prefix.',
      maxTokens: 100,
    });

    const callArgs = sharedMockCreate.mock.calls[0]?.[0] as Record<string, unknown>;

    // First system block: long TTL
    const systemBlocks = callArgs['system'] as Array<Record<string, unknown>>;
    expect(systemBlocks[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: 3600 });

    // Both user messages in rolling window: short TTL
    const msgs = callArgs['messages'] as Array<{ role: string; content: unknown }>;
    for (const msg of msgs) {
      if (msg.role !== 'user') continue;
      const blocks = msg.content as Array<Record<string, unknown>>;
      expect(blocks[blocks.length - 1]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: 300 });
    }
  });
});
