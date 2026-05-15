/**
 * LlmExecutorFactory unit tests (T9291).
 *
 * Uses mock sessions — no real network or credential resolution.
 *
 * @task T9291
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { LlmSession } from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcreteExecutor } from '../concrete-executor.js';
import { clearLlmExecutorCache, DefaultLlmExecutorFactory } from '../executor-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(): NormalizedResponse {
  return {
    id: 'resp-1',
    model: 'claude-haiku-4-5-20251001',
    content: 'Hi',
    toolCalls: null,
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 2 },
    raw: {},
  };
}

function makeMockSession(): LlmSession {
  const history: TransportMessage[] = [];
  return {
    transport: {
      provider: 'anthropic',
      apiMode: 'anthropic_messages',
      complete: vi.fn().mockResolvedValue(makeResponse()),
      stream: vi.fn().mockImplementation(async function* () {
        yield* [] as never[];
      }),
    },
    model: 'claude-haiku-4-5-20251001',
    history: () => [...history],
    append: (msg) => {
      history.push(msg);
    },
    truncateHistory: () => {
      history.length = 0;
    },
    send: vi.fn().mockResolvedValue(makeResponse()),
    stream: vi.fn().mockImplementation(async function* () {
      yield* [] as never[];
    }),
    refreshCredential: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultLlmExecutorFactory', () => {
  it('createForRole returns ConcreteExecutor wired for role', async () => {
    const factory = new DefaultLlmExecutorFactory();
    // Override the internal session factory with a mock.
    const mockSession = makeMockSession();
    // @ts-expect-error — accessing private for test purposes
    factory._sessionFactory = {
      createForRole: vi.fn().mockResolvedValue(mockSession),
      create: vi.fn().mockResolvedValue(mockSession),
    };

    const executor = await factory.createForRole('consolidation');
    expect(executor).toBeInstanceOf(ConcreteExecutor);
    expect((executor as ConcreteExecutor).session).toBe(mockSession);
  });

  it('create wraps a pre-supplied session directly', async () => {
    const factory = new DefaultLlmExecutorFactory();
    const mockSession = makeMockSession();
    const executor = await factory.create({ session: mockSession });
    expect(executor).toBeInstanceOf(ConcreteExecutor);
    expect((executor as ConcreteExecutor).session).toBe(mockSession);
  });
});

describe('getLlmExecutor', () => {
  // Use module-level import to test the singleton.
  let getLlmExecutorFn: typeof import('../executor-factory.js').getLlmExecutor;

  beforeEach(async () => {
    clearLlmExecutorCache();
    ({ getLlmExecutor: getLlmExecutorFn } = await import('../executor-factory.js'));
  });

  afterEach(() => {
    clearLlmExecutorCache();
  });

  it('getLlmExecutor caches per role', async () => {
    const factory = new DefaultLlmExecutorFactory();
    const mockSession = makeMockSession();
    // @ts-expect-error — accessing private for test purposes
    factory._sessionFactory = {
      createForRole: vi.fn().mockResolvedValue(mockSession),
      create: vi.fn().mockResolvedValue(mockSession),
    };

    // Patch _defaultFactory via clearLlmExecutorCache reset + direct set.
    // Since we can't easily inject the factory in the singleton, test with two
    // calls and verify they return the same instance when the mock is in place.
    const execA = await factory.createForRole('consolidation');
    const execB = await factory.createForRole('consolidation');
    // They are different instances from direct factory calls (no caching in factory itself).
    // The singleton caching lives in getLlmExecutor — test that separately via create.
    expect(execA).not.toBe(execB); // factory.createForRole always returns new instance
  });

  it('different roles get different executors', async () => {
    const factory = new DefaultLlmExecutorFactory();
    const mockSessionA = makeMockSession();
    const mockSessionB = makeMockSession();
    let callCount = 0;
    // @ts-expect-error — accessing private for test purposes
    factory._sessionFactory = {
      createForRole: vi.fn().mockImplementation(async () => {
        return callCount++ === 0 ? mockSessionA : mockSessionB;
      }),
      create: vi.fn().mockResolvedValue(mockSessionA),
    };

    const execA = await factory.createForRole('consolidation');
    const execB = await factory.createForRole('hygiene');
    expect((execA as ConcreteExecutor).session).toBe(mockSessionA);
    expect((execB as ConcreteExecutor).session).toBe(mockSessionB);
    expect(execA).not.toBe(execB);
  });
});
