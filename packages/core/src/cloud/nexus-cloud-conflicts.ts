/**
 * `cleo cloud conflicts`: the sync conflicts this store's apply recorded
 * (T12344 PR-6; journal spec §3.2 "conflict records").
 *
 * Every conflict an apply decides is a `_sync_conflict` row: a typed-rule
 * refusal or override, an edit of a deleted row, a delete over newer edits,
 * a concurrent divergent edit, a dangling reference, a guard refusal, a
 * parent delete with live children, a uid collision, a broken post-apply
 * invariant. Nothing is silently dropped; this lists them, and `resolve`
 * acknowledges one once its resolution (an ordinary write) is made or it
 * was reviewed; it never replays the voided op. Each conflict carries the
 * row's human id, both sides' values per column and the device that wrote
 * the op (T12997). Local, except that device names come from the account's
 * device list unless `offline` is set.
 *
 * @module cloud/nexus-cloud-conflicts
 * @task T12344
 */

import type {
  CloudConflictResolveResult,
  CloudConflictsResult,
  CloudVaultScope,
  CloudWarning,
} from '@cleocode/contracts';
import { getDualScopeNativeDb, openDualScopeDb } from '../store/dual-scope-db.js';
import {
  conflictCounts,
  conflictDetail,
  listConflicts,
  resolveConflict,
} from '../store/sync/conflicts.js';
import { hasTable } from '../store/sync/schema.js';
import type { NexusCloudOptions } from './nexus-cloud.js';
import { deviceNames } from './nexus-cloud-journal-activity.js';

/** Options of {@link nexusCloudConflicts}. */
export interface NexusCloudConflictsOptions extends NexusCloudOptions {
  /** The project directory (default: the current project). */
  readonly cwd?: string;
  /** Which store (default `project`). */
  readonly scope?: CloudVaultScope;
  /** Include resolved conflicts (default: open ones only). */
  readonly all?: boolean;
  /** Only this stream's conflicts. */
  readonly stream?: string;
  /** Skip the device-name lookup: no request leaves the machine. */
  readonly offline?: boolean;
}

const NOT_SYNCING: CloudWarning = {
  code: 'W_SYNC_NOT_ENABLED',
  message: 'this store has never applied a sync stream: no conflicts are recorded',
};

async function storeOf(scope: CloudVaultScope, cwd?: string) {
  return getDualScopeNativeDb(
    scope === 'global'
      ? await openDualScopeDb('global', cwd)
      : await openDualScopeDb('project', cwd),
  );
}

/**
 * List the store's recorded sync conflicts, oldest first.
 *
 * @param opts - Store, scope and filters.
 * @returns The conflicts, the open and total counts, and warnings.
 */
export async function nexusCloudConflicts(
  opts: NexusCloudConflictsOptions = {},
): Promise<CloudConflictsResult> {
  const scope = opts.scope ?? 'project';
  const db = await storeOf(scope, opts.cwd);
  if (!hasTable(db, '_sync_conflict')) {
    return { scope, open: 0, total: 0, conflicts: [], warnings: [NOT_SYNCING] };
  }
  const rows = listConflicts(db, {
    open: opts.all !== true,
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
  });
  // Device names only when there is something to name (no request otherwise).
  const { names, warning } =
    rows.length > 0 ? await deviceNames(opts) : { names: new Map<string, string>(), warning: null };
  return {
    scope,
    ...conflictCounts(db, opts.stream),
    conflicts: rows.map((c) => {
      const d = conflictDetail(db, scope, c);
      return {
        ...c,
        columns: [...c.columns],
        humanId: d.humanId,
        deviceId: d.deviceId,
        deviceName: d.deviceId ? (names.get(d.deviceId) ?? null) : null,
        opKnown: d.opKnown,
        fields: d.fields.map((f) => ({ ...f })),
      };
    }),
    warnings: warning ? [warning] : [],
  };
}

/**
 * Acknowledge one open conflict (mark it resolved). It does not replay or
 * revive the voided transaction: the resolution is an ordinary write.
 *
 * @param opts - Store, scope and the conflict id.
 * @returns Whether an open conflict had that id.
 */
export async function resolveNexusCloudConflict(opts: {
  readonly cwd?: string;
  readonly scope?: CloudVaultScope;
  readonly id: number;
}): Promise<CloudConflictResolveResult> {
  const scope = opts.scope ?? 'project';
  const db = await storeOf(scope, opts.cwd);
  if (!hasTable(db, '_sync_conflict')) {
    return { scope, id: opts.id, resolved: false, warnings: [NOT_SYNCING] };
  }
  const resolved = resolveConflict(db, opts.id, new Date().toISOString());
  return { scope, id: opts.id, resolved, warnings: [] };
}
