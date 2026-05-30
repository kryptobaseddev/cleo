/**
 * Schema-drift guard for the FROZEN `supervisor-ipc` v1.0 contract (T11339 AC5).
 *
 * Pins the v1.0 protocol version and the exact request/response message-kind
 * set. If a future change adds, removes, or renames a message kind without
 * bumping to a new contract revision, these assertions fail — forcing an
 * explicit, reviewed decision rather than silent drift that would break R2
 * (T11253).
 *
 * Also asserts the Rust wire shape (snake_case keys, `direction` + `kind`
 * discriminators) round-trips through the Zod schemas, proving the TypeScript
 * and Rust sides agree on the same bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_IPC_MESSAGE_KINDS,
  SUPERVISOR_IPC_PROTOCOL_VERSION,
  SUPERVISOR_IPC_REQUEST_KINDS,
  SUPERVISOR_IPC_RESPONSE_KINDS,
  SupervisorIpcEnvelopeSchema,
  SupervisorIpcRequestSchema,
  SupervisorIpcResponseSchema,
} from '../index.js';

describe('supervisor-ipc v1.0 freeze guard (T11339)', () => {
  it('pins the frozen protocol version', () => {
    expect(SUPERVISOR_IPC_PROTOCOL_VERSION).toBe('1.0.0');
  });

  it('pins the exact frozen request kind set', () => {
    expect([...SUPERVISOR_IPC_REQUEST_KINDS]).toEqual(['spawn', 'restart', 'monitor', 'health']);
  });

  it('pins the exact frozen response kind set', () => {
    expect([...SUPERVISOR_IPC_RESPONSE_KINDS]).toEqual([
      'spawned',
      'restarted',
      'monitor',
      'health',
      'event',
      'error',
    ]);
  });

  it('the union schemas cover exactly the frozen kinds', () => {
    // Every frozen request kind must validate against the request union.
    for (const kind of SUPERVISOR_IPC_REQUEST_KINDS) {
      const sample = sampleRequestFor(kind);
      expect(SupervisorIpcRequestSchema.safeParse(sample).success).toBe(true);
    }
    for (const kind of SUPERVISOR_IPC_RESPONSE_KINDS) {
      const sample = sampleResponseFor(kind);
      expect(SupervisorIpcResponseSchema.safeParse(sample).success).toBe(true);
    }
    expect(SUPERVISOR_IPC_MESSAGE_KINDS).toHaveLength(
      SUPERVISOR_IPC_REQUEST_KINDS.length + SUPERVISOR_IPC_RESPONSE_KINDS.length,
    );
  });

  // T11369 (R2 AC8/AC9) — pin the EXACT complete message-kind tuple. Any
  // in-place add/rename/remove to the v1.0 set fails here, forcing a new
  // versioned directory + version-negotiation shim per the contract-evolution
  // policy (doc slug `daemon-ipc-contract-evolution-policy`) rather than silent
  // drift that would break R4-R7 adapters.
  it('pins the EXACT complete frozen message-kind set (T11369)', () => {
    expect([...SUPERVISOR_IPC_MESSAGE_KINDS]).toEqual([
      'spawn',
      'restart',
      'monitor',
      'health',
      'spawned',
      'restarted',
      'monitor',
      'health',
      'event',
      'error',
    ]);
  });
});

describe('supervisor-ipc v1.0 wire-shape parity with Rust serde (T11339 AC3)', () => {
  it('parses the exact JSON a Rust request envelope serializes', () => {
    // This is the literal JSON shape produced by
    // cleo_supervisor::ipc::IpcEnvelope::request(...).to_ndjson().
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'request',
      request: {
        kind: 'spawn',
        child_id: 'w1',
        program: '/usr/bin/node',
        args: ['build/index.js'],
        env: [{ key: 'PORT', value: '3456' }],
        cwd: '/srv/studio',
      },
    };
    const parsed = SupervisorIpcEnvelopeSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.direction === 'request') {
      expect(parsed.data.request.kind).toBe('spawn');
    }
  });

  it('parses the exact JSON a Rust response envelope serializes', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'response',
      response: {
        kind: 'health',
        pid: 100,
        child_count: 1,
        uptime_secs: 60,
        protocol_version: '1.0.0',
      },
    };
    const parsed = SupervisorIpcEnvelopeSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
  });

  it('parses a Rust lifecycle event with the optional restart_delay_ms field', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'evt-1',
      direction: 'response',
      response: {
        kind: 'event',
        event: 'child_restarted',
        child_id: 'w1',
        exit_code: 1,
        restart_delay_ms: 2000,
      },
    };
    expect(SupervisorIpcEnvelopeSchema.safeParse(wire).success).toBe(true);
  });

  it('rejects an unknown message kind (proves the union is closed)', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'request',
      request: { kind: 'teleport', child_id: 'w1' },
    };
    expect(SupervisorIpcEnvelopeSchema.safeParse(wire).success).toBe(false);
  });
});

/** Build a minimal valid request payload for the given kind. */
function sampleRequestFor(kind: (typeof SUPERVISOR_IPC_REQUEST_KINDS)[number]): unknown {
  switch (kind) {
    case 'spawn':
      return { kind, child_id: 'w1', program: '/bin/true', args: [], env: [] };
    case 'restart':
      return { kind, child_id: 'w1' };
    case 'monitor':
      return { kind };
    case 'health':
      return { kind };
  }
}

/** Build a minimal valid response payload for the given kind. */
function sampleResponseFor(kind: (typeof SUPERVISOR_IPC_RESPONSE_KINDS)[number]): unknown {
  switch (kind) {
    case 'spawned':
      return { kind, child_id: 'w1', pid: 1 };
    case 'restarted':
      return { kind, child_id: 'w1', pid: 1, restart_count: 1 };
    case 'monitor':
      return { kind, children: [] };
    case 'health':
      return { kind, pid: 1, child_count: 0, uptime_secs: 1, protocol_version: '1.0.0' };
    case 'event':
      return { kind, event: 'child_exited', child_id: 'w1' };
    case 'error':
      return { kind, code: 'E_X', message: 'x' };
  }
}
