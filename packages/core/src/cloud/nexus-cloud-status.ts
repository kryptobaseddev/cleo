/**
 * `cleo cloud status`: the agent's single verification call (cleo-nexus
 * device contract v2.15, §4.4, E3 `GET /v1/status`, §3.7).
 *
 * It reads local facts first (the device credential, the project, its
 * `.cleo/nexus-link.json` entry, the store's replica id), then asks E3, and
 * returns `{ verdict, summary, local, remote, warnings }`:
 *
 * - no credential: verdict `not-signed-in`, and no network call is made;
 * - the server's verdict is downgraded to `not-linked` when the current
 *   project has no local link entry or no bound replica;
 * - unreachable: `E_NEXUS_UNREACHABLE`, its `publicDetails` (the envelope's `error.details`) carrying `local` and a
 *   summary whose remote fields are null ({@link NexusCloudOfflineError});
 * - outside a project (or `--project` naming an unknown id) the device and
 *   account parts are still reported and the verdict comes from the device
 *   checks only.
 *
 * Every request is a GET. Getting the credential may still upgrade a 9.24
 * session (E1) and retry unsettled logouts (E9/E10), as every device-credential
 * command does (§3.4, §3.5). The replica id is read through
 * `activeReplica(db, 'project')` on a read-only snapshot handle
 * (`openCleoDbSnapshot`, no migrations, no pragmas): this command never binds
 * a replica or writes `cleo.db`. When the store cannot be read that way,
 * `replicaId` is `null` with `W_NEXUS_REPLICA_UNREADABLE` and the verdict is
 * `attention`, never `not-linked`: unknown is not unbound.
 *
 * A server without E3 (404 `E_NOT_FOUND` on `/v1/status`) gets the same
 * `NexusStatus` shape composed client-side from E2, E14 and E15 with the
 * contract's check and verdict rules, plus a `W_NEXUS_STATUS_COMPOSED`
 * warning.
 *
 * TODO(T12905): `cleo cloud status --report` (send presence before E3) is not
 * implemented here; it is the one write this command will gain.
 *
 * @task T12871
 * @epic T12323
 */

import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CloudStatusGlobalStore,
  CloudStatusLocal,
  CloudStatusOfflineDetails,
  CloudStatusResult,
  CloudStatusSummary,
  CloudStatusSync,
  CloudStatusSyncStream,
  CloudStatusVerdict,
  CloudSyncUnknown,
  CloudWarning,
  NexusCloudReplica,
  NexusCloudStatus,
  NexusCloudStatusCheck,
  NexusCloudWhoami,
} from '@cleocode/contracts';
import {
  NEXUS_PRESENCE_FRESH_SECONDS,
  nexusCloudProjectDetailSchema,
  nexusCloudStatusSchema,
  nexusCloudWhoamiSchema,
} from '@cleocode/contracts/nexus-cloud.js';
import { getCleoHome, resolveCleoDir } from '../paths.js';
import { NexusAccountError, resolveNexusApiUrl } from './nexus-auth.js';
import {
  assertNexusCloudDeviceMode,
  connectNexusCloud,
  currentNexusCloudProject,
  listNexusCloudReplicas,
  type NexusCloudConnection,
  type NexusCloudOptions,
  type NexusCloudProject,
  nexusQueryPath,
} from './nexus-cloud.js';
import { FileNexusTokenStore, type NexusTokenStore, nexusOriginKey } from './nexus-credentials.js';
import { NexusDeviceStore, UnreadableNexusDevice } from './nexus-device.js';
import { nexusHomeReplicaListSchema } from './nexus-home.js';
import { projectStream } from './streams.js';

/** Warning: the server has no E3, so the status was composed from E2, E14 and E15. */
export const W_NEXUS_STATUS_COMPOSED = 'W_NEXUS_STATUS_COMPOSED';

/** Warning: the current project has no `.cleo/nexus-link.json` entry for the origin. */
export const W_NEXUS_NOT_LINKED_LOCALLY = 'W_NEXUS_NOT_LINKED_LOCALLY';

/** Warning: the current project's store has no bound replica (or none could be read). */
export const W_NEXUS_NO_REPLICA = 'W_NEXUS_NO_REPLICA';

/** Warning: the store exists but could not be read read-only, so `replicaId` is null. */
export const W_NEXUS_REPLICA_UNREADABLE = 'W_NEXUS_REPLICA_UNREADABLE';

/** Warning: `--project` names an id the server does not show; only the device was checked. */
export const W_NEXUS_PROJECT_UNKNOWN = 'W_NEXUS_PROJECT_UNKNOWN';

/** Options for {@link getNexusCloudStatus}. */
export interface NexusCloudStatusOptions extends NexusCloudOptions {
  /** `--project`: the project to check; defaults to the current project. */
  projectId?: string;
  /** Clock for presence freshness when the status is composed (tests). */
  now?: () => Date;
}

/**
 * `E_NEXUS_UNREACHABLE` from `cleo cloud status`, carrying the local facts
 * (§4.4 "Offline"). Holds no secret.
 */
export class NexusCloudOfflineError extends NexusAccountError {
  /**
   * Local state, a summary with every remote field null, and the warnings
   * collected so far. Named `publicDetails`: the CLI forwards only this
   * explicitly secret-free field into the error envelope.
   */
  readonly publicDetails: CloudStatusOfflineDetails;

  /**
   * @param message - Human message.
   * @param publicDetails - Local state, summary and warnings.
   * @param fix - Remedy.
   */
  constructor(message: string, publicDetails: CloudStatusOfflineDetails, fix?: string) {
    super('E_NEXUS_UNREACHABLE', message, fix);
    this.name = 'NexusCloudOfflineError';
    this.publicDetails = publicDetails;
  }
}

/**
 * The verdict of a set of checks (E3 rules, §4.2): the first matching rule wins.
 *
 * @param checks - The checks that apply.
 * @returns `not-registered`, `not-linked`, `attention` or `ok`.
 */
export function nexusStatusVerdict(
  checks: readonly NexusCloudStatusCheck[],
): NexusCloudStatus['verdict'] {
  const failed = (id: NexusCloudStatusCheck['id']): boolean =>
    checks.some((c) => c.id === id && !c.ok);
  if (failed('device.registered') || failed('device.active')) return 'not-registered';
  if (failed('project.registered') || failed('replica.attached')) return 'not-linked';
  if (checks.some((c) => c.required && !c.ok)) return 'attention';
  return 'ok';
}

/** The device and credential checks only (for "outside a project"). */
function deviceOnly(checks: readonly NexusCloudStatusCheck[]): NexusCloudStatusCheck[] {
  return checks.filter((c) => c.id.startsWith('credential.') || c.id.startsWith('device.'));
}

/** What {@link readNexusLocalReplicaId} learned about the store's replica. */
export interface NexusLocalReplicaRead {
  /** The active replica id, or `null` (no store, no bound replica, or unreadable). */
  readonly replicaId: string | null;
  /**
   * `true` when the store exists but could not be read: `replicaId: null` then
   * means "unknown", not "unbound", so the caller must not conclude not-linked.
   */
  readonly unreadable: boolean;
  /** `W_NEXUS_REPLICA_UNREADABLE` when `unreadable`. */
  readonly warning: CloudWarning | null;
}

/** An unreadable-store result with its warning. */
function unreadableStore(reason: string): NexusLocalReplicaRead {
  return {
    replicaId: null,
    unreadable: true,
    warning: {
      code: W_NEXUS_REPLICA_UNREADABLE,
      message: `could not read the project store read-only, so the replica id is unknown: ${reason}`,
    },
  };
}

/**
 * The active replica id of a project store, read-only: a snapshot handle with
 * no migrations and no pragmas, closed before returning. Never binds and never
 * writes a row.
 *
 * SQLite side effect: a read-only open of a WAL-mode store needs the `-wal`
 * and `-shm` sidecars, and SQLite creates them (empty) when they are missing
 * and the directory is writable. Run as another user (for example under
 * `sudo`), those sidecars would be left owned by that user, so when the store
 * has no `-wal` and the directory is not writable by the caller the open is
 * skipped and the store reported unreadable instead.
 *
 * @param projectRoot - Project root.
 * @returns The replica id, whether the store was unreadable, and a warning.
 */
export async function readNexusLocalReplicaId(projectRoot: string): Promise<NexusLocalReplicaRead> {
  // The project store path, as resolveDualScopeDbPath('project', root) builds it.
  const path = join(resolveCleoDir(projectRoot), 'cleo.db');
  const { activeReplica } = await import('../store/sync/replica.js');
  const read = await readStoreSnapshot(
    path,
    (db) => activeReplica(db, 'project')?.replicaId ?? null,
  );
  if (read.kind === 'absent') return { replicaId: null, unreadable: false, warning: null };
  if (read.kind === 'unreadable') return unreadableStore(read.reason);
  return { replicaId: read.value, unreadable: false, warning: null };
}

/** What {@link readStoreSnapshot} found. */
type StoreSnapshotRead<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'read'; readonly value: T };

/**
 * Run `read` on a read-only snapshot of a store: no migrations, no pragmas,
 * closed before returning. Never writes a row.
 *
 * SQLite side effect: a read-only open of a WAL-mode store needs the `-wal`
 * and `-shm` sidecars, and SQLite creates them (empty) when they are missing
 * and the directory is writable. Run as another user (for example under
 * `sudo`), those sidecars would be left owned by that user, so when the store
 * has no `-wal` and the directory is not writable by the caller the open is
 * skipped and the store reported unreadable instead.
 */
async function readStoreSnapshot<T>(
  path: string,
  read: (db: DatabaseSync) => T | Promise<T>,
): Promise<StoreSnapshotRead<T>> {
  if (!existsSync(path)) return { kind: 'absent' };
  if (!existsSync(`${path}-wal`) && !isWritable(dirname(path))) {
    return {
      kind: 'unreadable',
      reason:
        'the store has no -wal file and its directory is not writable, so a read-only open would fail or leave sidecars behind',
    };
  }
  const { openCleoDbSnapshot } = await import('../store/open-cleo-db.js');
  let snap: ReturnType<typeof openCleoDbSnapshot> | undefined;
  try {
    snap = openCleoDbSnapshot(path, { readOnly: true, applyPragmas: false });
    return { kind: 'read', value: await read(snap.db) };
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    snap?.close();
  }
}

/** Warning: a store's sync journal could not be read for `cleo cloud status` (T12998). */
export const W_NEXUS_SYNC_UNREADABLE = 'W_NEXUS_SYNC_UNREADABLE';

/** The outbox (T12343) is what will know which sealed ops are not yet sent. */
const UNSENT_UNKNOWN: CloudSyncUnknown = {
  known: false,
  needs: 'T12343',
  reason: 'the transactional outbox that tracks unsent ops (T12343) is not built yet',
};

/** Segment push/pull (S4) is what will record exchanged sequences and the server head. */
function needsPush(what: string): CloudSyncUnknown {
  return {
    known: false,
    needs: 'S4',
    reason: `${what} is recorded once segment push/pull (S4) lands; this build reads the local journal only`,
  };
}

/**
 * One store's local sync journal for `cleo cloud status` (T12998). Read-only:
 * never seals, pushes or binds. Every reader returns empty values when its
 * table is absent, so a store without the journal reports every flag off.
 *
 * @param db - The store, opened read-only.
 * @param scope - Which store it is.
 * @param stream - Its stream when known locally, else `null`.
 * @param dbPath - The store file.
 * @returns The stream's sync block; the server-side fields are unknown, each
 *   with the reason.
 *
 * @task T12998
 */
export async function readStoreSyncStream(
  db: DatabaseSync,
  scope: 'project' | 'global',
  stream: string | null,
  dbPath: string,
): Promise<CloudStatusSyncStream> {
  const [{ readSyncFlags }, { hasTable }, { sealBacklog }, { suspectTables }] = await Promise.all([
    import('../store/sync/flags.js'),
    import('../store/sync/schema.js'),
    import('../store/sync/seal-backlog.js'),
    import('../store/sync/structural.js'),
  ]);
  const flags = readSyncFlags(db);
  const backlog = sealBacklog(db);
  let lastSealedSeq: number | null = null;
  if (hasTable(db, '_sync_txn')) {
    // Inherited and folded txns belong to another replica's history.
    const row = db
      .prepare("SELECT max(local_seq) AS seq FROM _sync_txn WHERE state IN ('sealed', 'segmented')")
      .get() as { seq: number | null } | undefined;
    lastSealedSeq = row?.seq ?? null;
  }
  const quarantined: Record<string, number> = {};
  if (hasTable(db, '_sync_quarantine')) {
    for (const r of db
      .prepare('SELECT tbl, count(*) AS n FROM _sync_quarantine GROUP BY tbl ORDER BY tbl')
      .all() as Array<{ tbl: string; n: number }>) {
      quarantined[r.tbl] = r.n;
    }
  }
  return {
    scope,
    stream,
    dbPath,
    journalInstalled: hasTable(db, '_sync_capture') && hasTable(db, '_sync_txn'),
    flags: {
      capture: flags['sync.capture'],
      seal: flags['sync.seal'],
      push: flags['sync.push'],
      pull: flags['sync.pull'],
      strict: flags['sync.strict'],
    },
    unsealedOps: backlog.live,
    oldestUnsealedAtMs: backlog.oldestAtMs,
    lastSealedSeq,
    quarantined,
    suspectTables: hasTable(db, '_sync_meta') ? suspectTables(db) : [],
    unsentOps: UNSENT_UNKNOWN,
    lastPushedSeq: needsPush('the last pushed sequence'),
    lastPulledSeq: needsPush('the last pulled sequence'),
    serverHeadSeq: needsPush("the server's head for this stream"),
    devices: needsPush('per-device last sync'),
    openConflicts: needsPush('the conflicts held open on this stream'),
    lag: needsPush('lag behind the server'),
  };
}

/**
 * The local sync journal of the project and global stores, for
 * `cleo cloud status` (T12998). Read-only; a store that cannot be read is a
 * warning, never a failure.
 *
 * @param projectRoot - The current project, or `null` outside one.
 * @param projectStream - The project's stream when its link records one.
 * @param warnings - Collects `W_NEXUS_SYNC_UNREADABLE`.
 * @param globalHome - The CLEO home holding the global store. @defaultValue getCleoHome()
 * @returns The sync block, or `undefined` when neither store exists.
 *
 * @task T12998
 */
export async function readCloudSyncStatus(
  projectRoot: string | null,
  projectStream: string | null,
  warnings: CloudWarning[],
  globalHome: string = getCleoHome(),
): Promise<CloudStatusSync | undefined> {
  const stores: Array<{ scope: 'project' | 'global'; path: string; stream: string | null }> = [];
  if (projectRoot !== null) {
    stores.push({
      scope: 'project',
      path: join(resolveCleoDir(projectRoot), 'cleo.db'),
      stream: projectStream,
    });
  }
  // The home stream needs the account's user id, which only the server knows.
  stores.push({ scope: 'global', path: join(globalHome, 'cleo.db'), stream: null });
  const streams: CloudStatusSyncStream[] = [];
  for (const store of stores) {
    const read = await readStoreSnapshot(store.path, (db) =>
      readStoreSyncStream(db, store.scope, store.stream, store.path),
    );
    if (read.kind === 'absent') continue;
    if (read.kind === 'unreadable') {
      warnings.push({
        code: W_NEXUS_SYNC_UNREADABLE,
        message: `could not read the ${store.scope} store's sync journal read-only: ${read.reason}`,
      });
      continue;
    }
    streams.push(read.value);
  }
  return streams.length === 0 ? undefined : { streams, partial: true };
}

/** True when the caller may write into `dir`. */
function isWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when a device credential (or a 9.24 session to upgrade) is stored for the origin. */
async function hasLocalCredential(
  apiUrl: string,
  devices: NexusDeviceStore,
  sessions: NexusTokenStore,
): Promise<boolean> {
  const origin = nexusOriginKey(apiUrl);
  for (const d of await devices.list()) {
    if (d instanceof UnreadableNexusDevice || d.origin !== origin) continue;
    if (d.currentBearer() !== null || d.unseal().raceCandidate) return true;
  }
  return (await sessions.get(apiUrl)) !== null;
}

/** A summary with no remote facts. */
function emptySummary(local: CloudStatusLocal): CloudStatusSummary {
  return {
    signedIn: local.signedIn,
    registered: false,
    profile: local.profile,
    linked: false,
    replicaAttached: false,
    devices: 0,
    lastPresenceAt: null,
    lastSyncAt: null,
    headSeq: null,
    openConflicts: null,
  };
}

/** One check. */
function check(
  id: NexusCloudStatusCheck['id'],
  ok: boolean,
  required: boolean,
  detail: string,
): NexusCloudStatusCheck {
  return { id, ok, required, detail };
}

/** E2's device and credential checks. */
function deviceChecks(whoami: NexusCloudWhoami): NexusCloudStatusCheck[] {
  const d = whoami.device;
  const out = [
    check('credential.valid', true, true, `${whoami.credential.kind} credential accepted`),
    check('device.registered', d !== null, true, d ? `device ${d.deviceId}` : 'no device'),
    check('device.active', d?.state === 'active', true, `state ${d?.state ?? 'none'}`),
  ];
  if (d && d.certificate !== undefined) {
    out.push(check('device.certified', d.certificate !== null, false, 'device certificate'));
  }
  return out;
}

/** The replica row of `replicaId`, from E14's list or, when that was cut, from E15. */
async function findReplica(
  conn: NexusCloudConnection,
  projectId: string,
  replicaId: string,
  listed: readonly NexusCloudReplica[],
  truncated: boolean,
): Promise<NexusCloudReplica | null> {
  const hit = listed.find((r) => r.replicaId === replicaId);
  if (hit || !truncated) return hit ?? null;
  const all = await listNexusCloudReplicas(conn, projectId);
  return all.replicas.find((r) => r.replicaId === replicaId) ?? null;
}

/**
 * The `NexusStatus` of E3, composed from E2, E14 and E15 with the contract's
 * check rules (§4.2 E3), for a server without E3.
 *
 * @param conn - Connection.
 * @param projectId - Project to check, or `null`.
 * @param replicaId - Replica to check, or `null`.
 * @param now - Clock for presence freshness.
 * @returns The composed status.
 */
export async function composeNexusStatus(
  conn: NexusCloudConnection,
  projectId: string | null,
  replicaId: string | null,
  now: () => Date = () => new Date(),
): Promise<NexusCloudStatus> {
  const whoami = await conn.get('/v1/whoami', nexusCloudWhoamiSchema);
  const checks = deviceChecks(whoami);
  const base = { user: whoami.user, credential: whoami.credential, device: whoami.device };
  if (projectId === null) {
    return {
      ...base,
      project: null,
      replica: null,
      stream: null,
      checks,
      verdict: nexusStatusVerdict(checks),
    };
  }
  const detail = await conn.find(
    `/v1/projects/${encodeURIComponent(projectId)}`,
    nexusCloudProjectDetailSchema,
  );
  checks.push(
    check('project.registered', detail !== null, true, detail ? 'visible' : 'not visible'),
  );
  if (detail === null) {
    const project = {
      projectId,
      registered: false,
      organizationId: null,
      organizationName: null,
      role: null,
    };
    return {
      ...base,
      project,
      replica: null,
      stream: null,
      checks,
      verdict: nexusStatusVerdict(checks),
    };
  }
  const writable = detail.role === 'writer' || detail.role === 'owner';
  const writeRequired =
    whoami.credential.kind === 'device' && whoami.credential.profile === 'device';
  checks.push(check('project.writable', writable, writeRequired, `role ${detail.role}`));
  let replica: NexusCloudStatus['replica'] = null;
  if (replicaId !== null) {
    const row = await findReplica(conn, projectId, replicaId, detail.replicas, detail.truncated);
    const mine = row !== null && row.deviceId === whoami.device?.deviceId;
    replica = {
      replicaId,
      attached: mine,
      attachedElsewhere: row !== null && !mine,
      attachedAt: row?.attachedAt ?? null,
      lastSyncAt: row?.lastSyncAt ?? null,
      presenceAt: row?.presenceAt ?? null,
      lastReplicaSeq: null,
    };
    const fresh =
      replica.presenceAt !== null &&
      now().getTime() - Date.parse(replica.presenceAt) <= NEXUS_PRESENCE_FRESH_SECONDS * 1000;
    const syncOn = row?.presence?.sync?.enabled === true;
    checks.push(
      check(
        'replica.attached',
        mine,
        true,
        mine ? 'attached from this device' : row ? 'attached from another device' : 'not attached',
      ),
      check('presence.fresh', fresh, false, replica.presenceAt ?? 'no presence'),
      check(
        'replica.synced',
        replica.lastSyncAt !== null,
        syncOn,
        replica.lastSyncAt ?? 'never synced',
      ),
    );
  }
  checks.push(
    check('conflicts.none', detail.openConflicts === 0, true, `${detail.openConflicts} open`),
  );
  return {
    ...base,
    project: {
      projectId,
      registered: true,
      organizationId: detail.project.organizationId,
      organizationName: detail.project.organizationName ?? null,
      role: detail.role,
    },
    replica,
    stream: detail.stream
      ? { ...detail.stream, openConflicts: detail.openConflicts, devices: detail.devices }
      : null,
    checks,
    verdict: nexusStatusVerdict(checks),
  };
}

/** E3, or the composed status when the server has no E3. */
async function remoteStatus(
  conn: NexusCloudConnection,
  projectId: string | null,
  replicaId: string | null,
  now: (() => Date) | undefined,
  warnings: CloudWarning[],
): Promise<NexusCloudStatus> {
  const path = nexusQueryPath('/v1/status', {
    projectId: projectId ?? undefined,
    // E3 refuses a replicaId without a projectId.
    replicaId: projectId !== null && replicaId !== null ? replicaId : undefined,
  });
  const status = await conn.find(path, nexusCloudStatusSchema);
  if (status !== null) return status;
  warnings.push({
    code: W_NEXUS_STATUS_COMPOSED,
    message:
      'the server has no GET /v1/status yet; the status was composed from /v1/whoami and the project reads',
  });
  return composeNexusStatus(conn, projectId, replicaId, now);
}

/** Apply the local downgrades (§4.4) to the remote verdict. */
function localVerdict(
  remote: NexusCloudStatus,
  project: NexusCloudProject | null,
  isLocal: boolean,
  replica: NexusLocalReplicaRead,
  warnings: CloudWarning[],
): CloudStatusVerdict {
  if (remote.project !== null && !remote.project.registered && !isLocal) {
    warnings.push({
      code: W_NEXUS_PROJECT_UNKNOWN,
      message: `project ${remote.project.projectId} is not registered or not visible; only the device was checked`,
    });
    return nexusStatusVerdict(deviceOnly(remote.checks));
  }
  if (!isLocal || project === null || (remote.verdict !== 'ok' && remote.verdict !== 'attention')) {
    return remote.verdict;
  }
  if (project.link === null) {
    warnings.push({
      code: W_NEXUS_NOT_LINKED_LOCALLY,
      message:
        'this project has no .cleo/nexus-link.json entry for the origin; run `cleo project link`',
    });
    return 'not-linked';
  }
  if (replica.unreadable) {
    // Unknown is not unbound: never conclude not-linked from an unreadable
    // store (W_NEXUS_REPLICA_UNREADABLE already says why).
    return 'attention';
  }
  if (replica.replicaId === null) {
    warnings.push({
      code: W_NEXUS_NO_REPLICA,
      message: "this project's store has no bound replica; run `cleo project link`",
    });
    return 'not-linked';
  }
  return remote.verdict;
}

/** The summary of a remote status. */
function summaryOf(
  remote: NexusCloudStatus,
  local: CloudStatusLocal,
  project: NexusCloudProject | null,
  isLocal: boolean,
): CloudStatusSummary {
  const ok = (id: NexusCloudStatusCheck['id']): boolean =>
    remote.checks.some((c) => c.id === id && c.ok);
  const registeredRemotely = remote.project?.registered === true;
  return {
    signedIn: true,
    registered: ok('device.registered') && ok('device.active'),
    profile: remote.credential.profile ?? local.profile,
    linked: registeredRemotely && (!isLocal || (project?.link ?? null) !== null),
    replicaAttached: remote.replica?.attached === true,
    devices: remote.stream?.devices.active ?? 0,
    lastPresenceAt: remote.replica?.presenceAt ?? null,
    lastSyncAt: remote.replica?.lastSyncAt ?? null,
    headSeq: remote.stream?.headSeq ?? null,
    openConflicts: remote.stream?.openConflicts ?? null,
  };
}

/**
 * `cleo cloud status [--project <id>]`.
 *
 * @param opts - Project, API URL, stores and test overrides.
 * @returns The verdict, summary, local and remote facts, and warnings.
 * @throws {NexusCloudOfflineError} `E_NEXUS_UNREACHABLE` when the server does not answer.
 * @throws {NexusAccountError} `E_NEXUS_DEVICE_REQUIRED`, `E_NEXUS_ACCOUNT_AMBIGUOUS`,
 *   or a mapped API refusal (§4.0.4).
 */
export async function getNexusCloudStatus(
  opts: NexusCloudStatusOptions = {},
): Promise<CloudStatusResult> {
  assertNexusCloudDeviceMode();
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const devices = opts.deviceStore ?? new NexusDeviceStore();
  const sessions = opts.store ?? new FileNexusTokenStore();
  const warnings: CloudWarning[] = [];
  const project = currentNexusCloudProject(apiUrl, opts.projectRoot);
  const projectHere = project ? (project.link?.remoteProjectId ?? project.projectId) : null;
  const isLocal =
    project !== null &&
    (opts.projectId === undefined ||
      opts.projectId === project.projectId ||
      opts.projectId === project.link?.remoteProjectId);
  // The current project (bare, or named by its local or remote id) is asked
  // about by its linked remote id, like the bare command.
  const projectId = isLocal ? projectHere : (opts.projectId ?? null);
  let replica: NexusLocalReplicaRead = { replicaId: null, unreadable: false, warning: null };
  if (isLocal && project !== null) {
    replica = await readNexusLocalReplicaId(project.root);
    if (replica.warning) warnings.push(replica.warning);
  }
  const replicaId = replica.replicaId;
  // T12998: the local sync journal, read on every path (signed in or not,
  // online or offline). The current project's store only when it is the
  // project asked about.
  const sync = await readCloudSyncStatus(
    isLocal && project !== null ? project.root : null,
    isLocal && project?.link
      ? project.link.streamId || projectStream(project.link.remoteProjectId)
      : null,
    warnings,
  );
  const withSync = sync === undefined ? {} : { sync };
  const local: CloudStatusLocal = {
    apiUrl,
    signedIn: false,
    nexusDeviceId: null,
    profile: null,
    projectId,
    replicaId,
    linkPath: isLocal && project?.link ? project.linkPath : null,
    credentialsPath: devices.location,
  };
  const notSignedIn = (): CloudStatusResult => ({
    verdict: 'not-signed-in',
    summary: emptySummary(local),
    local,
    remote: null,
    ...withSync,
    warnings,
  });
  if (!(await hasLocalCredential(apiUrl, devices, sessions))) return notSignedIn();
  try {
    const conn = await connectNexusCloud({
      ...opts,
      apiUrl,
      deviceStore: devices,
      store: sessions,
    });
    warnings.push(...conn.warnings);
    local.signedIn = true;
    local.nexusDeviceId = conn.device.deviceId;
    local.profile = conn.device.unseal().current?.profile ?? null;
    const remote = await remoteStatus(conn, projectId, replicaId, opts.now, warnings);
    const verdict = localVerdict(remote, project, isLocal, replica, warnings);
    return {
      verdict,
      summary: summaryOf(remote, local, project, isLocal),
      local,
      remote,
      global: await globalStoreOf(conn, warnings),
      ...withSync,
      warnings,
    };
  } catch (err) {
    if (
      err instanceof NexusAccountError &&
      err.code === 'E_NEXUS_NOT_SIGNED_IN' &&
      !local.signedIn
    ) {
      return notSignedIn();
    }
    if (err instanceof NexusAccountError && err.code === 'E_NEXUS_UNREACHABLE') {
      throw new NexusCloudOfflineError(
        err.message,
        { local, summary: emptySummary(local), warnings, ...withSync },
        err.fix,
      );
    }
    throw err;
  }
}

/**
 * This device's global store (the main brain) on the account's home stream
 * (T12952): attached or not, its presence, and how many devices attach one.
 * A server without the home-replica endpoints yields `supported: false`.
 */
async function globalStoreOf(
  conn: NexusCloudConnection,
  warnings: CloudWarning[],
): Promise<CloudStatusGlobalStore> {
  try {
    const list = await conn.find('/v1/account/home/replicas', nexusHomeReplicaListSchema);
    if (list === null) {
      return { supported: false, attached: false, replicaId: null, presenceAt: null, devices: 0 };
    }
    const mine = list.replicas.find((r) => r.deviceId === conn.device.deviceId) ?? null;
    if (mine === null) {
      warnings.push({
        code: 'W_NEXUS_GLOBAL_NOT_ATTACHED',
        message:
          "this device's global store is not attached to the account; run `cleo login nexus`",
      });
    }
    return {
      supported: true,
      attached: mine !== null,
      replicaId: mine?.replicaId ?? null,
      presenceAt: mine?.presenceAt ?? null,
      devices: new Set(list.replicas.map((r) => r.deviceId)).size,
    };
  } catch (err) {
    warnings.push({
      code: 'W_NEXUS_GLOBAL_UNREADABLE',
      message: `could not read the global store attachments: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { supported: false, attached: false, replicaId: null, presenceAt: null, devices: 0 };
  }
}
