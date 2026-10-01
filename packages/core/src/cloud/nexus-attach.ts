/**
 * Attach this machine's copy of a project to Cleo Nexus and report its
 * presence: steps 3 to 5 of `cleo project link` with a device credential
 * (cleo-nexus device contract §3.6, §3.7).
 *
 * 1. `ensureProjectReplica` binds the canonical project store to a replica
 *    once (no `sync.*` flag is set, so capture, push and pull stay off) and
 *    returns its id.
 * 2. `POST /v1/projects/:projectId/replicas {deviceId, replicaId}` pins that
 *    replica to this Nexus device. The pin never moves: a 409 `replica-copied`
 *    whose holder is a revoked device of the same user means this machine was
 *    re-enrolled, so the store rebinds (`device-reenrolled`) and the new id is
 *    attached; any other holder is a genuinely copied store and fails with
 *    `E_NEXUS_REPLICA_COPIED`.
 * 3. `PUT /v1/projects/:projectId/replicas/:replicaId/presence` sends the
 *    path-free presence ({@link toReplicaPresence}) built from a local git
 *    probe. A presence failure is a warning: the attach already stands.
 *
 * Nothing here sends a path, a hostname or a secret.
 *
 * @task T12905
 * @epic T12323
 */

import type { NexusFleetLocation, NexusReplicaAttachment } from '@cleocode/contracts';
import { ReplicaPresence } from '@cleocode/contracts/cloud';
import { z } from 'zod';
import { probeGitState } from '../nexus/git-state.js';
import { type FetchLike, Http, NexusError } from './http.js';
import { NexusAccountError } from './nexus-auth.js';
import { toReplicaPresence } from './presence.js';

/** Timeout of each attach or presence call. */
export const NEXUS_ATTACH_TIMEOUT_MS = 15_000;

/** The store binding the attach needs: bind once, and rebind on a re-enrolled device. */
export interface ProjectReplicaBinder {
  /** Bind the store if it is unbound; return the active replica id. */
  ensure(): Promise<{ replicaId: string; reboundFrom?: string }>;
  /** Retire the active replica and mint a new id (contract §3.7, R6). */
  rebindReenrolled(): Promise<{ replicaId: string; previousReplicaId: string }>;
}

/** Options for {@link attachProjectReplica}. */
export interface AttachProjectReplicaOptions {
  /** Resolved API origin. */
  apiUrl: string;
  /** The device credential's bearer token (never logged). */
  bearer: string;
  /** This machine's Nexus device id. */
  deviceId: string;
  /** The server's project id. */
  projectId: string;
  /** Project root, for the local git probe only (never sent). */
  projectRoot: string;
  /** CLEO version reported in presence. */
  cliVersion: string;
  /** Store binding; defaults to the canonical project store ({@link canonicalReplicaBinder}). */
  binder?: ProjectReplicaBinder;
  /** `fetch` override. */
  fetch?: FetchLike;
  /** Clock, for the presence observation time when git cannot be probed. */
  now?: () => Date;
  /** Per-call timeout; default {@link NEXUS_ATTACH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const attachAnswer = z.looseObject({ replicaId: z.string() });
const presenceAnswer = z.looseObject({ presenceAt: z.string() });

/**
 * The binder over the canonical project store: opens it through the
 * dual-scope chokepoint (never a raw file) and binds in live mode.
 *
 * @param projectRoot - Project root whose `.cleo/cleo.db` holds the replica.
 * @returns A binder for {@link attachProjectReplica}.
 */
export function canonicalReplicaBinder(projectRoot: string): ProjectReplicaBinder {
  const open = async () => {
    const { openDualScopeDb, getDualScopeNativeDb } = await import('../store/dual-scope-db.js');
    const handle = await openDualScopeDb('project', projectRoot);
    return { db: getDualScopeNativeDb(handle), dbPath: handle.dbPath };
  };
  return {
    async ensure() {
      const { ensureProjectReplica } = await import('../store/sync/replica.js');
      const { db, dbPath } = await open();
      return ensureProjectReplica(db, { dbPath, mode: 'live' });
    },
    async rebindReenrolled() {
      const { rebindReplica } = await import('../store/sync/replica.js');
      const { db, dbPath } = await open();
      return rebindReplica(db, { dbPath, scope: 'project', mode: 'live' }, 'device-reenrolled');
    },
  };
}

/** True for the 409 the contract answers when this machine's own revoked device holds the replica. */
function isReenrolledHolder(err: unknown): boolean {
  return (
    err instanceof NexusError &&
    err.status === 409 &&
    err.details?.['holderState'] === 'revoked' &&
    err.details?.['holderSameUser'] === true
  );
}

/** The local git state as a presence body; never throws (a failed probe sends no git block). */
async function presenceBody(opts: AttachProjectReplicaOptions, replicaId: string) {
  const now = opts.now ?? (() => new Date());
  const git = await probeGitState({
    projectId: opts.projectId,
    deviceId: opts.deviceId,
    path: opts.projectRoot,
  });
  const location: NexusFleetLocation = {
    deviceId: opts.deviceId,
    replicaId,
    hostname: null,
    current: true,
    path: opts.projectRoot,
    state: 'live',
    lastSeen: now().toISOString(),
    git:
      git.probeErrorCode !== null && git.gitRoot === null
        ? null
        : {
            branch: git.branch,
            headSha: git.headSha,
            headCommittedAt: git.headCommittedAt,
            detached: git.detached,
            dirtyCount: git.dirtyCount,
            untrackedCount: git.untrackedCount,
            remote: {
              name: git.remoteName,
              url: git.remoteUrl,
              upstream: git.upstream,
              headSha: git.remoteHeadSha,
              ahead: git.ahead,
              behind: git.behind,
              fetchedAt: git.remoteFetchedAt,
              stale: git.remoteStale,
            },
            probedAt: git.probedAt,
            probeStale: false,
            probeErrorCode: git.probeErrorCode,
            probeError: git.probeError,
          },
    flags: [],
  };
  return toReplicaPresence(location, {
    deviceId: opts.deviceId,
    hostname: null,
    os: null,
    arch: null,
    cleoVersion: opts.cliVersion,
    lastHeartbeatAt: null,
    heartbeatStale: false,
    current: true,
  });
}

/**
 * Attach the project store's replica to this Nexus device and report its
 * presence (contract §3.6 steps 3 to 5). Idempotent: a repeat attaches the
 * same replica id (200) and re-sends presence.
 *
 * @param opts - Origin, credential, ids, project root and test overrides.
 * @returns The attachment and any warnings (a failed presence report).
 * @throws {NexusAccountError} `E_NEXUS_REPLICA_COPIED` when another live
 *   device or another user holds this replica id; an API error from the
 *   attach otherwise (mapped by the caller).
 */
export async function attachProjectReplica(
  opts: AttachProjectReplicaOptions,
): Promise<{ replica: NexusReplicaAttachment; warnings: string[] }> {
  const binder = opts.binder ?? canonicalReplicaBinder(opts.projectRoot);
  const timeoutMs = opts.timeoutMs ?? NEXUS_ATTACH_TIMEOUT_MS;
  const base = opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const http = new Http({
    baseUrl: opts.apiUrl,
    token: opts.bearer,
    deviceId: opts.deviceId,
    fetch: (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    maxAttempts: 2,
  });
  const path = `/v1/projects/${encodeURIComponent(opts.projectId)}/replicas`;
  const attach = (replicaId: string) =>
    http.request('POST', path, attachAnswer, { deviceId: opts.deviceId, replicaId });

  const bound = await binder.ensure();
  let replicaId = bound.replicaId;
  let reboundFrom = bound.reboundFrom ?? null;
  try {
    await attach(replicaId);
  } catch (err) {
    if (!isReenrolledHolder(err)) {
      if (err instanceof NexusError && err.status === 409) {
        throw new NexusAccountError(
          'E_NEXUS_REPLICA_COPIED',
          `this project's store (replica ${replicaId}) is already attached from another device: it was copied from another machine or account`,
          'a copied store must take a new replica id before it syncs; keep only one copy linked, or ask for help with `cleo doctor`',
        );
      }
      throw err;
    }
    const rebound = await binder.rebindReenrolled();
    replicaId = rebound.replicaId;
    reboundFrom = rebound.previousReplicaId;
    await attach(replicaId);
  }

  const warnings: string[] = [];
  let presenceAt: string | null = null;
  try {
    const body = ReplicaPresence.parse(await presenceBody(opts, replicaId));
    const answer = await http.request(
      'PUT',
      `${path}/${encodeURIComponent(replicaId)}/presence`,
      presenceAnswer,
      body,
    );
    presenceAt = answer.presenceAt;
  } catch (err) {
    warnings.push(
      `the project is attached, but its presence report failed (${err instanceof Error ? err.message : String(err)}); re-run \`cleo project link\` to send it`,
    );
  }
  return {
    replica: { replicaId, deviceId: opts.deviceId, reboundFrom, presenceAt },
    warnings,
  };
}
