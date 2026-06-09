/**
 * `/v1` REST facade tests (T11919 · M5 · AC1+AC4+AC5).
 *
 * Asserts the versioned REST facade the daemon serves in front of the existing
 * gateway dispatch:
 *
 *  1. {@link parseHttpRoute} accepts `POST /v1/<domain>/<operation>` (gateway
 *     INFERRED from the registry — `tasks/show` → query, `tasks/projection.repair`
 *     → mutate), keeps the legacy `/<gateway>/<domain>/<operation>` form, and
 *     recognizes `GET /v1/health`.
 *  2. The 405 (bad method) / 404 (unroutable + unknown operation) edge errors
 *     are preserved as LAFS-shaped envelopes (AC5).
 *  3. An in-process {@link startHttpServer} boot on an EPHEMERAL port round-trips
 *     one operation through `/v1/tasks/show` returning a valid LAFS envelope, and
 *     `GET /v1/health` returns a `200` health envelope (AC4).
 *
 * All round-trips are in-process (NO subprocess — tsx is unresolvable in CI) over
 * a fake {@link GatewayHandler}, so the test exercises the wire edge + routing
 * without standing up the full CLI dispatcher.
 *
 * @task T11919
 * @epic T11769
 * @saga T10400
 */

import { request } from 'node:http';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayHandler } from '../../index.js';
import { parseHttpRoute, startHttpServer } from '../listen.js';

/** A fake gateway handler that records each request and echoes a success envelope. */
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
          timestamp: '2026-06-09T00:00:00.000Z',
          duration_ms: 1,
          source: req.source,
          requestId: req.requestId,
        },
        success: true,
        data: { echoed: true, params: req.params ?? null },
      });
    },
  };
  return { handler, calls };
}

/** Issue one HTTP request in-process and resolve the parsed JSON body + status. */
function httpRoundTrip(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: DispatchResponse }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers:
          payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as DispatchResponse });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('T11919 parseHttpRoute — /v1 facade (AC1)', () => {
  it('accepts POST /v1/<domain>/<operation> and INFERS the query gateway from the registry', () => {
    const route = parseHttpRoute('POST', '/v1/tasks/show');
    expect(route).toEqual({
      ok: true,
      kind: 'unary',
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
    });
  });

  it('infers the mutate gateway for a write operation', () => {
    const route = parseHttpRoute('POST', '/v1/tasks/projection.repair');
    expect(route.ok).toBe(true);
    if (route.ok && route.kind === 'unary') expect(route.gateway).toBe('mutate');
  });

  it('retains the legacy POST /<gateway>/<domain>/<operation> form', () => {
    const route = parseHttpRoute('POST', '/query/tasks/show');
    expect(route).toEqual({
      ok: true,
      kind: 'unary',
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
    });
  });

  it('recognizes GET /v1/health as a liveness probe', () => {
    expect(parseHttpRoute('GET', '/v1/health')).toEqual({ ok: true, kind: 'health' });
  });

  it('404s an unknown /v1 operation (registry has no match)', () => {
    const route = parseHttpRoute('POST', '/v1/tasks/nope-not-real');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.status).toBe(404);
  });

  it('405s a non-POST/GET method (AC5)', () => {
    const route = parseHttpRoute('DELETE', '/v1/tasks/show');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.status).toBe(405);
  });

  it('405s an unrecognized GET (streaming seam preserved for T11921/T11922)', () => {
    const route = parseHttpRoute('GET', '/v1/tasks/show');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.status).toBe(405);
  });

  it('404s a path that resolves to neither vocabulary', () => {
    const route = parseHttpRoute('POST', '/totally/unknown');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.status).toBe(404);
  });
});

describe('T11919 in-process /v1 round-trip (AC4)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('boots on an ephemeral port and round-trips POST /v1/tasks/show → a valid LAFS envelope', async () => {
    const { handler, calls } = fakeHandler();
    const server = await startHttpServer(handler, { port: 0 });
    closers.push(() => server.close());
    expect(typeof server.port).toBe('number');
    expect(server.port).toBeGreaterThan(0);

    const { status, body } = await httpRoundTrip(server.port, 'POST', '/v1/tasks/show', {
      taskId: 'T1',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta.source).toBe('http');
    expect(body.meta.domain).toBe('tasks');
    expect(body.meta.operation).toBe('show');
    // The gateway was inferred (client did not name query/mutate).
    const httpCall = calls.find((c) => c.source === 'http');
    expect(httpCall?.gateway).toBe('query');
    expect(httpCall?.params).toEqual({ taskId: 'T1' });
  });

  it('serves GET /v1/health with a 200 health envelope (AC4)', async () => {
    const { handler } = fakeHandler();
    const server = await startHttpServer(handler, { port: 0 });
    closers.push(() => server.close());

    const { status, body } = await httpRoundTrip(server.port, 'GET', '/v1/health');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta.operation).toBe('health');
  });

  it('preserves a 404 over the wire for an unknown /v1 operation (AC5)', async () => {
    const { handler } = fakeHandler();
    const server = await startHttpServer(handler, { port: 0 });
    closers.push(() => server.close());

    const { status, body } = await httpRoundTrip(server.port, 'POST', '/v1/tasks/nope', {});
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('E_HTTP_NOT_FOUND');
  });
});
