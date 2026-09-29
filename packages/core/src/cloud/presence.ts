/**
 * Replica presence mapper (T12721): one fleet-view location → the path-free
 * `ReplicaPresence` the cleo-nexus cloud accepts at
 * `PUT /v1/projects/:projectId/replicas/:replicaId/presence`.
 *
 * Pure: no I/O, no clock. Everything the contract marks **device-local, never
 * mirrored** — path, hostname, remote name and URL, upstream ref, HEAD and
 * upstream commit shas, probe error text — is read only to derive a boolean,
 * a count or an enum, and never copied. `branch` is copied only when the
 * caller opts in.
 *
 * @task T12721
 * @epic T12496
 */

import {
  NEXUS_FLEET_SCHEMA_VERSION,
  type NexusFleetDevice,
  type NexusFleetGitSummary,
  type NexusFleetLocation,
} from '@cleocode/contracts';
import type { ReplicaPresence } from '@cleocode/contracts/cloud';

/** The `git` block of a {@link ReplicaPresence}. */
export type ReplicaPresenceGit = NonNullable<ReplicaPresence['git']>;

/** The remote tracking state a presence reports. */
export type ReplicaRemoteState = ReplicaPresenceGit['remote'];

/** Server-side length limits of `ReplicaPresence` string fields. */
export const REPLICA_PRESENCE_LIMITS = {
  /** `git.branch` maximum length. */
  branchMax: 200,
  /** `cliVersion` maximum length. */
  cliVersionMax: 40,
} as const;

/** `cliVersion` sent when the device never reported its CLEO version. */
export const UNKNOWN_CLI_VERSION = 'unknown';

/** Options for {@link toReplicaPresence}. */
export interface ToReplicaPresenceOptions {
  /** Include the checked-out branch (truncated to 200). Default `false`: branch names can be sensitive. */
  includeBranch?: boolean;
  /** Presence schema version. Default {@link NEXUS_FLEET_SCHEMA_VERSION}. */
  schemaVersion?: number;
}

/**
 * Remote tracking state of one probe row, as the presence enum.
 *
 * - probe error → `unknown` (nothing the probe reported can be trusted as whole);
 * - no upstream → `no-upstream`;
 * - never fetched (`fetchedAt` null) → `unknown`;
 * - otherwise from ahead/behind as of the last fetch: both → `diverged`,
 *   ahead only → `ahead`, behind only → `behind`, neither → `in-sync`.
 *
 * @param git - Recorded git summary of the location.
 * @returns The presence remote state.
 * @example
 * ```ts
 * replicaRemoteState(summary); // 'behind'
 * ```
 */
export function replicaRemoteState(git: NexusFleetGitSummary): ReplicaRemoteState {
  if (git.probeErrorCode !== null) return 'unknown';
  if (git.remote.upstream === null) return 'no-upstream';
  if (git.remote.fetchedAt === null) return 'unknown';
  const ahead = git.remote.ahead ?? 0;
  const behind = git.remote.behind ?? 0;
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'in-sync';
}

/**
 * Map one fleet-view location on one device to the cloud `ReplicaPresence`.
 *
 * - `observedAt` is the probe instant (`git.probedAt`); an unprobed location
 *   has no `git` block and reports when it was last encountered (`lastSeen`).
 * - `cliVersion` is `device.cleoVersion` truncated to 40, or `unknown`.
 * - `git.dirty` is `(dirtyCount ?? 0) + (untrackedCount ?? 0) > 0`;
 *   `ahead`/`behind` default to 0; `remote` is {@link replicaRemoteState};
 *   `lastCommitAt` is `headCommittedAt` when known; `branch` only with
 *   `includeBranch`, truncated to 200.
 *
 * The replica id is not part of the body: it is the `:replicaId` path
 * segment (`location.replicaId`), and a caller must not send presence while
 * it is `null`.
 *
 * @param location - The location, from `nexus.projects.fleet`.
 * @param device - The device holding it (same `deviceId`).
 * @param opts - Branch opt-in and schema version.
 * @returns A path-free presence body.
 * @throws Error when `device.deviceId` differs from `location.deviceId`.
 * @example
 * ```ts
 * const body = toReplicaPresence(loc, device, { includeBranch: false });
 * ```
 */
export function toReplicaPresence(
  location: NexusFleetLocation,
  device: NexusFleetDevice,
  opts: ToReplicaPresenceOptions = {},
): ReplicaPresence {
  if (device.deviceId !== location.deviceId) {
    throw new Error(
      `toReplicaPresence: device ${device.deviceId} does not hold this location (device ${location.deviceId})`,
    );
  }
  const presence: ReplicaPresence = {
    cliVersion: truncate(
      device.cleoVersion ?? UNKNOWN_CLI_VERSION,
      REPLICA_PRESENCE_LIMITS.cliVersionMax,
    ),
    schemaVersion: opts.schemaVersion ?? NEXUS_FLEET_SCHEMA_VERSION,
    observedAt: toUtcIso(location.git?.probedAt ?? location.lastSeen) ?? location.lastSeen,
  };
  const git = location.git;
  if (git === null) return presence;

  const block: ReplicaPresenceGit = {
    dirty: (git.dirtyCount ?? 0) + (git.untrackedCount ?? 0) > 0,
    ahead: git.remote.ahead ?? 0,
    behind: git.remote.behind ?? 0,
    remote: replicaRemoteState(git),
  };
  if (opts.includeBranch === true && git.branch !== null) {
    block.branch = truncate(git.branch, REPLICA_PRESENCE_LIMITS.branchMax);
  }
  const lastCommitAt = git.headCommittedAt === null ? undefined : toUtcIso(git.headCommittedAt);
  if (lastCommitAt !== undefined) block.lastCommitAt = lastCommitAt;
  presence.git = block;
  return presence;
}

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An instant as ISO 8601 UTC (`Z`), or `undefined` when unparsable. */
function toUtcIso(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
