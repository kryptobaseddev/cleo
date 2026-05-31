/**
 * CLI-RPC transport adapter tests (R3-T5 · T11449).
 *
 * Asserts:
 *  1. The NDJSON codec decodes a valid request frame, and emits the correct
 *     protocol-level error frame for parse errors, bad versions, malformed
 *     frames, and wrong-direction frames — the supervisor-ipc framing pattern
 *     applied to gateway frames.
 *  2. The LineBuffer reassembles arbitrary chunk boundaries into complete lines.
 *  3. routeFrame maps a request frame → a `source: 'rpc'` DispatchRequest routed
 *     through the injected GatewayHandler, FORCING source even if the client
 *     lied, and traps thrown handler errors as E_RPC_INTERNAL frames.
 *  4. A full unix-socket round-trip: encode → socket → decode → dispatch →
 *     response frame, proving no behavior change across transports.
 *
 * The core logger factory is mocked so the adapter can be exercised without
 * initializing the real pino transport.
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import {
  GATEWAY_RPC_PROTOCOL_VERSION,
  type GatewayRpcErrorFrame,
  type GatewayRpcFrame,
  type GatewayRpcRequestFrame,
  type GatewayRpcResponseFrame,
} from '@cleocode/contracts/gateway/rpc';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { GatewayHandler } from '../../index.js';

vi.mock('@cleocode/core', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { decodeLine, encodeFrame, LineBuffer } = await import('../codec.js');
const { routeFrame, startRpcServer } = await import('../server.js');

/** A reusable valid request frame builder. */
function requestFrame(overrides?: Partial<DispatchRequest>): GatewayRpcRequestFrame {
  return {
    protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
    id: 'req-1',
    direction: 'request',
    request: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      params: { id: 'T1' },
      source: 'rpc',
      requestId: 'req-1',
      ...overrides,
    },
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

describe('R3-T5 RPC codec — NDJSON decode (supervisor-ipc pattern)', () => {
  it('decodes a valid request frame', () => {
    const line = JSON.stringify(requestFrame());
    const result = decodeLine(line);
    expect(result.kind).toBe('request');
    if (result.kind === 'request') {
      expect(result.frame.request.operation).toBe('show');
    }
  });

  it('emits E_RPC_PARSE for invalid JSON', () => {
    const result = decodeLine('{not json');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.frame.error.code).toBe('E_RPC_PARSE');
      expect(result.frame.id).toBe('0');
    }
  });

  it('emits E_RPC_BAD_VERSION for a mismatched protocol version (and correlates the id)', () => {
    const frame = requestFrame();
    const bad = { ...frame, protocol_version: '2.0.0' };
    const result = decodeLine(JSON.stringify(bad));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.frame.error.code).toBe('E_RPC_BAD_VERSION');
      expect(result.frame.id).toBe('req-1');
    }
  });

  it('emits E_RPC_BAD_FRAME for a schema-invalid frame', () => {
    const result = decodeLine(JSON.stringify({ id: 'x', direction: 'request', request: {} }));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.frame.error.code).toBe('E_RPC_BAD_FRAME');
      expect(result.frame.id).toBe('x');
    }
  });

  it('rejects a non-request direction reaching the server', () => {
    const responseFrame = {
      protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
      id: 'r',
      direction: 'response',
      response: {
        meta: {
          gateway: 'query',
          domain: 'tasks',
          operation: 'show',
          timestamp: 't',
          duration_ms: 1,
          source: 'rpc',
          requestId: 'r',
        },
        success: true,
      },
    };
    const result = decodeLine(JSON.stringify(responseFrame));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.frame.error.code).toBe('E_RPC_BAD_FRAME');
    }
  });
});

describe('R3-T5 RPC codec — LineBuffer chunk reassembly', () => {
  it('yields complete lines across arbitrary chunk boundaries', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(buf.push('2}\n')).toEqual(['{"b":2}']);
  });

  it('skips blank lines and buffers a partial trailing line', () => {
    const buf = new LineBuffer();
    expect(buf.push('\n\n{"a":1}')).toEqual([]);
    expect(buf.push('\n')).toEqual(['{"a":1}']);
  });
});

describe('R3-T5 RPC routeFrame — gateway routing', () => {
  it('maps a request frame → source:rpc DispatchRequest through the handler', async () => {
    const { handler, calls } = fakeHandler();
    const out = await routeFrame(handler, requestFrame());
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe('rpc');
    expect(calls[0].domain).toBe('tasks');
    expect(out.direction).toBe('response');
    if (out.direction === 'response') {
      expect((out as GatewayRpcResponseFrame).response.success).toBe(true);
    }
  });

  it('FORCES source to rpc even when the client claims a different transport', async () => {
    const { handler, calls } = fakeHandler();
    // Build a frame whose request.source lies as 'cli'.
    const frame = requestFrame({ source: 'cli' });
    await routeFrame(handler, frame);
    expect(calls[0].source).toBe('rpc');
  });

  it('renders a thrown handler error as an E_RPC_INTERNAL frame (no throw / no exit)', async () => {
    const handler: GatewayHandler = { handle: () => Promise.reject(new Error('boom')) };
    const out = await routeFrame(handler, requestFrame());
    expect(out.direction).toBe('error');
    if (out.direction === 'error') {
      expect((out as GatewayRpcErrorFrame).error.code).toBe('E_RPC_INTERNAL');
      expect((out as GatewayRpcErrorFrame).error.message).toContain('boom');
    }
  });
});

describe('R3-T5 RPC server — full unix-socket round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-rpc-'));
  const socketPath = join(dir, 'gw.sock');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('encode → socket → decode → dispatch → response frame', async () => {
    const { handler, calls } = fakeHandler();
    const srv = await startRpcServer(handler, { socketPath });
    try {
      const response = await roundTrip(socketPath, requestFrame());
      expect(response.direction).toBe('response');
      if (response.direction === 'response') {
        expect(response.id).toBe('req-1');
        expect(response.response.success).toBe(true);
        expect(response.response.meta.source).toBe('rpc');
      }
      expect(calls).toHaveLength(1);
      expect(calls[0].source).toBe('rpc');
    } finally {
      await srv.close();
    }
  });
});

/**
 * Open the socket, write one NDJSON request frame, and resolve with the first
 * response frame the server writes back.
 */
function roundTrip(socketPath: string, frame: GatewayRpcRequestFrame): Promise<GatewayRpcFrame> {
  return new Promise<GatewayRpcFrame>((resolve, reject) => {
    const client = connect(socketPath);
    const buf = new LineBuffer();
    client.setEncoding('utf8');
    client.on('connect', () => {
      client.write(`${JSON.stringify(frame)}\n`);
    });
    client.on('data', (chunk: string) => {
      for (const line of buf.push(chunk)) {
        client.end();
        resolve(JSON.parse(line) as GatewayRpcFrame);
        return;
      }
    });
    client.on('error', reject);
  });
}
