/**
 * Tests for the Node-side LLM-queue admit gate (T11630).
 *
 * Covers the THREE load-bearing paths:
 *   1. mode `off` (default) → `{ admitted: true, via: 'direct' }`, no IPC.
 *   2. mode `supervisor`, NO socket → degrade to direct (the headline correctness
 *      risk: the daemon is OFF by default, so EVERY call must work without it).
 *   3. mode `supervisor`, a stub arbiter socket → `admitted` passes through and a
 *      `deferred` answer triggers a back-off + re-request (AC4 — never dropped).
 *
 * All in-process (a `node:net` Unix-socket stub stands in for the Rust
 * `cleo-supervisor` arbiter) — NO subprocess (tsx is unresolvable in CI).
 *
 * @task T11630
 * @epic T11625
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEASE_IPC_PROTOCOL_VERSION,
  LeaseIpcRequestEnvelopeSchema,
  type QueueAdmitDisposition,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLlmQueueStateForTest,
  llmQueueAdmit,
  resolveLlmQueueMode,
} from '../llm-queue-admit.js';

/**
 * A minimal stub of the Rust supervisor arbiter over a real Unix socket: it
 * decodes each `queue_admit` request envelope and replies with a scripted
 * `queue_admit_result` (admitted, or deferred-then-admitted). Records the
 * requests it saw so a test can assert the re-request behaviour.
 */
function startStubArbiter(
  socketPath: string,
  script: (n: number) => { disposition: QueueAdmitDisposition; retryAfterMs: number },
): Promise<{ server: Server; requestCount: () => number; close: () => Promise<void> }> {
  let count = 0;
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const env = LeaseIpcRequestEnvelopeSchema.parse(JSON.parse(raw));
          count += 1;
          const decision = script(count);
          const response = {
            protocol_version: LEASE_IPC_PROTOCOL_VERSION,
            id: env.id,
            direction: 'response' as const,
            response: {
              kind: 'queue_admit_result' as const,
              disposition: decision.disposition,
              retry_after_ms: decision.retryAfterMs,
              tokens_remaining: 100,
              queue_position: decision.disposition === 'deferred' ? 1 : 0,
            },
          };
          socket.write(`${JSON.stringify(response)}\n`);
          nl = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => {
        /* client closed mid-flight — non-fatal for the stub */
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        server,
        requestCount: () => count,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe('resolveLlmQueueMode (T11630)', () => {
  beforeEach(() => {
    _resetLlmQueueStateForTest();
    delete process.env.CLEO_LLM_QUEUE_MODE;
  });
  afterEach(() => {
    _resetLlmQueueStateForTest();
    delete process.env.CLEO_LLM_QUEUE_MODE;
  });

  it('defaults to off when unset', () => {
    expect(resolveLlmQueueMode()).toBe('off');
  });

  it('resolves supervisor only for the exact string', () => {
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    expect(resolveLlmQueueMode()).toBe('supervisor');
  });

  it('an unknown value falls back to off', () => {
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'bogus';
    expect(resolveLlmQueueMode()).toBe('off');
  });
});

describe('llmQueueAdmit (T11630)', () => {
  let tmp: string;

  beforeEach(() => {
    _resetLlmQueueStateForTest();
    delete process.env.CLEO_LLM_QUEUE_MODE;
    delete process.env.CLEO_SUPERVISOR_SOCKET;
    tmp = mkdtempSync(join(tmpdir(), 'llm-queue-admit-'));
  });
  afterEach(() => {
    _resetLlmQueueStateForTest();
    delete process.env.CLEO_LLM_QUEUE_MODE;
    delete process.env.CLEO_SUPERVISOR_SOCKET;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('mode off (default) → admitted directly with NO IPC', async () => {
    const result = await llmQueueAdmit('anthropic', 'background', 1024, 'child-1');
    expect(result).toEqual({ admitted: true, via: 'direct' });
  });

  // ── THE headline correctness path ──────────────────────────────────────────
  it('mode supervisor with NO socket → degrades to direct (daemon-OFF safety)', async () => {
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    const missingSocket = join(tmp, 'does-not-exist.sock');
    const result = await llmQueueAdmit('anthropic', 'lead', 1024, 'child-1', {
      socketPath: missingSocket,
      deadlineMs: 5_000,
    });
    // No supervisor → the call MUST proceed (admitted), never blocked or dropped.
    expect(result.admitted).toBe(true);
    expect(result.via).toBe('direct');
  });

  it('mode supervisor, arbiter admits → via supervisor', async () => {
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    const socketPath = join(tmp, 'arb.sock');
    const arb = await startStubArbiter(socketPath, () => ({
      disposition: 'admitted',
      retryAfterMs: 0,
    }));
    try {
      const result = await llmQueueAdmit('anthropic', 'lead', 1024, 'child-1', { socketPath });
      expect(result).toEqual({ admitted: true, via: 'supervisor' });
      expect(arb.requestCount()).toBe(1);
    } finally {
      await arb.close();
    }
  });

  it('mode supervisor, deferred-then-admitted → backs off + re-requests (AC4, never dropped)', async () => {
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    const socketPath = join(tmp, 'arb.sock');
    // First request → deferred (small back-off), second → admitted.
    const arb = await startStubArbiter(socketPath, (n) =>
      n === 1
        ? { disposition: 'deferred', retryAfterMs: 5 }
        : { disposition: 'admitted', retryAfterMs: 0 },
    );
    try {
      const result = await llmQueueAdmit('anthropic', 'worker', 1024, 'child-1', {
        socketPath,
        deadlineMs: 5_000,
      });
      expect(result).toEqual({ admitted: true, via: 'supervisor' });
      // The first deferral forced a re-request — proof the wait was structured.
      expect(arb.requestCount()).toBe(2);
    } finally {
      await arb.close();
    }
  });

  it('mode supervisor, perpetually deferred past the deadline → degrades to direct (advisory budget)', async () => {
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    const socketPath = join(tmp, 'arb.sock');
    const arb = await startStubArbiter(socketPath, () => ({
      disposition: 'deferred',
      retryAfterMs: 5,
    }));
    try {
      const result = await llmQueueAdmit('anthropic', 'background', 1024, 'child-1', {
        socketPath,
        // Tiny deadline so the perpetual-defer loop exits fast and proceeds.
        deadlineMs: 30,
      });
      // Past the deadline a real call must not starve — proceed directly.
      expect(result.admitted).toBe(true);
      expect(result.via).toBe('direct');
      expect(arb.requestCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await arb.close();
    }
  });

  it('mode supervisor, arbiter answers E_LEASE_UNAVAILABLE → degrades to direct', async () => {
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    _resetLlmQueueStateForTest();
    process.env.CLEO_LLM_QUEUE_MODE = 'supervisor';
    const socketPath = join(tmp, 'arb.sock');
    // A stub that replies with the v1.1 error frame (arbiter not wired).
    const server = await new Promise<Server>((resolve, reject) => {
      const s = createServer((socket: Socket) => {
        socket.on('data', (chunk) => {
          const raw = chunk.toString('utf8').split('\n')[0] ?? '';
          const env = LeaseIpcRequestEnvelopeSchema.parse(JSON.parse(raw));
          socket.write(
            `${JSON.stringify({
              protocol_version: LEASE_IPC_PROTOCOL_VERSION,
              id: env.id,
              direction: 'response',
              response: {
                kind: 'error',
                code: 'E_LEASE_UNAVAILABLE',
                message: 'supervisor lease arbiter is not enabled',
              },
            })}\n`,
          );
        });
        socket.on('error', () => {});
      });
      s.on('error', reject);
      s.listen(socketPath, () => resolve(s));
    });
    try {
      const result = await llmQueueAdmit('anthropic', 'lead', 1024, 'child-1', { socketPath });
      expect(result.admitted).toBe(true);
      expect(result.via).toBe('direct');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
