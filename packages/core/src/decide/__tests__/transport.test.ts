/**
 * `decideFetch` — the abort-complete transport behind the Jev provider.
 *
 * The process-exit property itself is proven end to end by the spawned-CLI
 * test in `packages/cleo/src/cli/__tests__/decide-duplicate-exit.test.ts`;
 * these cases pin the request/response contract and the abort behaviour.
 *
 * @task T12492
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideFetch } from '../transport.js';

let http: HttpServer;
let httpUrl: string;
let hole: Server;
let holePort = 0;
const held: Socket[] = [];

beforeAll(async () => {
  http = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/empty') {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json', 'x-echo-host': req.headers.host });
      res.end(
        JSON.stringify({
          method: req.method,
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpUrl = `http://localhost:${(http.address() as { port: number }).port}`;

  hole = createServer((socket) => held.push(socket));
  await new Promise<void>((r) => hole.listen(0, '127.0.0.1', r));
  holePort = (hole.address() as { port: number }).port;
});

afterAll(async () => {
  for (const s of held) s.destroy();
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  await new Promise<void>((r) => hole.close(() => r()));
});

describe('decideFetch', () => {
  it('sends method, headers and body, and buffers the response', async () => {
    const res = await decideFetch(`${httpUrl}/v1/x?q=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      body: '{"a":1}',
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers.get('x-echo-host')).toBe(new URL(httpUrl).host);
    expect(await res.json()).toEqual({ method: 'POST', auth: 'Bearer k', body: '{"a":1}' });
  });

  it('returns a null-body response for 204', async () => {
    const res = await decideFetch(`${httpUrl}/empty`, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('rejects with AbortError promptly when aborted mid-handshake', async () => {
    const started = performance.now();
    const pending = decideFetch(`https://127.0.0.1:${holePort}/v1/systemone`, {
      method: 'POST',
      headers: {},
      body: '{}',
      signal: AbortSignal.timeout(100),
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(performance.now() - started).toBeLessThan(600);
  });

  it('rejects at once for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decideFetch(`${httpUrl}/v1/x`, { method: 'GET', headers: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
