/**
 * `cleo cloud activity --devices`: one row per device answering "what did my
 * other devices change, and when, and are they online" (T13482).
 *
 * It merges three sources the other views show separately: the account's
 * device list (name, state, presence), this store's sync journal (the newest
 * transaction each device wrote, `cloud activity --journal`) and the server's
 * account events (the newest snapshot, lease or enrolment each device made,
 * `cloud activity`). Offline it shows the journal alone, with a warning.
 *
 * @module cloud/nexus-cloud-device-overview
 * @task T13482
 * @epic T12323
 */

import type {
  CloudActivityItem,
  CloudDeviceOverviewResult,
  CloudDeviceOverviewRow,
  CloudJournalActivityResult,
  CloudVaultScope,
  CloudWarning,
  NexusCloudDevice,
} from '@cleocode/contracts';
import { NEXUS_PRESENCE_FRESH_SECONDS } from '@cleocode/contracts/nexus-cloud.js';
import type { NexusCloudOptions } from './nexus-cloud.js';

/** Options of {@link nexusDeviceOverview}. */
export interface NexusDeviceOverviewOptions extends NexusCloudOptions {
  /** The project directory (default: the current project). */
  readonly cwd?: string;
  /** Which store's journal (default `project`). */
  readonly scope?: CloudVaultScope;
  /** Read only the local journal: no request leaves the machine. */
  readonly offline?: boolean;
}

/** The sources {@link mergeDeviceOverview} combines; `null` for one that was not read. */
export interface DeviceOverviewSources {
  readonly scope: CloudVaultScope;
  readonly journal: CloudJournalActivityResult;
  readonly devices: readonly NexusCloudDevice[] | null;
  readonly server: readonly CloudActivityItem[] | null;
  readonly warnings: readonly CloudWarning[];
  /** Clock for presence freshness (tests). */
  readonly nowMs?: number;
}

const LOCAL_ONLY: CloudWarning = {
  code: 'W_DEVICE_OVERVIEW_LOCAL_ONLY',
  message:
    'offline: presence, device names and server events are not shown; only the local journal is',
};

const newest = (...at: Array<string | null | undefined>): string | null =>
  at
    .filter((x): x is string => typeof x === 'string')
    .sort()
    .at(-1) ?? null;

/**
 * Merge the device list, the journal page and the server events into one
 * row per device, newest activity first.
 *
 * @param src - The sources; a `null` device list or server list was not read.
 * @returns The per-device overview.
 */
export function mergeDeviceOverview(src: DeviceOverviewSources): CloudDeviceOverviewResult {
  const nowMs = src.nowMs ?? Date.now();
  const ids = new Set<string>();
  for (const d of src.devices ?? []) ids.add(d.deviceId);
  for (const d of src.journal.devices) ids.add(d.deviceId);
  for (const e of src.server ?? []) if (e.deviceId) ids.add(e.deviceId);
  const rows: CloudDeviceOverviewRow[] = [...ids].map((id) => {
    const dev = src.devices?.find((d) => d.deviceId === id);
    const jd = src.journal.devices.find((d) => d.deviceId === id);
    // Items and server events are newest first, so the first match is the newest.
    const ji = src.journal.items.find((i) => i.deviceId === id);
    const ev = src.server?.find((e) => e.deviceId === id);
    const lastSeenAt = dev?.lastPresenceAt ?? dev?.lastSeenAt ?? jd?.lastSeenAt ?? null;
    return {
      deviceId: id,
      deviceName: dev?.name ?? jd?.deviceName ?? ev?.deviceName ?? null,
      thisDevice: (dev?.current ?? false) || (jd?.thisDevice ?? false) || (ev?.thisDevice ?? false),
      state: dev?.state ?? null,
      online:
        src.devices === null || lastSeenAt === null
          ? null
          : dev?.state === 'active' &&
            nowMs - Date.parse(lastSeenAt) <= NEXUS_PRESENCE_FRESH_SECONDS * 1000,
      lastSeenAt,
      journal: jd
        ? {
            txns: jd.txns,
            lastAt: jd.lastAt,
            last: ji
              ? { op: ji.actor?.op ?? ji.kind, status: ji.status, tables: Object.keys(ji.tables) }
              : null,
          }
        : null,
      server: ev ? { at: ev.at, action: ev.action, target: ev.target } : null,
      lastActivityAt: newest(jd?.lastAt, ev?.at, lastSeenAt),
    };
  });
  rows.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const warnings = [...src.warnings];
  if (src.devices === null && src.server === null) warnings.push(LOCAL_ONLY);
  return { scope: src.scope, devices: rows, warnings };
}

/**
 * Read the three sources and merge them. A failed device list or event
 * read becomes a warning; the journal read is local and always runs.
 *
 * @param opts - Store, offline switch and Nexus overrides.
 * @returns One row per device, newest activity first.
 */
export async function nexusDeviceOverview(
  opts: NexusDeviceOverviewOptions = {},
): Promise<CloudDeviceOverviewResult> {
  const scope = opts.scope ?? 'project';
  const { nexusJournalActivity } = await import('./nexus-cloud-journal-activity.js');
  const journal = await nexusJournalActivity({ ...opts, scope, offline: true, limit: 200 });
  const warnings: CloudWarning[] = [...journal.warnings];
  if (opts.offline === true) {
    return mergeDeviceOverview({ scope, journal, devices: null, server: null, warnings });
  }
  const failed = (what: string, err: unknown): null => {
    warnings.push({
      code: 'W_DEVICE_OVERVIEW_PARTIAL',
      message: `${what} not shown: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  };
  const { listNexusCloudDevices } = await import('./nexus-cloud.js');
  const { nexusCloudActivity } = await import('./nexus-cloud-activity.js');
  const devices = await listNexusCloudDevices({ ...opts, state: 'all' }).then(
    (r) => r.devices,
    (err: unknown) => failed('presence and device names', err),
  );
  const server = await nexusCloudActivity({ ...opts, limit: 200 }).then(
    (r) => r.items,
    (err: unknown) => failed('server events', err),
  );
  return mergeDeviceOverview({ scope, journal, devices, server, warnings });
}
