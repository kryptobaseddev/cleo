/**
 * Tests for the PARALLEL `lease-ipc` v1.1 NDJSON codec (T11894 / ST-5).
 *
 * Mirrors the v1.0 `SupervisorIpcClient` codec tests (registry.test.ts) — the
 * v1.1 client encodes versioned, correlated request lines and rejects malformed
 * inbound frames with a typed {@link MalformedLeaseIpcFrameError} rather than
 * silently dropping them.
 *
 * @task T11894
 */

import { LEASE_IPC_PROTOCOL_VERSION } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { createLeaseIpcClient, MalformedLeaseIpcFrameError } from '../lease-ipc-client.js';

describe('LeaseIpcClient NDJSON codec (T11894 ST-5)', () => {
  it('encodes a lease_acquire request as a versioned, correlated NDJSON line', () => {
    const client = createLeaseIpcClient();
    const { id, line } = client.encodeRequest({
      kind: 'lease_acquire',
      scope: 'project',
      lane: 'tasks',
      holder_id: 'pid-42:tasks',
      priority: 0,
      ttl_ms: 30_000,
      reentrant: true,
    });

    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.protocol_version).toBe(LEASE_IPC_PROTOCOL_VERSION);
    expect(parsed.protocol_version).toBe('1.1.0');
    expect(parsed.direction).toBe('request');
    expect(parsed.id).toBe(id);
    expect(parsed.request.kind).toBe('lease_acquire');
    expect(parsed.request.scope).toBe('project');
    expect(parsed.request.lane).toBe('tasks');
    expect(parsed.request.holder_id).toBe('pid-42:tasks');
    expect(parsed.request.reentrant).toBe(true);
  });

  it('stamps a fresh correlation id per request', () => {
    const client = createLeaseIpcClient();
    const a = client.encodeRequest({
      kind: 'lease_release',
      scope: 'project',
      lane: 'tasks',
      holder_id: 'h',
      epoch: 1,
    });
    const b = client.encodeRequest({
      kind: 'lease_release',
      scope: 'project',
      lane: 'tasks',
      holder_id: 'h',
      epoch: 1,
    });
    expect(a.id).not.toBe(b.id);
  });

  it('decodes a well-formed lease_granted response envelope', () => {
    const client = createLeaseIpcClient();
    const wire = JSON.stringify({
      protocol_version: '1.1.0',
      id: 'abc',
      direction: 'response',
      response: {
        kind: 'lease_granted',
        scope: 'project',
        lane: 'tasks',
        holder_id: 'pid-42:tasks',
        epoch: 7,
        ttl_ms: 30_000,
        expires_at_ms: 1_000_030_000,
      },
    });
    const env = client.decodeResponseLine(wire);
    expect(env.direction).toBe('response');
    expect(env.response.kind).toBe('lease_granted');
    if (env.response.kind === 'lease_granted') {
      expect(env.response.epoch).toBe(7);
    }
  });

  it('decodes an unsolicited child_killed_unresponsive event', () => {
    const client = createLeaseIpcClient();
    const wire = JSON.stringify({
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
    });
    const env = client.decodeResponseLine(wire);
    expect(env.response.kind).toBe('child_killed_unresponsive');
  });

  it('decodes a deferred-handler E_LEASE_UNIMPLEMENTED error', () => {
    const client = createLeaseIpcClient();
    const wire = JSON.stringify({
      protocol_version: '1.1.0',
      id: 'rate-1',
      direction: 'response',
      response: { kind: 'error', code: 'E_LEASE_UNIMPLEMENTED', message: 'deferred handler' },
    });
    const env = client.decodeResponseLine(wire);
    expect(env.response.kind).toBe('error');
    if (env.response.kind === 'error') {
      expect(env.response.code).toBe('E_LEASE_UNIMPLEMENTED');
    }
  });

  it('rejects a non-JSON line with a typed MalformedLeaseIpcFrameError (never silently dropped)', () => {
    const client = createLeaseIpcClient();
    expect(() => client.decodeResponseLine('{not json')).toThrow(MalformedLeaseIpcFrameError);
  });

  it('rejects a schema-violating frame with a typed MalformedLeaseIpcFrameError', () => {
    const client = createLeaseIpcClient();
    const bad = JSON.stringify({
      protocol_version: '1.1.0',
      id: 'abc',
      direction: 'response',
      response: { kind: 'bogus' },
    });
    let caught: unknown;
    try {
      client.decodeResponseLine(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedLeaseIpcFrameError);
    expect((caught as MalformedLeaseIpcFrameError).line).toBe(bad);
  });
});
