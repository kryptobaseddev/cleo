/**
 * Tests for RuleBasedTruncationEngine — deterministic ContextEngine.
 *
 * @task T9312
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import { describe, expect, it } from 'vitest';
import {
  KEEP_TAIL,
  MIN_TRUNCATION_TOKENS,
  RuleBasedTruncationEngine,
  TRUNCATION_RATIO,
} from '../rule-based-truncation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(role: 'user' | 'assistant' | 'tool', chars: number): TransportMessage {
  return { role, content: 'x'.repeat(chars) };
}

/** Build an alternating user/assistant conversation of `count` pairs. */
function makeConversation(pairCount: number, charsPerMsg = 100): TransportMessage[] {
  const msgs: TransportMessage[] = [];
  for (let i = 0; i < pairCount; i++) {
    msgs.push(makeMessage('user', charsPerMsg));
    msgs.push(makeMessage('assistant', charsPerMsg));
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// shouldCompress
// ---------------------------------------------------------------------------

describe('RuleBasedTruncationEngine.shouldCompress', () => {
  const engine = new RuleBasedTruncationEngine();

  it('returns false below MIN_TRUNCATION_TOKENS threshold', () => {
    expect(engine.shouldCompress(MIN_TRUNCATION_TOKENS - 1, 100_000)).toBe(false);
  });

  it('returns false at MIN_TRUNCATION_TOKENS when ratio is below threshold', () => {
    // MIN_TRUNCATION_TOKENS / large budget = far below TRUNCATION_RATIO
    expect(engine.shouldCompress(MIN_TRUNCATION_TOKENS, 1_000_000)).toBe(false);
  });

  it('returns true when both conditions hold', () => {
    // ratio = 800/1000 = 0.8 >= TRUNCATION_RATIO (0.75), tokens >= MIN
    const budget = 1_000;
    const tokens = Math.ceil(budget * TRUNCATION_RATIO) + 1;
    expect(tokens).toBeGreaterThanOrEqual(MIN_TRUNCATION_TOKENS);
    expect(engine.shouldCompress(tokens, budget)).toBe(true);
  });

  it('returns false when ratio is exactly at threshold - 0.01', () => {
    const budget = 10_000;
    const tokens = Math.floor(budget * (TRUNCATION_RATIO - 0.01));
    expect(engine.shouldCompress(tokens, budget)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compress — basic contract
// ---------------------------------------------------------------------------

describe('RuleBasedTruncationEngine.compress — contract', () => {
  const engine = new RuleBasedTruncationEngine();

  it('returns beforeTokens > 0 for a non-empty history', async () => {
    const msgs = makeConversation(5);
    const result = await engine.compress(msgs);
    expect(result.beforeTokens).toBeGreaterThan(0);
  });

  it('afterTokens <= beforeTokens (compression never inflates)', async () => {
    const msgs = makeConversation(20, 300);
    const result = await engine.compress(msgs);
    expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens);
  });

  it('compressedMessages is a proper subset or equal of originals', async () => {
    const msgs = makeConversation(10, 200);
    const result = await engine.compress(msgs);
    expect(result.compressedMessages.length).toBeLessThanOrEqual(msgs.length);
  });

  it('returns original messages unchanged when history is already small', async () => {
    // A tiny conversation should pass through untouched.
    const msgs = makeConversation(2, 10);
    const result = await engine.compress(msgs);
    expect(result.compressedMessages).toHaveLength(msgs.length);
  });

  it('is deterministic — identical inputs produce identical output', async () => {
    const msgs = makeConversation(15, 200);
    const r1 = await engine.compress(msgs);
    const r2 = await engine.compress(msgs);
    expect(r1.compressedMessages).toEqual(r2.compressedMessages);
    expect(r1.beforeTokens).toBe(r2.beforeTokens);
    expect(r1.afterTokens).toBe(r2.afterTokens);
  });

  it('ignores focusTopic parameter (no-op, interface compat)', async () => {
    const msgs = makeConversation(5);
    const withTopic = await engine.compress(msgs, 'some-topic');
    const withoutTopic = await engine.compress(msgs);
    expect(withTopic.compressedMessages).toEqual(withoutTopic.compressedMessages);
  });
});

// ---------------------------------------------------------------------------
// compress — system message preservation
// ---------------------------------------------------------------------------

describe('RuleBasedTruncationEngine.compress — system message preservation', () => {
  const engine = new RuleBasedTruncationEngine();

  it('preserves leading tool (system) messages', async () => {
    const systemMsg = makeMessage('tool', 50);
    const convMsgs = makeConversation(20, 300);
    const msgs = [systemMsg, ...convMsgs];

    const result = await engine.compress(msgs);

    // The first message in the compressed output must still be the system message.
    expect(result.compressedMessages[0]).toEqual(systemMsg);
  });

  it('preserves multiple leading tool messages', async () => {
    const sys1 = makeMessage('tool', 40);
    const sys2 = makeMessage('tool', 40);
    const convMsgs = makeConversation(15, 300);
    const msgs = [sys1, sys2, ...convMsgs];

    const result = await engine.compress(msgs);

    expect(result.compressedMessages[0]).toEqual(sys1);
    expect(result.compressedMessages[1]).toEqual(sys2);
  });

  it('does not drop tool messages from the middle or tail', async () => {
    // A single tool message at the very end should survive (it falls in tail).
    const convMsgs = makeConversation(3, 50);
    const toolAtEnd = makeMessage('tool', 40);
    const msgs = [...convMsgs, toolAtEnd];

    const result = await engine.compress(msgs);

    // With so few messages, nothing should be dropped and the tool msg at end
    // should still be present.
    expect(result.compressedMessages).toContainEqual(toolAtEnd);
  });
});

// ---------------------------------------------------------------------------
// compress — tail preservation
// ---------------------------------------------------------------------------

describe('RuleBasedTruncationEngine.compress — tail preservation', () => {
  const engine = new RuleBasedTruncationEngine();

  it(`preserves the last ${KEEP_TAIL} messages under heavy truncation`, async () => {
    // Build a very large history so truncation is aggressive.
    const msgs = makeConversation(30, 500);
    const expectedTail = msgs.slice(-KEEP_TAIL);

    const result = await engine.compress(msgs);

    const compressed = result.compressedMessages;
    const actualTail = compressed.slice(-KEEP_TAIL);

    expect(actualTail).toEqual(expectedTail);
  });

  it('does not drop messages below KEEP_TAIL total length', async () => {
    // When the conversation is exactly KEEP_TAIL messages, nothing is dropped.
    const msgs = makeConversation(Math.floor(KEEP_TAIL / 2), 50);
    const result = await engine.compress(msgs);
    expect(result.compressedMessages).toHaveLength(msgs.length);
  });
});

// ---------------------------------------------------------------------------
// compress — edge cases
// ---------------------------------------------------------------------------

describe('RuleBasedTruncationEngine.compress — edge cases', () => {
  const engine = new RuleBasedTruncationEngine();

  it('handles empty message array gracefully', async () => {
    const result = await engine.compress([]);
    expect(result.compressedMessages).toEqual([]);
    expect(result.beforeTokens).toBe(0);
    expect(result.afterTokens).toBe(0);
  });

  it('handles single message gracefully', async () => {
    const msg = makeMessage('user', 20);
    const result = await engine.compress([msg]);
    expect(result.compressedMessages).toHaveLength(1);
  });

  it('never increases token count', async () => {
    for (const pairCount of [1, 5, 10, 20]) {
      const msgs = makeConversation(pairCount, 200);
      const result = await engine.compress(msgs);
      expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens);
    }
  });
});
