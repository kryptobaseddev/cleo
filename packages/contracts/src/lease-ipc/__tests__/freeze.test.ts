/**
 * Schema-drift guard for the `lease-ipc` v1.1 PARALLEL contract (T11627 ST-1).
 *
 * Pins the v1.1 protocol version and the exact request/response message-kind
 * set. If a future change adds, removes, or renames a message kind without a
 * coordinated dual (Rust + TS) edit, these assertions fail — forcing an
 * explicit, reviewed decision rather than silent drift across the Rust/TS wire.
 *
 * Also asserts the Rust wire shape (snake_case keys, `direction` + `kind`
 * discriminators, snake_case enum payloads) round-trips through the Zod schemas,
 * proving the TypeScript and Rust sides agree on the same bytes — the exact JSON
 * produced by `cleo_supervisor::lease_ipc::LeaseEnvelope::*::to_ndjson()`.
 */

import { describe, expect, it } from 'vitest';
import {
  isFrozenLeaseIpcVersion,
  LEASE_IPC_MESSAGE_KINDS,
  LEASE_IPC_PROTOCOL_VERSION,
  LEASE_IPC_REQUEST_KINDS,
  LEASE_IPC_RESPONSE_KINDS,
  LeaseIpcEnvelopeSchema,
  LeaseIpcRequestSchema,
  LeaseIpcResponseSchema,
} from '../index.js';

describe('lease-ipc v1.1 freeze guard (T11627)', () => {
  it('pins the parallel protocol version', () => {
    expect(LEASE_IPC_PROTOCOL_VERSION).toBe('1.1.0');
  });

  it('the version differs from the frozen supervisor-ipc v1.0 wire version', () => {
    // The two contracts are distinguished on the wire purely by this string;
    // it MUST NOT collide with '1.0.0'.
    expect(LEASE_IPC_PROTOCOL_VERSION).not.toBe('1.0.0');
    expect(isFrozenLeaseIpcVersion('1.1.0')).toBe(true);
    expect(isFrozenLeaseIpcVersion('1.0.0')).toBe(false);
  });

  it('pins the exact request kind set', () => {
    expect([...LEASE_IPC_REQUEST_KINDS]).toEqual([
      'lease_acquire',
      'lease_release',
      'lease_renew',
      'rate_check',
      'tool_grant',
      'queue_admit',
    ]);
  });

  it('pins the exact response kind set', () => {
    expect([...LEASE_IPC_RESPONSE_KINDS]).toEqual([
      'lease_granted',
      'lease_queued',
      'lease_denied',
      'rate_result',
      'tool_granted',
      'lease_revoked',
      'child_killed_unresponsive',
      'queue_admit_result',
      'error',
    ]);
  });

  it('the union schemas cover exactly the v1.1 kinds', () => {
    for (const kind of LEASE_IPC_REQUEST_KINDS) {
      const sample = sampleRequestFor(kind);
      expect(LeaseIpcRequestSchema.safeParse(sample).success).toBe(true);
    }
    for (const kind of LEASE_IPC_RESPONSE_KINDS) {
      const sample = sampleResponseFor(kind);
      expect(LeaseIpcResponseSchema.safeParse(sample).success).toBe(true);
    }
    expect(LEASE_IPC_MESSAGE_KINDS).toHaveLength(
      LEASE_IPC_REQUEST_KINDS.length + LEASE_IPC_RESPONSE_KINDS.length,
    );
  });

  it('pins the EXACT complete v1.1 message-kind set', () => {
    expect([...LEASE_IPC_MESSAGE_KINDS]).toEqual([
      'lease_acquire',
      'lease_release',
      'lease_renew',
      'rate_check',
      'tool_grant',
      'queue_admit',
      'lease_granted',
      'lease_queued',
      'lease_denied',
      'rate_result',
      'tool_granted',
      'lease_revoked',
      'child_killed_unresponsive',
      'queue_admit_result',
      'error',
    ]);
  });
});

describe('lease-ipc v1.1 wire-shape parity with Rust serde (T11627)', () => {
  it('parses the exact JSON a Rust lease_acquire request envelope serializes', () => {
    // Literal JSON shape produced by
    // cleo_supervisor::lease_ipc::LeaseEnvelope::request(...).to_ndjson().
    const wire = {
      protocol_version: '1.1.0',
      id: 'abc',
      direction: 'request',
      request: {
        kind: 'lease_acquire',
        scope: 'project',
        lane: 'tasks',
        holder_id: 'pid-42:tasks',
        priority: 0,
        ttl_ms: 30000,
        reentrant: true,
      },
    };
    const parsed = LeaseIpcEnvelopeSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.direction === 'request') {
      expect(parsed.data.request.kind).toBe('lease_acquire');
    }
  });

  it('parses the exact JSON a Rust lease_granted response envelope serializes', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'abc',
      direction: 'response',
      response: {
        kind: 'lease_granted',
        scope: 'global',
        lane: 'brain',
        holder_id: 'pid-42:brain',
        epoch: 7,
        ttl_ms: 30000,
        expires_at_ms: 1000030000,
      },
    };
    expect(LeaseIpcEnvelopeSchema.safeParse(wire).success).toBe(true);
  });

  it('parses a Rust child_killed_unresponsive event envelope', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'evt-1',
      direction: 'response',
      response: {
        kind: 'child_killed_unresponsive',
        child_id: 'worker-1',
        holder_id: 'pid-42:tasks',
        scope: 'project',
        reason: 'unresponsive past ttl',
      },
    };
    expect(LeaseIpcEnvelopeSchema.safeParse(wire).success).toBe(true);
  });

  it('parses a reused v1.0 error response shape ({ kind, code, message })', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'e',
      direction: 'response',
      response: { kind: 'error', code: 'E_LEASE_UNIMPLEMENTED', message: 'deferred handler' },
    };
    expect(LeaseIpcEnvelopeSchema.safeParse(wire).success).toBe(true);
  });

  it('parses the exact JSON a Rust queue_admit request envelope serializes (T11630)', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'qa-1',
      direction: 'request',
      request: {
        kind: 'queue_admit',
        provider: 'anthropic',
        priority_class: 'lead',
        est_tokens: 1024,
        child_id: 'worker-1',
      },
    };
    const parsed = LeaseIpcEnvelopeSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.direction === 'request') {
      expect(parsed.data.request.kind).toBe('queue_admit');
    }
  });

  it('parses the exact JSON a Rust queue_admit_result response envelope serializes (T11630)', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'qa-1',
      direction: 'response',
      response: {
        kind: 'queue_admit_result',
        disposition: 'deferred',
        retry_after_ms: 250,
        tokens_remaining: 0,
        queue_position: 2,
      },
    };
    expect(LeaseIpcEnvelopeSchema.safeParse(wire).success).toBe(true);
  });

  it('rejects an unknown message kind (proves the union is closed)', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'abc',
      direction: 'request',
      request: { kind: 'lease_teleport', scope: 'project', lane: 'tasks' },
    };
    expect(LeaseIpcEnvelopeSchema.safeParse(wire).success).toBe(false);
  });

  it('rejects an unknown scope/lane enum value (snake_case enums are closed)', () => {
    const wire = {
      protocol_version: '1.1.0',
      id: 'abc',
      direction: 'request',
      request: {
        kind: 'lease_acquire',
        scope: 'session',
        lane: 'tasks',
        holder_id: 'h',
        priority: 0,
        ttl_ms: 1,
        reentrant: false,
      },
    };
    expect(LeaseIpcEnvelopeSchema.safeParse(wire).success).toBe(false);
  });
});

/** Build a minimal valid request payload for the given kind. */
function sampleRequestFor(kind: (typeof LEASE_IPC_REQUEST_KINDS)[number]): unknown {
  switch (kind) {
    case 'lease_acquire':
      return {
        kind,
        scope: 'project',
        lane: 'tasks',
        holder_id: 'h',
        priority: 0,
        ttl_ms: 30000,
        reentrant: true,
      };
    case 'lease_release':
      return { kind, scope: 'project', lane: 'tasks', holder_id: 'h', epoch: 1 };
    case 'lease_renew':
      return { kind, scope: 'project', lane: 'tasks', holder_id: 'h', epoch: 1 };
    case 'rate_check':
      return { kind, scope: 'global', lane: 'bulk', est_bytes: 4096 };
    case 'tool_grant':
      return { kind, tool: 'browser', holder_id: 'h' };
    case 'queue_admit':
      return {
        kind,
        provider: 'anthropic',
        priority_class: 'lead',
        est_tokens: 1024,
        child_id: 'worker-1',
      };
  }
}

/** Build a minimal valid response payload for the given kind. */
function sampleResponseFor(kind: (typeof LEASE_IPC_RESPONSE_KINDS)[number]): unknown {
  switch (kind) {
    case 'lease_granted':
      return {
        kind,
        scope: 'project',
        lane: 'tasks',
        holder_id: 'h',
        epoch: 1,
        ttl_ms: 30000,
        expires_at_ms: 1000030000,
      };
    case 'lease_queued':
      return { kind, scope: 'project', lane: 'tasks', ticket: 1, ahead: 0 };
    case 'lease_denied':
      return { kind, scope: 'global', code: 'E_LEASE_UNAVAILABLE', message: 'no arbiter' };
    case 'rate_result':
      return { kind, scope: 'global', ok: true, retry_after_ms: 0, tokens_remaining: 10 };
    case 'tool_granted':
      return { kind, tool: 'browser', holder_id: 'h' };
    case 'lease_revoked':
      return { kind, scope: 'project', lane: 'tasks', holder_id: 'h', reason: 'ttl expired' };
    case 'child_killed_unresponsive':
      return { kind, child_id: 'w1', holder_id: 'h', scope: 'project', reason: 'unresponsive' };
    case 'queue_admit_result':
      return {
        kind,
        disposition: 'deferred',
        retry_after_ms: 250,
        tokens_remaining: 0,
        queue_position: 2,
      };
    case 'error':
      return { kind, code: 'E_X', message: 'x' };
  }
}
