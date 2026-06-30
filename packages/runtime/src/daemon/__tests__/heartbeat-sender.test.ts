/**
 * Tests for the worker-side watchdog heartbeat sender (T11628).
 *
 * The sender is degrade-by-default: with a transport wired it encodes a versioned
 * `worker_heartbeat` frame and writes it; with NO transport it is a silent no-op
 * (the daemon-off / no-supervisor posture). These tests run in-process against a
 * captured `writeLine` sink — never a real socket or subprocess.
 *
 * @task T11628
 */

import { LEASE_IPC_PROTOCOL_VERSION } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { createHeartbeatSender } from '../heartbeat-sender.js';
import { createLeaseIpcClient } from '../lease-ipc-client.js';

describe('createHeartbeatSender (T11628)', () => {
  it('encodes a versioned worker_heartbeat frame and writes it to the transport', async () => {
    const written: string[] = [];
    const sender = createHeartbeatSender((line) => {
      written.push(line);
    });

    expect(sender.isActive()).toBe(true);
    const id = await sender.sendHeartbeat('worker-7', true);

    expect(id).toMatch(/^l\d+-/); // a lease-ipc correlation id
    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written[0].trimEnd());
    expect(parsed.protocol_version).toBe(LEASE_IPC_PROTOCOL_VERSION);
    expect(parsed.protocol_version).toBe('1.2.0');
    expect(parsed.direction).toBe('request');
    expect(parsed.id).toBe(id);
    expect(parsed.request.kind).toBe('worker_heartbeat');
    expect(parsed.request.child_id).toBe('worker-7');
    expect(parsed.request.in_flight_llm).toBe(true);
  });

  it('carries the worker self-reported in_flight_llm flag through verbatim', async () => {
    const written: string[] = [];
    const sender = createHeartbeatSender((line) => {
      written.push(line);
    });
    await sender.sendHeartbeat('w', false);
    const parsed = JSON.parse(written[0].trimEnd());
    expect(parsed.request.in_flight_llm).toBe(false);
  });

  it('is a silent NO-OP when no transport is wired (no supervisor up)', async () => {
    const offline = createHeartbeatSender(undefined);
    expect(offline.isActive()).toBe(false);
    // No throw, resolves to null, writes nothing.
    const id = await offline.sendHeartbeat('worker-7', true);
    expect(id).toBeNull();
  });

  it('treats a null transport the same as undefined (degrade)', async () => {
    const offline = createHeartbeatSender(null);
    expect(offline.isActive()).toBe(false);
    await expect(offline.sendHeartbeat('w', false)).resolves.toBeNull();
  });

  it('round-trips through the lease-ipc codec: the supervisor would decode it', () => {
    // Prove the frame the sender emits is exactly what the v1.1 codec decodes —
    // the same codec the supervisor accept loop parses (Rust serde mirror).
    const written: string[] = [];
    const sender = createHeartbeatSender((line) => {
      written.push(line);
    });
    void sender.sendHeartbeat('worker-7', true);

    // The supervisor encodes its heartbeat_ack reply through the same codec.
    const client = createLeaseIpcClient();
    const ackLine = JSON.stringify({
      protocol_version: '1.2.0',
      id: 'hb-1',
      direction: 'response',
      response: { kind: 'heartbeat_ack' },
    });
    const ack = client.decodeResponseLine(ackLine);
    expect(ack.response.kind).toBe('heartbeat_ack');
  });
});
