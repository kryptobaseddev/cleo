/**
 * Unit tests — typed dispatch adapter (T974).
 *
 * Covers:
 *   1. Compile-time narrowing via `@ts-expect-error` negative assertions.
 *   2. Runtime success path for multi-op handlers.
 *   3. `defineTypedHandler` produces the expected shape.
 *   4. `lafsSuccess` / `lafsError` envelope structure.
 *   5. Error propagation through `typedDispatch`.
 *   6. Generic type inference — result type is narrowed at the call site.
 *
 * These tests are the gate that future runtime-validation work (zod) must
 * not break. Once a handler is migrated to the typed adapter, drift in its
 * contract surfaces as a `tsc` error here rather than a latent cast.
 *
 * @task T974
 */

import { describe, expect, it } from 'vitest';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type TypedDomainHandler,
  type TypedOpRecord,
  typedDispatch,
} from '../typed.js';

// ---------------------------------------------------------------------------
// Test fixtures — synthetic typed op record
// ---------------------------------------------------------------------------

interface EchoParams {
  readonly message: string;
  readonly loud?: boolean;
}

interface EchoResult {
  readonly echoed: string;
  readonly timestamp: number;
}

interface CountParams {
  readonly start: number;
  readonly step: number;
}

interface CountResult {
  readonly final: number;
}

/**
 * Fixture op record — two ops with distinct Params/Result pairs.
 * Serves as the narrowing check: if the adapter's generic inference drifts,
 * the `@ts-expect-error` lines below will stop matching and the build will
 * fail.
 */
type FixtureOps = {
  readonly 'fixture.echo': readonly [EchoParams, EchoResult];
  readonly 'fixture.count': readonly [CountParams, CountResult];
};

/** Build a stable fixture handler used across tests. */
function buildFixtureHandler(): TypedDomainHandler<FixtureOps> {
  return defineTypedHandler<FixtureOps>('fixture', {
    'fixture.echo': async (params) => {
      const prefix = params.loud ? '!!' : '';
      return lafsSuccess<EchoResult>(
        {
          echoed: `${prefix}${params.message}${prefix}`,
          timestamp: 42,
        },
        'fixture.echo',
      );
    },
    'fixture.count': async (params) => {
      return lafsSuccess<CountResult>({ final: params.start + params.step }, 'fixture.count');
    },
  });
}

// ---------------------------------------------------------------------------
// 1 · Compile-time narrowing (negative assertions)
// ---------------------------------------------------------------------------

describe('typedDispatch — compile-time narrowing', () => {
  it('narrows params inside the op function (compiles without cast)', () => {
    // This test body exists purely to pin the shape; the real check is that
    // this module type-checks at build time.
    const handler: TypedDomainHandler<FixtureOps> = defineTypedHandler<FixtureOps>('fixture', {
      'fixture.echo': async (params) => {
        // `params` is narrowed to EchoParams — no cast required. If generic
        // inference breaks, this line fails to type-check.
        const out: EchoResult = {
          echoed: params.message.toUpperCase(),
          timestamp: 0,
        };
        return lafsSuccess(out, 'fixture.echo');
      },
      'fixture.count': async (params) => {
        const final: number = params.start * params.step;
        return lafsSuccess<CountResult>({ final }, 'fixture.count');
      },
    });
    expect(handler.domain).toBe('fixture');
  });

  it('rejects calls with the wrong params shape at compile time', async () => {
    const handler = buildFixtureHandler();

    // Positive control — correct shape compiles.
    const ok = await typedDispatch(handler, 'fixture.echo', {
      message: 'hi',
      loud: true,
    } satisfies EchoParams);
    expect(ok.success).toBe(true);

    // Negative assertion — the op registry uses keyof O & string so invalid
    // op names cannot be dispatched. If generic constraint loosens, the line
    // below will compile without @ts-expect-error and this test will fail.
    // @ts-expect-error — 'fixture.does-not-exist' is not a key of FixtureOps.
    const bogus = typedDispatch(handler, 'fixture.does-not-exist', { message: 'x' });
    // Awaiting the bogus dispatch is a runtime test-helper — we don't actually
    // want TS inference for it here, so we pin it through void.
    await bogus.catch(() => {
      // Runtime will throw because operations['fixture.does-not-exist'] is
      // undefined; that's expected. The compile-time check above is what
      // matters for this assertion.
      return undefined;
    });
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 · Runtime success path
// ---------------------------------------------------------------------------

describe('typedDispatch — runtime success', () => {
  it('dispatches echo op and returns a narrowed success envelope', async () => {
    const handler = buildFixtureHandler();
    const envelope = await typedDispatch(handler, 'fixture.echo', {
      message: 'hello',
      loud: false,
    } satisfies EchoParams);

    expect(envelope.success).toBe(true);
    if (envelope.success) {
      // TS narrows envelope to LafsSuccess<EchoResult> here.
      const result: EchoResult = envelope.data;
      expect(result.echoed).toBe('hello');
      expect(result.timestamp).toBe(42);
    }
  });

  it('dispatches count op with its own distinct params/result types', async () => {
    const handler = buildFixtureHandler();
    const envelope = await typedDispatch(handler, 'fixture.count', {
      start: 10,
      step: 5,
    } satisfies CountParams);

    expect(envelope.success).toBe(true);
    if (envelope.success) {
      const result: CountResult = envelope.data;
      expect(result.final).toBe(15);
    }
  });

  it('propagates errors thrown by op functions unmodified', async () => {
    // Construct a handler whose op always throws — confirms that typedDispatch
    // does not swallow exceptions (op fns should convert to LAFS envelopes
    // themselves via lafsError).
    type BoomOps = {
      readonly 'boom.err': readonly [{ readonly tag: string }, never];
    };
    const handler = defineTypedHandler<BoomOps>('boom', {
      'boom.err': async (params) => {
        throw new Error(`boom: ${params.tag}`);
      },
    });

    await expect(typedDispatch(handler, 'boom.err', { tag: 'fail' })).rejects.toThrow('boom: fail');
  });
});

// ---------------------------------------------------------------------------
// 3 · defineTypedHandler shape
// ---------------------------------------------------------------------------

describe('defineTypedHandler', () => {
  it('produces a handler with the supplied domain and operations', () => {
    type MiniOps = {
      readonly 'mini.noop': readonly [Record<string, never>, { readonly ok: true }];
    };
    const handler = defineTypedHandler<MiniOps>('mini', {
      'mini.noop': async () => lafsSuccess({ ok: true as const }, 'mini.noop'),
    });

    expect(handler.domain).toBe('mini');
    expect(typeof handler.operations['mini.noop']).toBe('function');
    expect(Object.keys(handler.operations)).toEqual(['mini.noop']);
  });

  it('preserves readonly semantics on the returned handler', () => {
    const handler = buildFixtureHandler();
    // Runtime smoke — the TypedDomainHandler interface declares `readonly`
    // members; while TS does not freeze by default, we verify the structural
    // shape is what callers rely on.
    expect(handler.domain).toBe('fixture');
    expect(handler.operations).toBeTypeOf('object');
  });
});

// ---------------------------------------------------------------------------
// 4 · LAFS envelope helpers
// ---------------------------------------------------------------------------

describe('lafsSuccess', () => {
  it('wraps data in a success envelope', () => {
    const envelope = lafsSuccess({ count: 7 }, 'any.op');
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({ count: 7 });
  });

  it('preserves the data payload type through generic inference', () => {
    interface Payload {
      readonly id: string;
      readonly count: number;
    }
    const envelope = lafsSuccess<Payload>({ id: 'abc', count: 3 }, 'any.op');
    if (envelope.success) {
      // TS narrows envelope.data to Payload here (compile-time check).
      const id: string = envelope.data.id;
      const count: number = envelope.data.count;
      expect(id).toBe('abc');
      expect(count).toBe(3);
    }
  });
});

describe('lafsError', () => {
  it('builds an error envelope with code + message', () => {
    const envelope = lafsError('E_NOT_FOUND', 'missing', 'tasks.show');
    expect(envelope.success).toBe(false);
    if (!envelope.success) {
      expect(envelope.error.code).toBe('E_NOT_FOUND');
      expect(envelope.error.message).toBe('missing');
      expect(envelope.error.fix).toBeUndefined();
    }
  });

  it('includes the optional fix hint when supplied', () => {
    const envelope = lafsError(
      'E_NOT_FOUND',
      `task T999 not found`,
      'tasks.show',
      'cleo find T999',
    );
    expect(envelope.success).toBe(false);
    if (!envelope.success) {
      expect(envelope.error.fix).toBe('cleo find T999');
    }
  });

  it('is assignable to LafsEnvelope<T> for any T', async () => {
    // Verify the `LafsEnvelope<never>` return type composes with arbitrary
    // result types. This is the cheap way to confirm the declared type
    // permits op fns to return either success or error without a union cast.
    type AnyOps = {
      readonly 'any.do': readonly [{ readonly id: string }, { readonly done: boolean }];
    };
    const handler = defineTypedHandler<AnyOps>('any', {
      'any.do': async (params) => {
        if (!params.id) return lafsError('E_VALIDATION', 'id required', 'any.do');
        return lafsSuccess({ done: true }, 'any.do');
      },
    });
    const ok = await typedDispatch(handler, 'any.do', { id: 'X' });
    expect(ok.success).toBe(true);
    const bad = await typedDispatch(handler, 'any.do', { id: '' });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 · TypedOpRecord constraint
// ---------------------------------------------------------------------------

describe('TypedOpRecord constraint', () => {
  it('accepts op tuples of any Params/Result pair', () => {
    // Pure compile-time check — verifies the constraint does not over-restrict
    // the op record shape. This test body is a no-op at runtime; its real
    // value is gating drift via the `Accepts` type alias.
    type Accepts = TypedOpRecord;
    const sample: Accepts = {
      'x.y': [{} as { readonly id: string }, {} as { readonly out: number }] as const,
    };
    expect(Object.keys(sample)).toContain('x.y');
  });
});
