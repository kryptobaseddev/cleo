/**
 * CLI-RPC round-trip micro-benchmark (R3-T5 · T11449 · AC4).
 *
 * Measures the end-to-end latency of the NDJSON encode → unix-socket → decode →
 * dispatch → response path against a trivial fake handler, isolating the
 * TRANSPORT cost (framing + socket I/O + zod validation) from any real domain
 * work. Asserts a generous ceiling so the bench stays green in slow CI yet
 * still fails on a pathological regression (e.g. accidental per-frame sync
 * fs work). The measured mean is logged to stderr for the PR report.
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
import { GATEWAY_RPC_PROTOCOL_VERSION } from '@cleocode/contracts/gateway/rpc';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { GatewayHandler } from '../../index.js';

vi.mock('@cleocode/core', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// T11640 — stub the connection-session handle imports the RPC server now uses.
vi.mock('@cleocode/core/internal', () => ({
  bindConnectionSession: vi.fn(),
  unbindConnectionSession: vi.fn(),
  runWithConnectionHandle: <T>(_connId: string, fn: () => T): T => fn(),
}));

const { LineBuffer } = await import('../codec.js');
const { startRpcServer } = await import('../server.js');

/** A trivial echo handler — isolates transport cost from domain work. */
const handler: GatewayHandler = {
  handle(req: DispatchRequest): Promise<DispatchResponse> {
    return Promise.resolve({
      meta: {
        gateway: req.gateway,
        domain: req.domain,
        operation: req.operation,
        timestamp: '2026-05-31T00:00:00.000Z',
        duration_ms: 0,
        source: req.source,
        requestId: req.requestId,
      },
      success: true,
      data: { ok: true },
    });
  },
};

describe('R3-T5 RPC round-trip micro-benchmark (AC4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-rpc-bench-'));
  const socketPath = join(dir, 'bench.sock');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serial round-trips stay under the transport latency ceiling', async () => {
    const srv = await startRpcServer(handler, { socketPath });
    const ITERATIONS = 500;
    try {
      // Single persistent connection — the warm-daemon usage pattern.
      const client = connect(socketPath);
      const buf = new LineBuffer();
      await new Promise<void>((resolve, reject) => {
        client.setEncoding('utf8');
        client.once('connect', resolve);
        client.once('error', reject);
      });

      // A pending-resolver queue keyed by FIFO order (serial requests).
      const pending: Array<() => void> = [];
      client.on('data', (chunk: string) => {
        for (const _line of buf.push(chunk)) {
          const resolveNext = pending.shift();
          if (resolveNext) resolveNext();
        }
      });

      const start = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i++) {
        await new Promise<void>((resolve) => {
          pending.push(resolve);
          const frame = {
            protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
            id: `b-${i}`,
            direction: 'request',
            request: {
              gateway: 'query',
              domain: 'tasks',
              operation: 'show',
              params: { id: 'T1' },
              source: 'rpc',
              requestId: `b-${i}`,
            },
          };
          client.write(`${JSON.stringify(frame)}\n`);
        });
      }
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const meanMs = elapsedNs / 1e6 / ITERATIONS;
      client.end();

      // Report for the PR body.
      process.stderr.write(
        `\n[T11449 AC4] RPC round-trip mean: ${meanMs.toFixed(4)} ms/op over ${ITERATIONS} serial ops (single warm connection)\n`,
      );

      // Generous ceiling: a unix-socket round-trip with zod validate should be
      // well under 5ms even on slow CI; a regression to sync-fs-per-frame blows past this.
      expect(meanMs).toBeLessThan(5);
    } finally {
      await srv.close();
    }
  });
});
