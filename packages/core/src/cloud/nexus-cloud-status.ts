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
 * - unreachable: `E_NEXUS_UNREACHABLE`, its `details` carrying `local` and a
 *   summary whose remote fields are null ({@link NexusCloudOfflineError});
 * - outside a project (or `--project` naming an unknown id) the device and
 *   account parts are still reported and the verdict comes from the device
 *   checks only.
 *
 * Read-only. The replica id is read through `activeReplica(db, 'project')` on
 * a read-only snapshot handle (`openCleoDbSnapshot`, no migrations, no
 * pragmas): this command never binds a replica or writes `cleo.db`. When the
 * store cannot be read that way, `replicaId` is `null` with a warning.
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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CloudStatusLocal,
  type CloudStatusOfflineDetails,
  type CloudStatusResult,
  type CloudStatusSummary,
  type CloudStatusVerdict,
  type CloudWarning,
  NEXUS_PRESENCE_FRESH_SECONDS,
  type NexusCloudReplica,
  type NexusCloudStatus,
  type NexusCloudStatusCheck,
  type NexusCloudWhoami,
  nexusCloudProjectDetailSchema,
  nexusCloudStatusSchema,
  nexusCloudWhoamiSchema,
} from '@cleocode/contracts';
import { resolveCleoDir } from '../paths.js';
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
  /** Local state and a summary with every remote field null. */
  readonly details: CloudStatusOfflineDetails;

  /**
   * @param message - Human message.
   * @param details - Local state and summary.
   * @param fix - Remedy.
   */
  constructor(message: string, details: CloudStatusOfflineDetails, fix?: string) {
    super('E_NEXUS_UNREACHABLE', message, fix);
    this.name = 'NexusCloudOfflineError';
    this.details = details;
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

/**
 * The active replica id of a project store, read-only: a snapshot handle with
 * no migrations and no pragmas, closed before returning. Never binds.
 *
 * @param projectRoot - Project root.
 * @returns The replica id (or `null`) and a warning when the store could not be read.
 */
export async function readNexusLocalReplicaId(
  projectRoot: string,
): Promise<{ replicaId: string | null; warning: CloudWarning | null }> {
  // The project store path, as resolveDualScopeDbPath('project', root) builds it.
  const path = join(resolveCleoDir(projectRoot), 'cleo.db');
  if (!existsSync(path)) return { replicaId: null, warning: null };
  const { openCleoDbSnapshot } = await import('../store/open-cleo-db.js');
  const { activeReplica } = await import('../store/sync/replica.js');
  let snap: ReturnType<typeof openCleoDbSnapshot> | undefined;
  try {
    snap = openCleoDbSnapshot(path, { readOnly: true, applyPragmas: false });
    return { replicaId: activeReplica(snap.db, 'project')?.replicaId ?? null, warning: null };
  } catch (err) {
    return {
      replicaId: null,
      warning: {
        code: W_NEXUS_REPLICA_UNREADABLE,
        message: `could not read the project store read-only, so the replica id is unknown: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    snap?.close();
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
  replicaId: string | null,
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
  if (replicaId === null) {
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
  const projectId = opts.projectId ?? projectHere;
  let replicaId: string | null = null;
  if (isLocal && project !== null) {
    const read = await readNexusLocalReplicaId(project.root);
    replicaId = read.replicaId;
    if (read.warning) warnings.push(read.warning);
  }
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
    const verdict = localVerdict(remote, project, isLocal, replicaId, warnings);
    return {
      verdict,
      summary: summaryOf(remote, local, project, isLocal),
      local,
      remote,
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
        { local, summary: emptySummary(local) },
        err.fix,
      );
    }
    throw err;
  }
}
