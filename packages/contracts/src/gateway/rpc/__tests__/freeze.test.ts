/**
 * Schema-drift guard for the FROZEN `gateway/rpc` v1.0 contract (T11449 AC).
 *
 * Pins the v1.0 protocol version, the exact `direction` discriminator set, and
 * the protocol-level transport error codes. If a future change adds, removes,
 * or renames a direction/error code without bumping to a new contract revision,
 * these assertions fail — forcing an explicit, reviewed decision rather than
 * silent drift that would break the CLI-RPC adapter and its clients.
 *
 * Also asserts the NDJSON frame round-trips through the Zod schemas, proving
 * the framing discipline borrowed from `supervisor-ipc` (versioned, correlated
 * envelope discriminated by `direction`, one frame per line) holds for the
 * gateway-dispatch payload.
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 */

import { describe, expect, it } from 'vitest';
import {
  GATEWAY_RPC_CHANNEL_BASENAME,
  GATEWAY_RPC_DIRECTIONS,
  GATEWAY_RPC_ERROR_CODES,
  GATEWAY_RPC_PROTOCOL_VERSION,
  GatewayRpcFrameSchema,
  isFrozenGatewayRpcVersion,
} from '../index.js';

describe('gateway/rpc v1.0 freeze guard (T11449)', () => {
  it('pins the frozen protocol version', () => {
    expect(GATEWAY_RPC_PROTOCOL_VERSION).toBe('1.0.0');
  });

  it('pins the default channel basename', () => {
    expect(GATEWAY_RPC_CHANNEL_BASENAME).toBe('cleo-gateway-rpc');
  });

  it('pins the EXACT frozen direction set', () => {
    expect([...GATEWAY_RPC_DIRECTIONS]).toEqual(['request', 'response', 'error']);
  });

  it('pins the EXACT frozen protocol-level error-code set', () => {
    expect([...GATEWAY_RPC_ERROR_CODES]).toEqual([
      'E_RPC_PARSE',
      'E_RPC_BAD_VERSION',
      'E_RPC_BAD_FRAME',
      'E_RPC_INTERNAL',
    ]);
  });

  it('isFrozenGatewayRpcVersion accepts only the frozen version', () => {
    expect(isFrozenGatewayRpcVersion('1.0.0')).toBe(true);
    expect(isFrozenGatewayRpcVersion('2.0.0')).toBe(false);
    expect(isFrozenGatewayRpcVersion('0.9.0')).toBe(false);
  });
});

describe('gateway/rpc v1.0 NDJSON frame round-trip', () => {
  it('parses a request frame wrapping a source:rpc DispatchRequest', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'request',
      request: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        params: { id: 'T1' },
        source: 'rpc',
        requestId: 'abc',
      },
    };
    const parsed = GatewayRpcFrameSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.direction === 'request') {
      expect(parsed.data.request.source).toBe('rpc');
      expect(parsed.data.request.operation).toBe('show');
    }
  });

  it('parses a response frame wrapping a LAFS DispatchResponse', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'response',
      response: {
        meta: {
          gateway: 'query',
          domain: 'tasks',
          operation: 'show',
          timestamp: '2026-05-31T00:00:00.000Z',
          duration_ms: 1,
          source: 'rpc',
          requestId: 'abc',
        },
        success: true,
        data: { id: 'T1' },
      },
    };
    expect(GatewayRpcFrameSchema.safeParse(wire).success).toBe(true);
  });

  it('parses a protocol-level error frame', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: '0',
      direction: 'error',
      error: { code: 'E_RPC_BAD_VERSION', message: 'unsupported protocol version' },
    };
    expect(GatewayRpcFrameSchema.safeParse(wire).success).toBe(true);
  });

  it('rejects an unknown direction (proves the union is closed)', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'teleport',
      request: {},
    };
    expect(GatewayRpcFrameSchema.safeParse(wire).success).toBe(false);
  });

  it('rejects a request frame whose source is NOT rpc-shaped enum member', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'request',
      request: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        source: 'carrier-pigeon',
        requestId: 'abc',
      },
    };
    expect(GatewayRpcFrameSchema.safeParse(wire).success).toBe(false);
  });
});
