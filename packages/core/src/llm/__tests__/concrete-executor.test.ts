/**
 * ConcreteExecutor unit tests (T9290, T9294 W4b).
 *
 * Uses mock LlmSession implementations — no real network calls.
 *
 * @task T9290
 * @task T9294 (W4b — usage-pricing wire tests)
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { ContextEngine, ExecutionEvent } from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedUsage,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcreteExecutor } from '../concrete-executor.js';
import { ConcreteSession } from '../concrete-session.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeUsage(): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5 };
}

function makeResponse(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    id: 'resp-1',
    model: 'claude-haiku-4-5-20251001',
    content: 'Hello!',
    toolCalls: null,
    stopReason: 'end_turn',
    usage: makeUsage(),
    raw: {},
    ...overrides,
  };
}

function makeCredential(): ResolvedCredential {
  return {
    provider: 'anthropic',
    label: 'default',
    token: 'test-key',
    authType: 'api_key',
    expiresAt: null,
    refreshToken: null,
    extraHeaders: {},
    baseUrl: null,
    awsProfile: null,
  };
}

function makeTransport(completeFn: () => Promise<NormalizedResponse>): LlmTransport {
  return {
    provider: 'anthropic',
    apiMode: 'anthropic_messages',
    complete: vi.fn().mockImplementation((_req: TransportRequest) => completeFn()),
    stream: vi.fn().mockImplementation(async function* () {
      yield* [] as never[];
    }),
  };
}

async function collectEvents(gen: AsyncIterable<ExecutionEvent>): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConcreteExecutor', () => {
  let transport: LlmTransport;
  let session: ConcreteSession;

  beforeEach(() => {
    transport = makeTransport(() => Promise.resolve(makeResponse()));
    session = new ConcreteSession({
      transport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
    });
  });

  it('executor with no contextEngine works without errors', async () => {
    const executor = new ConcreteExecutor({ session });
    const events = await collectEvents(
      executor.run({ messages: [{ role: 'user', content: 'Hi' }] }),
    );
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('calls engine.shouldCompress() when engine present', async () => {
    const engine: ContextEngine = {
      shouldCompress: vi.fn().mockReturnValue(false),
      compress: vi.fn(),
      estimateTokens: vi.fn().mockReturnValue(100),
    };
    const executor = new ConcreteExecutor({ session, contextEngine: engine });
    await collectEvents(executor.run({ messages: [{ role: 'user', content: 'Hi' }] }));
    expect(engine.shouldCompress).toHaveBeenCalled();
  });

  it('skips compression silently when engine.shouldCompress returns false', async () => {
    const engine: ContextEngine = {
      shouldCompress: vi.fn().mockReturnValue(false),
      compress: vi.fn(),
      estimateTokens: vi.fn().mockReturnValue(100),
    };
    const executor = new ConcreteExecutor({ session, contextEngine: engine });
    const events = await collectEvents(
      executor.run({ messages: [{ role: 'user', content: 'Hi' }] }),
    );
    expect(engine.compress).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'context_compressed')).toBe(false);
  });

  it('enforces max iterations on tool-call loop', async () => {
    // Mock that returns tool calls on every turn, never stopping.
    const toolCallResponse = makeResponse({
      toolCalls: [{ id: 'tc-1', name: 'my_tool', arguments: '{}' }],
      stopReason: 'tool_use',
    });
    transport = makeTransport(() => Promise.resolve(toolCallResponse));
    session = new ConcreteSession({
      transport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
    });

    const handler = vi.fn().mockResolvedValue('result');
    const executor = new ConcreteExecutor({ session });
    const events = await collectEvents(
      executor.run({
        messages: [{ role: 'user', content: 'Go' }],
        maxIterations: 3,
        toolHandler: handler,
      }),
    );

    // Should complete after 3 iterations (tool_call handler called 3 times).
    const toolCallEvents = events.filter((e) => e.kind === 'tool_call');
    expect(toolCallEvents.length).toBe(3);
    expect(events.at(-1)?.kind).toBe('done');
    const done = events.at(-1);
    if (done?.kind === 'done') {
      expect(done.usage.iterations).toBe(3);
    }
  });

  it('emits done event with AggregatedUsage', async () => {
    const executor = new ConcreteExecutor({ session });
    const events = await collectEvents(
      executor.run({ messages: [{ role: 'user', content: 'Hi' }] }),
    );
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    if (done?.kind === 'done') {
      expect(done.usage.totalInputTokens).toBe(10);
      expect(done.usage.totalOutputTokens).toBe(5);
      expect(done.usage.iterations).toBe(1);
    }
  });

  it('emits error event on terminal failure', async () => {
    transport = makeTransport(() => Promise.reject(new Error('network error')));
    session = new ConcreteSession({
      transport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
    });
    const executor = new ConcreteExecutor({ session });
    const events = await collectEvents(
      executor.run({ messages: [{ role: 'user', content: 'Hi' }] }),
    );
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    if (errEvent?.kind === 'error') {
      expect(errEvent.error.message).toContain('network error');
    }
  });

  it('auxiliary() does not mutate session history', async () => {
    const executor = new ConcreteExecutor({ session });
    const historyBefore = session.history().length;
    await executor.auxiliary([{ role: 'user', content: 'aux call' }]);
    expect(session.history().length).toBe(historyBefore);
  });

  // ---------------------------------------------------------------------------
  // T9294 (W4b) — usage-pricing wiring tests
  // ---------------------------------------------------------------------------

  describe('usage-pricing wiring (T9294 W4b)', () => {
    it('aggregates costUsd per iteration in run()', async () => {
      // Use a known model (claude-haiku-4-5-20251001) with known pricing
      const executor = new ConcreteExecutor({ session });
      const events = await collectEvents(
        executor.run({ messages: [{ role: 'user', content: 'Hi' }] }),
      );
      const done = events.find((e) => e.kind === 'done');
      expect(done?.kind).toBe('done');
      if (done?.kind === 'done') {
        // 10 input tokens + 5 output tokens at $1/$5 per million = $0.000010 + $0.000025
        // costUsd should be non-null since claude-haiku-4-5-20251001 is in PRICING_SNAPSHOT
        expect(done.usage.costUsd).not.toBeNull();
        expect(typeof done.usage.costUsd).toBe('number');
        expect(done.usage.costUsd).toBeGreaterThan(0);
      }
    });

    it('returns null costUsd for unknown model', async () => {
      transport = makeTransport(() =>
        Promise.resolve(
          makeResponse({ model: 'unknown-model-xyz', usage: { inputTokens: 10, outputTokens: 5 } }),
        ),
      );
      session = new ConcreteSession({
        transport,
        model: 'unknown-model-xyz',
        credential: makeCredential(),
      });
      const executor = new ConcreteExecutor({ session });
      const events = await collectEvents(
        executor.run({ messages: [{ role: 'user', content: 'Hi' }] }),
      );
      const done = events.find((e) => e.kind === 'done');
      expect(done?.kind).toBe('done');
      if (done?.kind === 'done') {
        // computeCost returns 0 for unknown models → mapped to null
        expect(done.usage.costUsd).toBeNull();
      }
    });
  });
});
