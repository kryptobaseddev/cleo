/**
 * Tests for the gateway SSE consumer (T11936).
 *
 * Covers the pure `decodeSseRecord` parser and the live
 * `subscribeOrchestrateEvents` reader against an in-process `http.Server` that
 * emits the SAME `id: <seq>\ndata: <json>\n\n` wire the gateway encoder produces
 * (`packages/runtime/src/gateway/http/sse.ts`). Asserts: frames decode in order;
 * a terminal `done` frame tears the stream down; `unsubscribe()` aborts cleanly;
 * and a connection refusal reports `onError` WITHOUT throwing (graceful degrade).
 *
 * @task T11936
 * @epic T11916
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeSseRecord, subscribeOrchestrateEvents } from '../sse-client.js';

/** Encode a frame as the gateway does: `id: <seq>\ndata: <json>\n\n`. */
function encode(frame: GatewayStreamEvent): string {
  return `id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`;
}

let server: http.Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

/** Start a server that streams the given frames then ends. */
function startServer(frames: GatewayStreamEvent[]): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write(encode(f));
      // Frames include a terminal done/error in tests that want teardown; if not,
      // end the socket so `onClose` fires.
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server?.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('decodeSseRecord (T11936)', () => {
  it('decodes a `data:`-only record into a typed frame', () => {
    const frame: GatewayStreamEvent = { kind: 'data', seq: 0, data: { line: 'x' }, requestId: 'r' };
    const decoded = decodeSseRecord(`id: 0\ndata: ${JSON.stringify(frame)}`);
    expect(decoded).toEqual(frame);
  });

  it('returns null for a comment/keepalive record', () => {
    expect(decodeSseRecord(': keepalive')).toBeNull();
  });

  it('returns null for an unparseable or wrong-shape payload', () => {
    expect(decodeSseRecord('data: {not json')).toBeNull();
    expect(decodeSseRecord('data: {"kind":"bogus","seq":0}')).toBeNull();
    expect(decodeSseRecord('data: {"kind":"data"}')).toBeNull(); // missing seq
  });
});

describe('subscribeOrchestrateEvents — live reader (T11936)', () => {
  it('forwards each decoded frame in order and closes on done', async () => {
    const frames: GatewayStreamEvent[] = [
      { kind: 'data', seq: 0, data: { line: 'a' }, requestId: 'r' },
      { kind: 'data', seq: 1, data: { line: 'b' }, requestId: 'r' },
      { kind: 'done', seq: 2, data: {}, requestId: 'r' },
    ];
    const baseUrl = await startServer(frames);
    const received: GatewayStreamEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      subscribeOrchestrateEvents(
        { baseUrl, taskId: 'T1' },
        {
          onFrame: (f) => received.push(f),
          onError: (reason) => reject(new Error(reason)),
          onClose: () => resolve(),
        },
      );
    });

    expect(received.map((f) => f.kind)).toEqual(['data', 'data', 'done']);
    expect(received.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it('handles a frame split across two chunks (buffering)', async () => {
    const frame: GatewayStreamEvent = {
      kind: 'data',
      seq: 0,
      data: { line: 'split' },
      requestId: 'r',
    };
    const done: GatewayStreamEvent = { kind: 'done', seq: 1, data: {}, requestId: 'r' };
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const wire = encode(frame) + encode(done);
      // Write the wire in two halves to exercise the record buffer.
      const mid = Math.floor(wire.length / 2);
      res.write(wire.slice(0, mid));
      setTimeout(() => {
        res.write(wire.slice(mid));
        res.end();
      }, 5);
    });
    const baseUrl: string = await new Promise((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const port = (server?.address() as AddressInfo).port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    const received: GatewayStreamEvent[] = [];
    await new Promise<void>((resolve) => {
      subscribeOrchestrateEvents(
        { baseUrl },
        { onFrame: (f) => received.push(f), onClose: () => resolve() },
      );
    });
    expect(received.map((f) => f.kind)).toEqual(['data', 'done']);
  });

  it('reports onError WITHOUT throwing when the daemon is unreachable', async () => {
    let reason = '';
    await new Promise<void>((resolve) => {
      subscribeOrchestrateEvents(
        { baseUrl: 'http://127.0.0.1:1' }, // never a server
        {
          onFrame: () => {},
          onError: (r) => {
            reason = r;
            resolve();
          },
        },
      );
    });
    expect(reason.length).toBeGreaterThan(0);
  });

  it('unsubscribe() aborts the stream without delivering further frames', async () => {
    // A server that keeps the connection open indefinitely.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(encode({ kind: 'data', seq: 0, data: { tick: 0 }, requestId: 'r' }));
      // Never end — the subscription must tear it down.
    });
    const baseUrl: string = await new Promise((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const port = (server?.address() as AddressInfo).port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    let frames = 0;
    const sub = subscribeOrchestrateEvents({ baseUrl }, { onFrame: () => frames++ });
    // Allow the first frame through, then unsubscribe.
    await new Promise((r) => setTimeout(r, 30));
    const before = frames;
    sub.unsubscribe();
    sub.unsubscribe(); // idempotent — second call is a no-op.
    await new Promise((r) => setTimeout(r, 30));
    expect(frames).toBe(before); // no frames after unsubscribe.
  });

  it('reports an error on a non-2xx status', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const baseUrl: string = await new Promise((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const port = (server?.address() as AddressInfo).port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    let reason = '';
    await new Promise<void>((resolve) => {
      subscribeOrchestrateEvents(
        { baseUrl },
        {
          onFrame: () => {},
          onError: (r) => {
            reason = r;
          },
          onClose: () => resolve(),
        },
      );
    });
    expect(reason).toContain('503');
  });
});
