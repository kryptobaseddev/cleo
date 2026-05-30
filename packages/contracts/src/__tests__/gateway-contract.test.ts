/**
 * Contract snapshot + validation tests for the promoted gateway contract
 * (`@cleocode/contracts/gateway`).
 *
 * The gateway contract is the transport-agnostic CQRS dispatch shape that every
 * adapter (CLI, MCP, RPC, HTTP) shares. These tests pin:
 *   - the frozen contract version + the four canonical transport sources,
 *   - the zod schemas' accepted/rejected inputs at the (untrusted) transport
 *     boundary (AC8 — the reason the contract is zod-typed),
 *   - the public field shape of each schema as a snapshot, so an accidental
 *     add/remove/rename of a request/response field fails loudly.
 *
 * @epic T4820
 * @task T11446
 * @saga T11243
 */

import { describe, expect, it } from 'vitest';
import {
  dispatchErrorSchema,
  dispatchRequestSchema,
  dispatchResponseSchema,
  GATEWAY_CONTRACT_VERSION,
  GATEWAY_SOURCES,
  gatewaySourceSchema,
  gatewayStreamEventSchema,
} from '../gateway.js';

describe('gateway contract — version + sources', () => {
  it('pins the frozen contract version', () => {
    expect(GATEWAY_CONTRACT_VERSION).toBe('1.0.0');
  });

  it('declares exactly the four canonical transports', () => {
    expect([...GATEWAY_SOURCES]).toEqual(['cli', 'mcp', 'rpc', 'http']);
  });

  it('accepts every canonical transport and rejects unknown ones', () => {
    for (const s of GATEWAY_SOURCES) {
      expect(gatewaySourceSchema.safeParse(s).success).toBe(true);
    }
    expect(gatewaySourceSchema.safeParse('telepathy').success).toBe(false);
    expect(gatewaySourceSchema.safeParse('dispatch').success).toBe(false);
  });
});

describe('gateway contract — request validation (transport boundary)', () => {
  const minimal = {
    gateway: 'query',
    domain: 'tasks',
    operation: 'list',
    source: 'mcp',
    requestId: 'req_1',
  };

  it('validates a minimal well-formed request', () => {
    expect(dispatchRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it('validates a fully-populated request', () => {
    const full = {
      ...minimal,
      params: { parent: 'T1' },
      sessionId: 'ses_1',
      originSessionId: 'ses_0',
      executionSessionId: 'exe_1',
      _fields: ['/data/id'],
      _mvi: 'standard',
    };
    expect(dispatchRequestSchema.safeParse(full).success).toBe(true);
  });

  it('rejects a request missing required fields', () => {
    expect(dispatchRequestSchema.safeParse({ domain: 'tasks' }).success).toBe(false);
  });

  it('rejects an out-of-range _mvi level', () => {
    expect(dispatchRequestSchema.safeParse({ ...minimal, _mvi: 'verbose' }).success).toBe(false);
  });

  it('rejects an unknown transport source', () => {
    expect(dispatchRequestSchema.safeParse({ ...minimal, source: 'ftp' }).success).toBe(false);
  });
});

describe('gateway contract — response + error + stream shapes', () => {
  it('validates a success response (meta passthrough preserved)', () => {
    const res = {
      meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'list',
        timestamp: '2026-05-30T00:00:00.000Z',
        duration_ms: 1,
        source: 'cli',
        requestId: 'req_1',
        // extensible metadata via catchall:
        gateInfo: { passed: true },
      },
      success: true,
      data: { tasks: [] },
    };
    expect(dispatchResponseSchema.safeParse(res).success).toBe(true);
  });

  it('validates a structured error', () => {
    const err = {
      code: 'E_NOT_FOUND',
      message: 'no such task',
      exitCode: 4,
      alternatives: [{ action: 'search', command: 'cleo find' }],
    };
    expect(dispatchErrorSchema.safeParse(err).success).toBe(true);
  });

  it('validates a stream event', () => {
    expect(
      gatewayStreamEventSchema.safeParse({ kind: 'data', seq: 0, data: {}, requestId: 'req_1' })
        .success,
    ).toBe(true);
    expect(
      gatewayStreamEventSchema.safeParse({ kind: 'flush', seq: 0, requestId: 'r' }).success,
    ).toBe(false);
  });
});

describe('gateway contract — field-shape snapshot (drift guard)', () => {
  it('request fields are stable', () => {
    expect(Object.keys(dispatchRequestSchema.shape).sort()).toMatchInlineSnapshot(`
      [
        "_fields",
        "_mvi",
        "domain",
        "executionSessionId",
        "gateway",
        "operation",
        "originSessionId",
        "params",
        "requestId",
        "sessionId",
        "source",
      ]
    `);
  });

  it('response fields are stable', () => {
    expect(Object.keys(dispatchResponseSchema.shape).sort()).toMatchInlineSnapshot(`
      [
        "data",
        "error",
        "meta",
        "page",
        "partial",
        "success",
      ]
    `);
  });
});
