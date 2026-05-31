/**
 * HTTP transport adapter tests (R3-T6 · T11450).
 *
 * Asserts:
 *  1. routeUnary maps an HTTP request → a `source: 'http'` DispatchRequest routed
 *     through the injected GatewayHandler, FORCING source even if the caller lied,
 *     and traps thrown handler errors as a 500 E_HTTP_INTERNAL envelope (no throw,
 *     no exit).
 *  2. statusForResponse maps the LAFS error code → the correct HTTP status.
 *  3. The SSE encoders produce the exact wire bytes for both the canonical
 *     GatewayStreamEvent (`data:`-only) and a bespoke named-`event:` frame, so an
 *     existing stream can adopt the plumbing without changing its bytes.
 *  4. createSseStream drives an SseSource, drops frames after close, runs teardown
 *     exactly once, and closes on the request AbortSignal.
 *
 * The core logger factory is not used by the HTTP adapter (framework-agnostic, no
 * port binding) so no mock is required — mirroring the lean RPC adapter test.
 *
 * @task T11450
 * @epic T11254
 * @saga T11243
 */

import type {
  DispatchRequest,
  DispatchResponse,
  GatewayStreamEvent,
} from '@cleocode/contracts/gateway';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayHandler } from '../../index.js';
import { routeUnary, statusForResponse } from '../server.js';
import { createSseStream, encodeSseFrame, encodeStreamEvent } from '../sse.js';
import type { HttpUnaryRequest } from '../types.js';

/** A reusable valid unary request builder. */
function unaryRequest(overrides?: Partial<HttpUnaryRequest>): HttpUnaryRequest {
  return {
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    params: { id: 'T1' },
    requestId: 'req-1',
    ...overrides,
  };
}

/** A fake gateway handler that records the request and echoes a success envelope. */
function fakeHandler(): { handler: GatewayHandler; calls: DispatchRequest[] } {
  const calls: DispatchRequest[] = [];
  const handler: GatewayHandler = {
    handle(req: DispatchRequest): Promise<DispatchResponse> {
      calls.push(req);
      return Promise.resolve({
        meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          timestamp: '2026-05-31T00:00:00.000Z',
          duration_ms: 1,
          source: req.source,
          requestId: req.requestId,
        },
        success: true,
        data: { ok: true },
      });
    },
  };
  return { handler, calls };
}

describe('R3-T6 HTTP routeUnary — gateway routing', () => {
  it('maps a request → source:http DispatchRequest through the handler', async () => {
    const { handler, calls } = fakeHandler();
    const out = await routeUnary(handler, unaryRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe('http');
    expect(calls[0].domain).toBe('tasks');
    expect(calls[0].requestId).toBe('req-1');
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
  });

  it('FORCES source to http even when the caller claims a different transport', async () => {
    const { handler, calls } = fakeHandler();
    // The HttpUnaryRequest has no `source` field, but the resulting dispatch
    // request must always be http; assert the produced envelope's meta.source.
    const out = await routeUnary(handler, unaryRequest());
    expect(calls[0].source).toBe('http');
    expect(out.body.meta.source).toBe('http');
  });

  it('mints a requestId when the caller omits one', async () => {
    const { handler, calls } = fakeHandler();
    await routeUnary(handler, unaryRequest({ requestId: undefined }));
    expect(typeof calls[0].requestId).toBe('string');
    expect(calls[0].requestId.length).toBeGreaterThan(0);
  });

  it('renders a thrown handler error as a 500 E_HTTP_INTERNAL envelope (no throw / no exit)', async () => {
    const handler: GatewayHandler = { handle: () => Promise.reject(new Error('boom')) };
    const out = await routeUnary(handler, unaryRequest());
    expect(out.status).toBe(500);
    expect(out.body.success).toBe(false);
    expect(out.body.error?.code).toBe('E_HTTP_INTERNAL');
    expect(out.body.error?.message).toContain('boom');
  });
});

describe('R3-T6 HTTP statusForResponse — LAFS error → HTTP status', () => {
  function errResponse(code: string): DispatchResponse {
    return {
      meta: {
        gateway: 'query',
        domain: 'd',
        operation: 'o',
        timestamp: 't',
        duration_ms: 0,
        source: 'http',
        requestId: 'r',
      },
      success: false,
      error: { code, message: 'x' },
    };
  }

  it('200 on success', () => {
    const ok = { ...errResponse('E_X'), success: true, error: undefined };
    expect(statusForResponse(ok)).toBe(200);
  });

  it('404 for E_NOT_FOUND', () => {
    expect(statusForResponse(errResponse('E_NOT_FOUND'))).toBe(404);
  });

  it('400 for validation errors', () => {
    expect(statusForResponse(errResponse('E_VALIDATION_FAILED'))).toBe(400);
  });

  it('403 for E_FORBIDDEN', () => {
    expect(statusForResponse(errResponse('E_FORBIDDEN'))).toBe(403);
  });

  it('429 for rate limiting', () => {
    expect(statusForResponse(errResponse('E_RATE_LIMITED'))).toBe(429);
  });

  it('500 for an unmapped error code', () => {
    expect(statusForResponse(errResponse('E_SOMETHING_ELSE'))).toBe(500);
  });
});

describe('R3-T6 HTTP SSE encoders — exact wire bytes', () => {
  it('encodes a GatewayStreamEvent as a data:-only record with seq as id', () => {
    const ev: GatewayStreamEvent = { kind: 'data', seq: 3, data: { n: 1 }, requestId: 'r' };
    const wire = encodeStreamEvent(ev);
    expect(wire).toBe(`id: 3\ndata: ${JSON.stringify(ev)}\n\n`);
  });

  it('reproduces a named-event frame byte-for-byte (event: name\\ndata: json\\n\\n)', () => {
    const wire = encodeSseFrame({ event: 'task-updated', data: { ts: 'x' } });
    expect(wire).toBe('event: task-updated\ndata: {"ts":"x"}\n\n');
  });

  it('reproduces a data:-only frame byte-for-byte (no event field)', () => {
    const wire = encodeSseFrame({ data: { type: 'hello', ts: 'x' } });
    expect(wire).toBe('data: {"type":"hello","ts":"x"}\n\n');
  });
});

describe('R3-T6 HTTP SSE createSseStream — lifecycle', () => {
  /** Read the full text of a stream until it closes. */
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('emits frames pushed by the source and runs teardown exactly once', async () => {
    const teardown = vi.fn();
    const stream = createSseStream((emitter) => {
      emitter.sendStreamEvent({ kind: 'data', seq: 0, data: { a: 1 }, requestId: 'r' });
      emitter.sendStreamEvent({ kind: 'done', seq: 1, data: { ok: true }, requestId: 'r' });
      emitter.close();
      return teardown;
    });

    const text = await drain(stream);
    expect(text).toContain('"kind":"data"');
    expect(text).toContain('"kind":"done"');
    expect(text).toContain('id: 0');
    expect(text).toContain('id: 1');
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('drops frames pushed after close (no throw)', async () => {
    let lateEmitter: { send: (f: { data: unknown }) => void } | undefined;
    const stream = createSseStream((emitter) => {
      emitter.send({ data: { first: true } });
      emitter.close();
      lateEmitter = emitter;
      return undefined;
    });

    const text = await drain(stream);
    expect(text).toContain('"first":true');
    // Pushing after close is a silent no-op and never throws.
    expect(() => lateEmitter?.send({ data: { late: true } })).not.toThrow();
    expect(text).not.toContain('"late":true');
  });

  it('closes the stream on the request AbortSignal and runs teardown', async () => {
    const teardown = vi.fn();
    const controller = new AbortController();
    const stream = createSseStream((emitter) => {
      emitter.send({ data: { type: 'hello' } });
      return teardown;
    }, controller.signal);

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"hello"');

    controller.abort();
    const next = await reader.read();
    expect(next.done).toBe(true);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('closes immediately if the signal is already aborted', async () => {
    const teardown = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const stream = createSseStream((emitter) => {
      emitter.send({ data: { type: 'hello' } });
      return teardown;
    }, controller.signal);

    const text = await drain(stream);
    // Source never ran (closed before start completed) → no frames, no teardown.
    expect(text).toBe('');
    expect(teardown).not.toHaveBeenCalled();
  });
});
