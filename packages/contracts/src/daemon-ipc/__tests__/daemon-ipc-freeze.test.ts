/**
 * Freeze + AC8-alias guard for the `@cleocode/contracts/daemon-ipc` surface
 * (T11369 — R2 gates R4-R7).
 *
 * Proves the AC8-named `daemon-ipc` barrel:
 * 1. resolves and re-exports the FROZEN supervisor-ipc v1.0 schemas + version,
 * 2. is byte-identical to the `supervisor-ipc` surface (one contract, two
 *    names — no duplicate drift surface),
 * 3. pins `DAEMON_IPC_PROTOCOL_VERSION === SUPERVISOR_IPC_PROTOCOL_VERSION ===
 *    '1.0.0'` and the complete frozen message-kind tuple.
 *
 * @task T11369
 */

import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_IPC_MESSAGE_KINDS,
  SUPERVISOR_IPC_PROTOCOL_VERSION,
  SupervisorIpcEnvelopeSchema as SupervisorEnvelopeFromRoot,
} from '../../supervisor-ipc/index.js';
import {
  DAEMON_IPC_PROTOCOL_VERSION,
  SUPERVISOR_IPC_MESSAGE_KINDS as MESSAGE_KINDS_VIA_DAEMON_IPC,
  SupervisorIpcEnvelopeSchema as SupervisorEnvelopeFromDaemonIpc,
  SUPERVISOR_IPC_PROTOCOL_VERSION as VERSION_VIA_DAEMON_IPC,
} from '../index.js';

describe('@cleocode/contracts/daemon-ipc AC8 alias surface (T11369)', () => {
  it('re-exports the SAME frozen schema binding as supervisor-ipc', () => {
    // Referential identity proves it is a re-export, not a duplicate schema.
    expect(SupervisorEnvelopeFromDaemonIpc).toBe(SupervisorEnvelopeFromRoot);
  });

  it('pins the frozen protocol version through both names', () => {
    expect(VERSION_VIA_DAEMON_IPC).toBe('1.0.0');
    expect(DAEMON_IPC_PROTOCOL_VERSION).toBe('1.0.0');
    expect(DAEMON_IPC_PROTOCOL_VERSION).toBe(SUPERVISOR_IPC_PROTOCOL_VERSION);
  });

  it('exposes the identical frozen message-kind set through the daemon-ipc name', () => {
    expect([...MESSAGE_KINDS_VIA_DAEMON_IPC]).toEqual([...SUPERVISOR_IPC_MESSAGE_KINDS]);
  });

  it('validates a real Rust wire envelope through the daemon-ipc schema', () => {
    const wire = {
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'request',
      request: { kind: 'health' },
    };
    expect(SupervisorEnvelopeFromDaemonIpc.safeParse(wire).success).toBe(true);
  });
});
