/**
 * Tests for LlmSummarizationEngine — default ContextEngine implementation.
 *
 * @task T9304
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetLlmExecutor } = vi.hoisted(() => ({
  mockGetLlmExecutor: vi.fn(),
}));

vi.mock('../../../llm/executor-factory.js', () => ({
  getLlmExecutor: mockGetLlmExecutor,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import {
  LlmSummarizationEngine,
  MIN_SUMMARY_TOKENS,
  SUMMARY_TOKENS_CEILING,
} from '../llm-summarizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number, contentLength = 100): TransportMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `${'x'.repeat(contentLength)} message-${i}`,
  }));
}

const LARGE_CONTENT_LENGTH = 400; // 400 chars * 10 msgs = 4000 chars ≈ 1000 tokens

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// shouldCompress
// ---------------------------------------------------------------------------

describe('LlmSummarizationEngine.shouldCompress', () => {
  const engine = new LlmSummarizationEngine();

  it('returns false below MIN_SUMMARY_TOKENS threshold', () => {
    // MIN_SUMMARY_TOKENS = 2000, so 1999 tokens always returns false.
    expect(engine.shouldCompress(MIN_SUMMARY_TOKENS - 1, 100_000)).toBe(false);
  });

  it('returns false when ratio is below 0.75 (even above MIN_SUMMARY_TOKENS)', () => {
    // 2001 / 100000 = 0.02 — well below 0.75
    expect(engine.shouldCompress(MIN_SUMMARY_TOKENS + 1, 100_000)).toBe(false);
  });

  it('returns true above 75% threshold when above MIN_SUMMARY_TOKENS', () => {
    // 76000 / 100000 = 0.76 and 76000 > 2000
    expect(engine.shouldCompress(76_000, 100_000)).toBe(true);
  });

  it('returns true exactly at 75% boundary (>= threshold)', () => {
    // 75000 / 100000 = 0.75 — exactly at the >= 0.75 threshold
    expect(engine.shouldCompress(75_000, 100_000)).toBe(true);
  });

  it('returns false just below 75% boundary', () => {
    // 74999 / 100000 = 0.74999 — just below the threshold
    expect(engine.shouldCompress(74_999, 100_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

describe('LlmSummarizationEngine.compress', () => {
  it('emits SUMMARY_PREFIX in output', async () => {
    const mockExecutor = {
      auxiliary: vi.fn().mockResolvedValue({
        id: 'mock-response',
        model: 'claude-haiku-4-5',
        content: 'This is the summary of the conversation.',
        toolCalls: null,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        raw: null,
      }),
    };
    mockGetLlmExecutor.mockResolvedValue(mockExecutor);

    const engine = new LlmSummarizationEngine();
    // Need enough messages to exceed KEEP_FIRST (3) + KEEP_LAST (6) = 9
    // Use 15 messages with large content to ensure summarization happens.
    const messages = makeMessages(15, LARGE_CONTENT_LENGTH);
    const result = await engine.compress(messages);

    // The summary is inserted at index KEEP_FIRST (3), with role 'assistant'
    // and content starting with SUMMARY_PREFIX.
    const summaryMsg = result.compressedMessages[3];
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.role).toBe('assistant');
    expect(typeof summaryMsg!.content).toBe('string');
    expect(summaryMsg!.content as string).toContain('## Conversation Summary');
  });

  it('preserves first 3 + last 6 messages verbatim', async () => {
    const mockExecutor = {
      auxiliary: vi.fn().mockResolvedValue({
        id: 'mock',
        model: 'haiku',
        content: 'summary text',
        toolCalls: null,
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 10 },
        raw: null,
      }),
    };
    mockGetLlmExecutor.mockResolvedValue(mockExecutor);

    const engine = new LlmSummarizationEngine();
    const messages = makeMessages(15, LARGE_CONTENT_LENGTH);

    const result = await engine.compress(messages);

    // First 3 messages preserved verbatim at the start
    expect(result.compressedMessages[0]).toEqual(messages[0]);
    expect(result.compressedMessages[1]).toEqual(messages[1]);
    expect(result.compressedMessages[2]).toEqual(messages[2]);

    // Last 6 messages preserved verbatim at the end
    const last6 = messages.slice(messages.length - 6);
    const resultTail = result.compressedMessages.slice(result.compressedMessages.length - 6);
    expect(resultTail).toEqual(last6);
  });

  it('emits beforeTokens > afterTokens', async () => {
    const mockExecutor = {
      auxiliary: vi.fn().mockResolvedValue({
        id: 'mock',
        model: 'haiku',
        content: 'short summary',
        toolCalls: null,
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 5 },
        raw: null,
      }),
    };
    mockGetLlmExecutor.mockResolvedValue(mockExecutor);

    const engine = new LlmSummarizationEngine();
    // 20 messages × 400 chars = 8000 chars ≈ 2000 tokens — should compress
    const messages = makeMessages(20, LARGE_CONTENT_LENGTH);

    const result = await engine.compress(messages);

    expect(result.beforeTokens).toBeGreaterThan(0);
    expect(result.afterTokens).toBeGreaterThan(0);
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens);
  });

  it('returns unchanged messages when history fits in KEEP_FIRST + KEEP_LAST window', async () => {
    const engine = new LlmSummarizationEngine();
    // 9 messages ≤ 3 + 6 = 9 — no summarization needed
    const messages = makeMessages(9, 50);

    const result = await engine.compress(messages);

    expect(result.compressedMessages).toEqual(messages);
    expect(result.beforeTokens).toBe(result.afterTokens);
    expect(mockGetLlmExecutor).not.toHaveBeenCalled();
  });

  it('falls back gracefully when LLM call throws', async () => {
    mockGetLlmExecutor.mockRejectedValue(new Error('network error'));

    const engine = new LlmSummarizationEngine();
    const messages = makeMessages(12, LARGE_CONTENT_LENGTH);

    const result = await engine.compress(messages);

    // Should still return a valid CompressedContext even on LLM failure
    expect(result.compressedMessages.length).toBeGreaterThan(0);
    expect(result.beforeTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SUMMARY_TOKENS_CEILING is exported (constant sanity check)
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('SUMMARY_TOKENS_CEILING is 12000', () => {
    expect(SUMMARY_TOKENS_CEILING).toBe(12_000);
  });

  it('MIN_SUMMARY_TOKENS is 2000', () => {
    expect(MIN_SUMMARY_TOKENS).toBe(2_000);
  });
});
