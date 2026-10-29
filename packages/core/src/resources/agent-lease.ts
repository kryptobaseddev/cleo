/**
 * Agent-session leases (T14133): a packet `orchestrate spawn` hands its prompt
 * to a harness and exits, so no process holds an `agent-session` slot while
 * the spawned session runs. A lease is that hold, kept as a file under the
 * governor's lock directory: it is counted against the `agent-session` budget
 * until the spawned session ends, its spawn is abandoned, or it expires.
 *
 * The lease follows the task claim's life: it is renewed by the session's
 * activity heartbeat, with the claim lease, and lapses when the session goes
 * quiet for a claim lease length.
 *
 * @task T14133
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '../paths.js';

/** One packet spawn's hold on an `agent-session` slot. */
export interface AgentSessionLease {
  /** Lease id (uuid); also its file name. */
  readonly id: string;
  /** The spawned task. */
  readonly taskId: string;
  /** The project the task belongs to. */
  readonly projectRoot: string;
  /** The spawned session, once allocated. */
  readonly sessionId: string | null;
  /** When it was taken (epoch ms). */
  readonly takenAtMs: number;
  /** When it lapses unless renewed (epoch ms). */
  readonly expiresAtMs: number;
}

/** Where leases live: beside the `agent-session` slot locks, machine-wide. */
export function agentLeaseDir(): string {
  return join(getCleoHome(), 'locks', 'resource-agent-session', 'leases');
}

function leasePath(id: string): string {
  return join(agentLeaseDir(), `${id}.json`);
}

function isLease(v: unknown): v is AgentSessionLease {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l['id'] === 'string' &&
    typeof l['taskId'] === 'string' &&
    typeof l['projectRoot'] === 'string' &&
    (l['sessionId'] === null || typeof l['sessionId'] === 'string') &&
    typeof l['takenAtMs'] === 'number' &&
    typeof l['expiresAtMs'] === 'number'
  );
}

function readLeases(): AgentSessionLease[] {
  const dir = agentLeaseDir();
  if (!existsSync(dir)) return [];
  const leases: AgentSessionLease[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const v: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (isLease(v)) leases.push(v);
    } catch {
      // A torn or foreign file is no lease.
    }
  }
  return leases;
}

/**
 * The leases still held at `nowMs`. Expired ones are removed as they are
 * found, so an abandoned spawn frees its slot once its lease lapses.
 *
 * @param nowMs - The clock.
 */
export function liveAgentLeases(nowMs: number = Date.now()): AgentSessionLease[] {
  const live: AgentSessionLease[] = [];
  for (const lease of readLeases()) {
    if (lease.expiresAtMs > nowMs) live.push(lease);
    else rmSync(leasePath(lease.id), { force: true });
  }
  return live;
}

/**
 * Write (or overwrite) a lease.
 *
 * @param lease - The lease.
 */
export function writeAgentLease(lease: AgentSessionLease): void {
  mkdirSync(agentLeaseDir(), { recursive: true });
  writeFileSync(leasePath(lease.id), `${JSON.stringify(lease)}\n`);
}

/**
 * Give a lease back (idempotent).
 *
 * @param id - The lease id.
 */
export function releaseAgentLease(id: string): void {
  rmSync(leasePath(id), { force: true });
}

/**
 * Give back every lease a session holds: the session ended or its spawn was
 * abandoned.
 *
 * @param sessionId - The spawned session.
 * @returns How many leases were released.
 */
export function releaseAgentLeasesForSession(sessionId: string): number {
  let released = 0;
  for (const lease of readLeases()) {
    if (lease.sessionId !== sessionId) continue;
    releaseAgentLease(lease.id);
    released++;
  }
  return released;
}

/**
 * Extend every live lease a session holds to `expiresAtMs` (its activity
 * heartbeat, with the claim lease).
 *
 * @param sessionId - The spawned session.
 * @param expiresAtMs - The new expiry.
 * @returns How many leases were renewed.
 */
export function renewAgentLeasesForSession(sessionId: string, expiresAtMs: number): number {
  let renewed = 0;
  for (const lease of liveAgentLeases()) {
    if (lease.sessionId !== sessionId || lease.expiresAtMs >= expiresAtMs) continue;
    writeAgentLease({ ...lease, expiresAtMs });
    renewed++;
  }
  return renewed;
}
