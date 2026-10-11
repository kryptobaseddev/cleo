/**
 * `cleo cloud activity --journal`: what each device changed and when, read
 * from this store's journal (T13369).
 *
 * The plain `cleo cloud activity` lists the server's account events
 * (snapshots, leases, enrolments). This lists the journal transactions this
 * store received: per transaction, the device that wrote it, its write time
 * (HLC), when it was staged and applied here, its status, its command and
 * its per-table op counts; and per device, how many transactions and the
 * newest one's time.
 *
 * Local: the listing reads only the store. Device names come from the
 * account's device list when a device credential is available, unless
 * `offline` is set; without names the device ids are still shown.
 *
 * @module cloud/nexus-cloud-journal-activity
 * @task T13369
 * @epic T12323
 */

import type {
  CloudJournalActivityResult,
  CloudVaultScope,
  CloudWarning,
} from '@cleocode/contracts';
import { nexusCloudDevicePageSchema } from '@cleocode/contracts/nexus-cloud.js';
import { getDualScopeNativeDb, openDualScopeDb } from '../store/dual-scope-db.js';
import { journalActivity } from '../store/sync/activity.js';
import { hasTable } from '../store/sync/schema.js';
import { connectNexusCloud, type NexusCloudOptions } from './nexus-cloud.js';

/** Options of {@link nexusJournalActivity}. */
export interface NexusJournalActivityOptions extends NexusCloudOptions {
  /** The project directory (default: the current project). */
  readonly cwd?: string;
  /** Which store (default `project`). */
  readonly scope?: CloudVaultScope;
  /** Transactions to return (1..200, default 50). */
  readonly limit?: number;
  /** Older page: the `nextBefore` of a previous call. */
  readonly before?: string;
  /** Only transactions signed by this Nexus device id. */
  readonly deviceId?: string;
  /** Only transactions written at or after this instant (ISO-8601). */
  readonly since?: string;
  /** Only transactions for this project id. */
  readonly projectId?: string;
  /** Skip the device-name lookup: no request leaves the machine. */
  readonly offline?: boolean;
}

const NOT_SYNCING: CloudWarning = {
  code: 'W_SYNC_NOT_ENABLED',
  message: 'this store has never pulled a sync stream: no journal activity is recorded',
};

/** Thrown for a `since` that is not a date. */
export class JournalActivitySinceError extends Error {
  readonly code = 'E_VALIDATION';
  readonly fix =
    'pass --since as an ISO-8601 date or time, e.g. 2026-10-09 or 2026-10-09T12:00:00Z';
  constructor(since: string) {
    super(`--since is not a date: '${since}'`);
    this.name = 'JournalActivitySinceError';
  }
}

/** Device names by Nexus device id, or why there are none. */
async function deviceNames(
  opts: NexusJournalActivityOptions,
): Promise<{ names: Map<string, string>; warning: CloudWarning | null }> {
  if (opts.offline === true) return { names: new Map(), warning: null };
  try {
    const conn = await connectNexusCloud(opts);
    const page = await conn.get('/v1/devices?limit=100', nexusCloudDevicePageSchema);
    return { names: new Map(page.devices.map((d) => [d.deviceId, d.name])), warning: null };
  } catch (err) {
    return {
      names: new Map(),
      warning: {
        code: 'W_DEVICE_NAMES_UNAVAILABLE',
        message: `device names are not shown: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * List the journal transactions this store received, newest first, with
 * the device that wrote each one.
 *
 * @param opts - Store, paging, filters and the name lookup.
 * @returns The page, the per-device summary, the next cursor and warnings.
 * @throws {JournalActivitySinceError} When `since` is not a date.
 */
export async function nexusJournalActivity(
  opts: NexusJournalActivityOptions = {},
): Promise<CloudJournalActivityResult> {
  const scope = opts.scope ?? 'project';
  let sinceMs: number | undefined;
  if (opts.since !== undefined) {
    sinceMs = Date.parse(opts.since);
    // @sync-invariant none:input-shape a read-only listing refuses a filter that is not a date
    if (!Number.isFinite(sinceMs)) throw new JournalActivitySinceError(opts.since);
  }
  const db = getDualScopeNativeDb(
    scope === 'global'
      ? await openDualScopeDb('global', opts.cwd)
      : await openDualScopeDb('project', opts.cwd),
  );
  if (!hasTable(db, '_sync_inbox')) {
    return { scope, items: [], devices: [], nextBefore: null, warnings: [NOT_SYNCING] };
  }
  const { names, warning } = await deviceNames(opts);
  const page = journalActivity(db, {
    deviceNames: names,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(opts.projectId !== undefined ? { project: opts.projectId } : {}),
  });
  return { scope, ...page, warnings: warning ? [warning] : [] };
}
