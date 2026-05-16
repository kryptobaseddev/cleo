/**
 * Unit tests for `cleo llm stream` — `runLlmStream` core logic.
 *
 * Uses a mocked LlmSession that emits a scripted sequence of NormalizedDelta
 * chunks. Verifies:
 *   - Text deltas are written to stdout incrementally.
 *   - Reasoning blocks are written to stderr only when showThink is true.
 *   - Final usage JSON is written to stderr.
 *   - No text appears on stdout when all deltas are think-only.
 *
 * No network or filesystem I/O is performed.
 *
 * @task T9315
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLlmStream } from '../llm-stream.js';

// ---------------------------------------------------------------------------
// Helpers — in-memory writable stream that captures written strings
// ---------------------------------------------------------------------------

class CapturingStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get output(): string {
    return this.chunks.join('');
  }
}

// ---------------------------------------------------------------------------
// Delta type — mirrors NormalizedDelta from contracts
// ---------------------------------------------------------------------------

interface MockDelta {
  text: string;
  reasoning: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

// ---------------------------------------------------------------------------
// Mock session factory
// ---------------------------------------------------------------------------

function makeMockSession(deltas: MockDelta[]) {
  async function* streamGen() {
    for (const d of deltas) {
      yield d;
    }
  }

  return {
    transport: {},
    model: 'test-model-v1',
    history: () => [],
    append: vi.fn(),
    truncateHistory: vi.fn(),
    send: vi.fn(),
    stream: (_messages: unknown, _opts?: unknown) => streamGen(),
    refreshCredential: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/** A stream that emits text deltas followed by a final usage delta. */
const SIMPLE_TEXT_DELTAS: MockDelta[] = [
  { text: 'Hello', reasoning: '', stopReason: null, usage: null },
  { text: ', world', reasoning: '', stopReason: null, usage: null },
  { text: '!', reasoning: '', stopReason: null, usage: null },
  {
    text: '',
    reasoning: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  },
];

/** A stream that interleaves reasoning blocks with text. */
const THINK_DELTAS: MockDelta[] = [
  { text: '', reasoning: 'I should think first...', stopReason: null, usage: null },
  { text: 'The answer is 42.', reasoning: '', stopReason: null, usage: null },
  {
    text: '',
    reasoning: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 20, outputTokens: 8 },
  },
];

/** A stream with only reasoning blocks and no text. */
const THINK_ONLY_DELTAS: MockDelta[] = [
  { text: '', reasoning: 'Thinking hard...', stopReason: null, usage: null },
  {
    text: '',
    reasoning: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 1 },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLlmStream — text delta routing', () => {
  let stdout: CapturingStream;
  let stderr: CapturingStream;

  beforeEach(() => {
    stdout = new CapturingStream();
    stderr = new CapturingStream();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes text deltas to stdout incrementally', async () => {
    const session = makeMockSession(SIMPLE_TEXT_DELTAS);

    await runLlmStream({
      provider: 'anthropic',
      prompt: 'Say hello',
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    expect(stdout.output).toBe('Hello, world!');
    // Each text delta should have been written as a separate write call
    expect(stdout.chunks).toEqual(['Hello', ', world', '!']);
  });

  it('writes usage JSON to stderr as a single line', async () => {
    const session = makeMockSession(SIMPLE_TEXT_DELTAS);

    await runLlmStream({
      provider: 'anthropic',
      prompt: 'Say hello',
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    const stderrOut = stderr.output;
    // Should contain a JSON line ending with newline
    expect(stderrOut).toMatch(/\{.*\}\n$/);
    const parsed = JSON.parse(stderrOut.trim()) as Record<string, unknown>;
    expect(parsed['inputTokens']).toBe(10);
    expect(parsed['outputTokens']).toBe(5);
    // costUsd may be null (model not in pricing table) or a number — both valid
    expect(parsed).toHaveProperty('costUsd');
  });

  it('returns the usage summary object', async () => {
    const session = makeMockSession(SIMPLE_TEXT_DELTAS);

    const usage = await runLlmStream({
      provider: 'anthropic',
      prompt: 'Say hello',
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
  });
});

describe('runLlmStream — reasoning/think routing', () => {
  let stdout: CapturingStream;
  let stderr: CapturingStream;

  beforeEach(() => {
    stdout = new CapturingStream();
    stderr = new CapturingStream();
  });

  it('suppresses reasoning blocks when showThink is false (default)', async () => {
    const session = makeMockSession(THINK_DELTAS);

    await runLlmStream({
      provider: 'anthropic',
      prompt: 'What is the answer?',
      showThink: false,
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    // Reasoning text should NOT appear on either stream
    expect(stdout.output).not.toContain('I should think first...');
    expect(stderr.output).not.toContain('I should think first...');
    // But visible text should still reach stdout
    expect(stdout.output).toContain('The answer is 42.');
  });

  it('emits reasoning blocks to stderr when showThink is true', async () => {
    const session = makeMockSession(THINK_DELTAS);

    await runLlmStream({
      provider: 'anthropic',
      prompt: 'What is the answer?',
      showThink: true,
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    // Reasoning goes to stderr
    expect(stderr.output).toContain('I should think first...');
    // Visible text still goes to stdout
    expect(stdout.output).toBe('The answer is 42.');
    // Usage JSON also on stderr — last chunk is the JSON line
    const lastLine = stderr.chunks[stderr.chunks.length - 1];
    expect(lastLine).toMatch(/\{.*\}\n$/);
  });

  it('produces no stdout output when stream has only reasoning deltas and showThink=false', async () => {
    const session = makeMockSession(THINK_ONLY_DELTAS);

    await runLlmStream({
      provider: 'anthropic',
      prompt: 'Think quietly',
      showThink: false,
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    expect(stdout.output).toBe('');
  });

  it('emits think content to stderr when showThink=true and stream is think-only', async () => {
    const session = makeMockSession(THINK_ONLY_DELTAS);

    await runLlmStream({
      provider: 'anthropic',
      prompt: 'Think quietly',
      showThink: true,
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    expect(stderr.output).toContain('Thinking hard...');
    expect(stdout.output).toBe('');
  });
});

describe('runLlmStream — edge cases', () => {
  let stdout: CapturingStream;
  let stderr: CapturingStream;

  beforeEach(() => {
    stdout = new CapturingStream();
    stderr = new CapturingStream();
  });

  it('handles a stream with no usage delta gracefully', async () => {
    const noUsageDeltas: MockDelta[] = [
      { text: 'Hi', reasoning: '', stopReason: null, usage: null },
      { text: '', reasoning: '', stopReason: 'end_turn', usage: null },
    ];
    const session = makeMockSession(noUsageDeltas);

    const usage = await runLlmStream({
      provider: 'anthropic',
      prompt: 'Hi',
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    // Falls back to zero usage
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    // Still emits a JSON summary line
    expect(stderr.output).toMatch(/\{.*\}\n$/);
  });

  it('handles an empty stream gracefully', async () => {
    const session = makeMockSession([]);

    const usage = await runLlmStream({
      provider: 'anthropic',
      prompt: 'silence',
      _sessionOverride: session as Parameters<typeof runLlmStream>[0]['_sessionOverride'],
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    expect(stdout.output).toBe('');
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    const summary = JSON.parse(stderr.output.trim()) as Record<string, unknown>;
    expect(summary['costUsd']).toBeNull();
  });
});
