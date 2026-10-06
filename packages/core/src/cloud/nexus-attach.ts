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
  /**
   * `cleo project link --rebind`: retire the store's replica and mint a new id
   * before attaching. The remedy when the old id is held by another device:
   * this machine's revoked device after a re-enrolment (when the server cannot
   * say so itself), or the original of a copied store.
   */
  rebind?: boolean;
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

/**
 * The binder over the global store (`<cleoHome>/cleo.db`): binds its
 * global-scope replica, the one the account's `home:` stream knows this
 * device's main brain by (T12952).
 *
 * @returns A binder for {@link attachHomeReplica}.
 */
export function canonicalGlobalReplicaBinder(): ProjectReplicaBinder {
  const open = async () => {
    const { openDualScopeDb, getDualScopeNativeDb } = await import('../store/dual-scope-db.js');
    const handle = await openDualScopeDb('global');
    return { db: getDualScopeNativeDb(handle), dbPath: handle.dbPath };
  };
  return {
    async ensure() {
      const { ensureGlobalReplica } = await import('../store/sync/replica.js');
      const { db, dbPath } = await open();
      return ensureGlobalReplica(db, { dbPath, mode: 'live' });
    },
    async rebindReenrolled() {
      const { rebindReplica } = await import('../store/sync/replica.js');
      const { db, dbPath } = await open();
      return rebindReplica(db, { dbPath, scope: 'global', mode: 'live' }, 'device-reenrolled');
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
  return attachReplicaAt(
    {
      ...opts,
      binder: opts.binder ?? canonicalReplicaBinder(opts.projectRoot),
      what: "this project's store",
      relink: '`cleo project link`',
      kind: 'project',
    },
    `/v1/projects/${encodeURIComponent(opts.projectId)}/replicas`,
    (replicaId) => presenceBody(opts, replicaId),
  );
}

/** Options for {@link sendProjectPresence}. */
export interface SendProjectPresenceOptions
  extends Omit<AttachProjectReplicaOptions, 'binder' | 'rebind'> {
  /** The replica already attached from this device (the link's `replicaId`). */
  replicaId: string;
}

/**
 * Re-send an attached replica's presence only (contract §3.6 step 5), without
 * re-attaching: the periodic refresh (T13289). Same path-free body as the
 * attach ({@link toReplicaPresence} over a local git probe).
 *
 * @param opts - Origin, device credential, ids, project root and overrides.
 * @returns The server's `presenceAt`.
 * @throws An API or network error; the caller treats it as best-effort.
 */
export async function sendProjectPresence(
  opts: SendProjectPresenceOptions,
): Promise<{ presenceAt: string }> {
  const timeoutMs = opts.timeoutMs ?? NEXUS_ATTACH_TIMEOUT_MS;
  const base = opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const http = new Http({
    baseUrl: opts.apiUrl,
    token: opts.bearer,
    deviceId: opts.deviceId,
    fetch: (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    maxAttempts: 1,
  });
  const body = ReplicaPresence.parse(await presenceBody(opts, opts.replicaId));
  return http.request(
    'PUT',
    `/v1/projects/${encodeURIComponent(opts.projectId)}/replicas/${encodeURIComponent(opts.replicaId)}/presence`,
    presenceAnswer,
    body,
  );
}

/** Options for {@link attachHomeReplica}. */
export interface AttachHomeReplicaOptions
  extends Omit<AttachProjectReplicaOptions, 'projectId' | 'projectRoot'> {}

/**
 * Attach this device's global store (the main brain) to the account's
 * `home:` stream and report its presence (T12952; cleo-nexus T084): the
 * same rules as {@link attachProjectReplica}, on `/v1/account/home/replicas`.
 * Presence carries no git block (the global store is not a repository).
 *
 * @param opts - Origin, credential, ids and test overrides.
 * @returns The attachment and any warnings.
 * @throws {NexusAccountError} `E_NEXUS_REPLICA_COPIED`, or an API error.
 */
export async function attachHomeReplica(
  opts: AttachHomeReplicaOptions,
): Promise<{ replica: NexusReplicaAttachment; warnings: string[] }> {
  return attachReplicaAt(
    {
      ...opts,
      binder: opts.binder ?? canonicalGlobalReplicaBinder(),
      what: 'your global CLEO store',
      relink: '`cleo login nexus`',
      kind: 'home',
    },
    '/v1/account/home/replicas',
    (replicaId) =>
      toReplicaPresence(
        {
          deviceId: opts.deviceId,
          replicaId,
          hostname: null,
          current: true,
          path: '',
          state: 'live',
          lastSeen: (opts.now ?? (() => new Date()))().toISOString(),
          git: null,
          flags: [],
        },
        {
          deviceId: opts.deviceId,
          hostname: null,
          os: null,
          arch: null,
          cleoVersion: opts.cliVersion,
          lastHeartbeatAt: null,
          heartbeatStale: false,
          current: true,
        },
      ),
  );
}

/** Shared attach flow over one replicas collection path. */
async function attachReplicaAt(
  opts: Omit<AttachProjectReplicaOptions, 'projectId' | 'projectRoot'> & {
    binder: ProjectReplicaBinder;
    /** What the store is called in messages. */
    what: string;
    /** The command that re-runs the attach. */
    relink: string;
    /** Which store this is: decides the remedy of a copied-store refusal. */
    kind: 'project' | 'home';
  },
  path: string,
  presenceOf: (replicaId: string) => unknown,
): Promise<{ replica: NexusReplicaAttachment; warnings: string[] }> {
  const binder = opts.binder;
  const timeoutMs = opts.timeoutMs ?? NEXUS_ATTACH_TIMEOUT_MS;
  const base = opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const http = new Http({
    baseUrl: opts.apiUrl,
    token: opts.bearer,
    deviceId: opts.deviceId,
    fetch: (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    maxAttempts: 2,
  });
  const attach = (replicaId: string) =>
    http.request('POST', path, attachAnswer, { deviceId: opts.deviceId, replicaId });

  const bound = await binder.ensure();
  let replicaId = bound.replicaId;
  let reboundFrom = bound.reboundFrom ?? null;
  if (opts.rebind === true) {
    const rebound = await binder.rebindReenrolled();
    replicaId = rebound.replicaId;
    // If ensure() already rebound a copy, the id that was last attached is
    // that earlier one: keep it as the reported previous id (review N3b).
    reboundFrom = reboundFrom ?? rebound.previousReplicaId;
  }
  try {
    await attach(replicaId);
  } catch (err) {
    if (!isReenrolledHolder(err)) {
      if (err instanceof NexusError && err.status === 409) {
        // The deployed server's 409 does not say who holds the replica
        // (no holderState/holderSameUser yet), so name both causes and the
        // one remedy that fixes either: a new replica id.
        throw new NexusAccountError(
          'E_NEXUS_REPLICA_COPIED',
          `${opts.what} (replica ${replicaId}) is already attached from another Nexus device: either this machine was re-enrolled as a new device (after a revoke), or the store was copied from another machine`,
          opts.kind === 'project'
            ? 'run `cleo project link --rebind` to give this copy a new replica id and attach it; if another machine holds the original, it keeps its own'
            : 'revoke the stale device on cleocode.dev, then run `cleo login nexus` again',
        );
      }
      throw err;
    }
    const rebound = await binder.rebindReenrolled();
    replicaId = rebound.replicaId;
    reboundFrom = rebound.previousReplicaId;
    try {
      await attach(replicaId);
    } catch (second) {
      throw new NexusAccountError(
        'E_NEXUS_REQUEST_FAILED',
        `this store was rebound from replica ${rebound.previousReplicaId} to ${replicaId} (this machine was re-enrolled), but attaching the new id failed: ${second instanceof Error ? second.message : String(second)}`,
        `re-run ${opts.relink} to finish the attach`,
      );
    }
  }

  const warnings: string[] = [];
  let presenceAt: string | null = null;
  try {
    const body = ReplicaPresence.parse(await presenceOf(replicaId));
    const answer = await http.request(
      'PUT',
      `${path}/${encodeURIComponent(replicaId)}/presence`,
      presenceAnswer,
      body,
    );
    presenceAt = answer.presenceAt;
  } catch (err) {
    warnings.push(
      `${opts.what} is attached, but its presence report failed (${err instanceof Error ? err.message : String(err)}); re-run ${opts.relink} to send it`,
    );
  }
  return {
    replica: { replicaId, deviceId: opts.deviceId, reboundFrom, presenceAt },
    warnings,
  };
}
