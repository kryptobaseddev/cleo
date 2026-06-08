/**
 * Detached-producer abort teardown for the Cleo-owned Pi `StreamFn`
 * (T11761 · S2 · T11898).
 *
 * {@link createPiStreamFn} returns its stream synchronously and detaches the
 * async producer (`void produce(...)`). Without teardown that producer could
 * keep streaming after the run that started it (`wrapPiCall`) has settled —
 * the residual exit-escape window the daemon exit-guard backstops.
 *
 * These tests prove the structural fix: the producer threads the run's abort
 * signal into the per-call `SendOptions` AND tears the transport iterator down
 * (its `return()` is called) the instant the signal aborts — even against a
 * transport that ignores the signal option. The resolver + ModelRunner are
 * mocked so no real credential / network is needed; the focus is the teardown.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import type { NormalizedDelta } from '@cleocode/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Mocks: resolver returns a credentialed envelope; ModelRunner returns a
//     session whose stream is a slow generator that RECORDS its `return()`. ---

let returnCalled = false;
let receivedSendOptions: unknown;
let yieldedAfterAbort = 0;
const abortBus: { signal?: AbortSignal } = {};

vi.mock('../../system-resolver.js', () => ({
  resolveLLMForSystem: vi.fn(async () => ({
    provider: 'anthropic',
    model: 'mock-model',
    client: null,
    // E10 (T11753): non-secret metadata + a sealed handle whose fetch() the
    // wire-side `toDescriptor` invokes to materialize the token.
    credential: {
      provider: 'anthropic',
      source: 'env',
      authType: 'api_key',
    },
    sealedCredential: {
      provider: 'anthropic',
      account: 'mock',
      fetch: async () => ({ __decryptedToken: 'DecryptedToken' as const, value: 'sk-mock' }),
    },
    source: 'role-config',
    apiMode: 'anthropic_messages',
    baseUrl: null,
    authType: 'api_key',
  })),
}));

vi.mock('../../model-runner.js', () => ({
  ModelRunner: {
    build: vi.fn(async () => ({
      languageModel: null,
      session: {
        // A slow infinite stream. Records `return()` (the async-iterator
        // cancellation hook the producer MUST call on abort) and stops yielding
        // once the test's signal is aborted.
        stream(
          _messages: unknown,
          opts?: { signal?: AbortSignal },
        ): AsyncIterable<NormalizedDelta> {
          receivedSendOptions = opts;
          return {
            [Symbol.asyncIterator](): AsyncIterator<NormalizedDelta> {
              return {
                async next(): Promise<IteratorResult<NormalizedDelta>> {
                  // Yield a few chunks, slowly, until aborted.
                  await new Promise((r) => setTimeout(r, 5));
                  if (abortBus.signal?.aborted) {
                    yieldedAfterAbort += 1;
                  }
                  return {
                    done: false,
                    value: { text: 'x', reasoning: '', stopReason: null, usage: null },
                  };
                },
                async return(): Promise<IteratorResult<NormalizedDelta>> {
                  returnCalled = true;
                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
      },
    })),
  },
}));

// Imported AFTER the mocks so the producer binds to the mocked modules.
const { createPiStreamFn } = await import('../pi-stream-fn.js');

afterEach(() => {
  returnCalled = false;
  receivedSendOptions = undefined;
  yieldedAfterAbort = 0;
  abortBus.signal = undefined;
  vi.clearAllMocks();
});

/** Drain a Pi event stream until its terminal `done`/`error`/`end`. */
async function drain(stream: {
  [Symbol.asyncIterator](): AsyncIterator<{ type: string }>;
}): Promise<string[]> {
  const types: string[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string }>) {
    types.push(ev.type);
  }
  return types;
}

describe('createPiStreamFn — detached producer teardown on abort (T11898)', () => {
  it('threads the run signal into the transport SendOptions', async () => {
    const controller = new AbortController();
    abortBus.signal = controller.signal;
    const streamFn = createPiStreamFn({
      system: 'task-executor',
      sessionId: 's-1',
      agentId: null,
      parentSessionId: null,
      signal: controller.signal,
    });
    const out = streamFn(
      { id: 'm', name: 'm', api: 'anthropic-messages', provider: 'p' } as never,
      { messages: [] } as never,
    );
    // Abort almost immediately, then drain. The producer must terminate.
    setTimeout(() => controller.abort(), 8);
    await drain(out as never);
    expect((receivedSendOptions as { signal?: AbortSignal } | undefined)?.signal).toBe(
      controller.signal,
    );
  });

  it('tears the transport iterator down (return() called) when the loop aborts', async () => {
    const controller = new AbortController();
    abortBus.signal = controller.signal;
    const streamFn = createPiStreamFn({
      system: 'task-executor',
      sessionId: 's-2',
      agentId: null,
      parentSessionId: null,
      signal: controller.signal,
    });
    const out = streamFn(
      { id: 'm', name: 'm', api: 'anthropic-messages', provider: 'p' } as never,
      { messages: [] } as never,
    );
    setTimeout(() => controller.abort(), 8);
    const types = await drain(out as never);
    // The producer terminated (did not run forever) and tore the iterator down.
    expect(returnCalled).toBe(true);
    // The stream ends with a terminal error event (the aborted projection).
    expect(types).toContain('error');
  });

  it('emits a terminal aborted event WITHOUT streaming when the signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    abortBus.signal = controller.signal;
    const streamFn = createPiStreamFn({
      system: 'task-executor',
      sessionId: 's-3',
      agentId: null,
      parentSessionId: null,
      signal: controller.signal,
    });
    const out = streamFn(
      { id: 'm', name: 'm', api: 'anthropic-messages', provider: 'p' } as never,
      { messages: [] } as never,
    );
    const types = await drain(out as never);
    // Pre-aborted → terminal error event, and the transport never yielded.
    expect(types).toContain('error');
    expect(yieldedAfterAbort).toBe(0);
  });
});
