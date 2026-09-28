/**
 * Holder identity for the per-task worktree lock (T12506 · epic T12498).
 *
 * `@cleocode/worktree` takes an atomic per-task lock before `git worktree add`
 * and records who holds it. It cannot import core, so the spawn pipeline
 * resolves the identity here — the spawned agent's own session + agent id, the
 * stable device id, and the long-lived OWNER process (the agent harness above
 * the short-lived `cleo` + shell) with its `ps` start time — and passes it in
 * `CreateWorktreeOptions.holder`.
 *
 * @module spawn/worktree-lock-holder
 * @task T12506
 */

import type { WorktreeLockHolder } from '@cleocode/contracts';
import { getStableDeviceId } from '../llm/stable-device-id.js';
import { type ProcessAncestor, resolveOwnerProcess } from '../sessions/terminal-identity.js';

/** Inputs for {@link resolveSpawnLockHolder}. */
export interface SpawnLockHolderInput {
  /** The spawned agent's per-agent session id. */
  sessionId?: string | null;
  /** The spawned agent's agent id. */
  agentId?: string | null;
  /** Owner-process resolver (tests inject fakes). */
  resolveOwner?: () => ProcessAncestor | null;
  /** Device-id reader (tests inject fakes). */
  deviceId?: () => string;
}

/**
 * Build the {@link WorktreeLockHolder} for a spawn.
 *
 * Falls back to the current process (pid + start probed by the worktree
 * package) when the owner chain cannot be read, e.g. on Windows.
 *
 * @param input - Session/agent identity and test seams.
 * @returns The holder identity to record in the lock.
 */
export function resolveSpawnLockHolder(input: SpawnLockHolderInput = {}): WorktreeLockHolder {
  const owner = (input.resolveOwner ?? resolveOwnerProcess)();
  let deviceId: string | null = null;
  try {
    deviceId = (input.deviceId ?? getStableDeviceId)();
  } catch {
    deviceId = null;
  }
  return {
    sessionId: input.sessionId ?? null,
    agentId: input.agentId ?? null,
    deviceId,
    ...(owner ? { pid: owner.pid, processStartedAt: owner.startedAt } : {}),
  };
}
