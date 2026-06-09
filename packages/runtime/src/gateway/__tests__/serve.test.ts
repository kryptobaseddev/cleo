/**
 * `serveGateway` bootstrap tests (T11919 · M5 · AC2+AC4).
 *
 * `serveGateway` is the runtime-side call-site `cleo daemon serve` drives: it
 * assembles one scoped gateway subsystem hosting the HTTP transport over an
 * injected handler and returns a live handle with the bound port + an idempotent
 * `close()`. This test boots it on an EPHEMERAL port (in-process, NO subprocess —
 * tsx is unresolvable in CI), round-trips one operation through the `/v1` facade,
 * asserts `/v1/health`, and verifies `close()` tears the listener down.
 *
 * @task T11919
 * @epic T11769
 * @saga T10400
 */

import { request } from 'node:http';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayHandler } from '../index.js';
import { serveGateway } from '../serve.js';

/** A fake gateway handler that echoes a success envelope. */
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
        data: { ok: true },
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
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as DispatchResponse,
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('T11919 serveGateway — daemon-serve bootstrap', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('binds an ephemeral loopback port and round-trips /v1/tasks/show', async () => {
    const { handler, calls } = fakeHandler();
    const handle = await serveGateway({ handler, port: 0 });
    closers.push(() => handle.close());

    expect(handle.host).toBe('127.0.0.1');
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.scope).toBe('global');

    const { status, body } = await httpRoundTrip(handle.port, 'POST', '/v1/tasks/show', {
      taskId: 'T1',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const httpCall = calls.find((c) => c.source === 'http');
    expect(httpCall?.gateway).toBe('query'); // inferred from the registry
    expect(httpCall?.domain).toBe('tasks');
  });

  it('serves GET /v1/health', async () => {
    const { handler } = fakeHandler();
    const handle = await serveGateway({ handler, port: 0 });
    closers.push(() => handle.close());

    const { status, body } = await httpRoundTrip(handle.port, 'GET', '/v1/health');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('close() tears the listener down (idempotent)', async () => {
    const { handler } = fakeHandler();
    const handle = await serveGateway({ handler, port: 0 });
    const { port } = handle;

    await handle.close();
    await handle.close(); // second call is a no-op

    // A request to the closed port now fails to connect.
    await expect(httpRoundTrip(port, 'GET', '/v1/health')).rejects.toBeDefined();
  });
});
