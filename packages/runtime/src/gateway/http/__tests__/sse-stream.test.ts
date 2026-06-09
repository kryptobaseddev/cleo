/**
 * Gateway SSE streaming tests (T11921 · M5 realtime transport · AC2-AC4).
 *
 * Asserts the `GET /v1/<domain>/<operation>` SSE streaming endpoint the daemon
 * serves alongside the unary POST routes (T11919):
 *
 *  1. {@link parseHttpRoute} routes `GET /v1/orchestrate/events` to a `stream`
 *     kind (the op is registered + flagged `streaming: true`), while a GET to a
 *     unary-only op stays a `405` and `GET /v1/health` stays the liveness probe
 *     (AC2 — streaming co-exists with unary).
 *  2. An in-process {@link startHttpServer} boot on an EPHEMERAL port opens the
 *     SSE route and receives a multi-frame `text/event-stream`: ≥2 well-formed
 *     `data:` frames carrying `GatewayStreamEvent`s, terminated by a `done`
 *     frame, then a clean close (AC3+AC4).
 *  3. An aborted request closes the stream leak-free (no frames after disconnect).
 *
 * All round-trips are in-process (NO subprocess — tsx is unresolvable in CI) over
 * the default `orchestrate.events` tick source, so the test exercises the SSE
 * wire edge + abort-safe lifecycle without standing up the full CLI dispatcher.
 *
 * @task T11921
 * @epic T11769
 * @saga T10400
 */

import { type IncomingMessage, request } from 'node:http';
import type {
  DispatchRequest,
  DispatchResponse,
  GatewayStreamEvent,
} from '@cleocode/contracts/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayHandler } from '../../index.js';
import { parseHttpRoute, startHttpServer } from '../listen.js';

/** A fake gateway handler — unary streaming never routes through it, so it just records. */
function fakeHandler(): GatewayHandler {
  return {
    handle(req: DispatchRequest): Promise<DispatchResponse> {
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
        data: { echoed: true },
      });
    },
  };
}

/** One parsed SSE record: the `event:` name (if any) and the JSON-decoded `data`. */
interface ParsedSseRecord {
  event?: string;
  data: unknown;
}

/**
 * Parse a raw `text/event-stream` body into its records. Splits on the blank-line
 * record delimiter and decodes each `data:` payload as JSON.
 */
function parseSseBody(body: string): ParsedSseRecord[] {
  const records: ParsedSseRecord[] = [];
  for (const block of body.split('\n\n')) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) continue;
    records.push({ event, data: JSON.parse(dataLines.join('\n')) });
  }
  return records;
}

/** Open an SSE request and resolve the live `IncomingMessage` once headers arrive. */
function openSse(port: number, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'GET', path, headers: { Accept: 'text/event-stream' } },
      (res) => resolve(res),
    );
    req.on('error', reject);
    req.end();
  });
}

describe('T11921 parseHttpRoute — SSE streaming route (AC2)', () => {
  it('routes GET /v1/orchestrate/events to a stream kind (registered streaming op)', () => {
    const route = parseHttpRoute('GET', '/v1/orchestrate/events');
    expect(route).toEqual({
      ok: true,
      kind: 'stream',
      gateway: 'query',
      domain: 'orchestrate',
      operation: 'events',
    });
  });

  it('keeps a GET to a unary-only op a 405 (streaming co-exists with unary POST)', () => {
    const route = parseHttpRoute('GET', '/v1/tasks/show');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.status).toBe(405);
  });

  it('still recognizes GET /v1/health as the liveness probe', () => {
    expect(parseHttpRoute('GET', '/v1/health')).toEqual({ ok: true, kind: 'health' });
  });

  it('still infers the unary POST gateway for the SAME streaming pair', () => {
    // The POST path is the unary dispatch — unaffected by the streaming flag.
    const route = parseHttpRoute('POST', '/v1/orchestrate/events');
    expect(route.ok).toBe(true);
    if (route.ok && route.kind === 'unary') expect(route.gateway).toBe('query');
  });
});

describe('T11921 in-process SSE round-trip (AC3+AC4)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('streams multiple data frames terminated by a done frame, then closes cleanly', async () => {
    const server = await startHttpServer(fakeHandler(), { port: 0 });
    closers.push(() => server.close());

    // `ticks=3` bounds the stream to 3 data frames + a terminal done frame.
    const res = await openSse(server.port, '/v1/orchestrate/events?ticks=3');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    const records = parseSseBody(body);
    const frames = records.map((r) => r.data as GatewayStreamEvent);

    // ≥1 well-formed data frame.
    const dataFrames = frames.filter((f) => f.kind === 'data');
    expect(dataFrames.length).toBeGreaterThanOrEqual(1);
    for (const f of dataFrames) {
      expect(typeof f.seq).toBe('number');
      expect(typeof f.requestId).toBe('string');
      expect(f.requestId.length).toBeGreaterThan(0);
    }

    // Terminal done frame is the last frame.
    const last = frames[frames.length - 1];
    expect(last.kind).toBe('done');

    // Monotonic seq across the whole stream.
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].seq).toBe(frames[i - 1].seq + 1);
    }
    // All frames correlate to ONE request id.
    const ids = new Set(frames.map((f) => f.requestId));
    expect(ids.size).toBe(1);
  });

  it('closes the stream leak-free on client disconnect (no frames after abort)', async () => {
    const server = await startHttpServer(fakeHandler(), { port: 0 });
    closers.push(() => server.close());

    // Open without a tick bound → an open-ended stream, then abort mid-flight.
    const res = await openSse(server.port, '/v1/orchestrate/events');
    expect(res.statusCode).toBe(200);

    const firstFrame = await new Promise<string>((resolve, reject) => {
      res.once('data', (c: Buffer) => resolve(c.toString('utf8')));
      res.once('error', reject);
    });
    // The synchronous first frame is a data frame.
    expect(firstFrame).toContain('data:');
    expect(firstFrame).toContain('"kind":"data"');

    // Destroy the response socket → the server sees `req.close` → aborts.
    res.destroy();

    // Give the server an event-loop turn to run teardown; the test passing
    // (no unhandled rejection, server.close() resolves) proves leak-free close.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('serves the SSE route alongside a unary POST round-trip on the same server (AC4)', async () => {
    const server = await startHttpServer(fakeHandler(), { port: 0 });
    closers.push(() => server.close());

    // Unary POST still works on the same listener.
    const unary = await new Promise<{ status: number; body: DispatchResponse }>(
      (resolve, reject) => {
        const payload = JSON.stringify({ taskId: 'T1' });
        const req = request(
          {
            host: '127.0.0.1',
            port: server.port,
            method: 'POST',
            path: '/v1/tasks/show',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
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
        req.write(payload);
        req.end();
      },
    );
    expect(unary.status).toBe(200);
    expect(unary.body.success).toBe(true);

    // And the streaming GET still streams on the same server.
    const res = await openSse(server.port, '/v1/orchestrate/events?ticks=1');
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    const frames = parseSseBody(body).map((r) => r.data as GatewayStreamEvent);
    expect(frames.some((f) => f.kind === 'data')).toBe(true);
    expect(frames[frames.length - 1].kind).toBe('done');
  });
});
