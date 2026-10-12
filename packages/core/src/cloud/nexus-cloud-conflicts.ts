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
import { type ConflictKeep, resolveConflictKeeping } from '../store/sync/apply/resolve-conflict.js';
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
 * Parse `--keep`: `mine`, `theirs`, or `column=mine|theirs,...`.
 *
 * @param text - The flag value.
 * @returns The choice, or null when it is not one of those forms.
 */
export function parseConflictKeep(text: string): ConflictKeep | null {
  if (text === 'mine' || text === 'theirs') return text;
  const out: Record<string, 'mine' | 'theirs'> = {};
  for (const part of text.split(',')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(mine|theirs)\s*$/.exec(part);
    if (!m?.[1] || !m[2]) return null;
    out[m[1]] = m[2] === 'mine' ? 'mine' : 'theirs';
  }
  return out;
}

/**
 * Resolve one open conflict. Without `keep` it is acknowledged (marked
 * resolved). With `keep`, the chosen side per column is kept: mine writes
 * nothing, theirs is an ordinary local write that syncs, refused when a
 * typed rule would refuse it on a receiver (T12997). It never replays or
 * revives the voided transaction.
 *
 * @param opts - Store, scope, the conflict id and the side to keep.
 * @returns Whether an open conflict had that id, and the columns written.
 * @throws {ConflictResolveError} When `keep` cannot be applied.
 */
export async function resolveNexusCloudConflict(opts: {
  readonly cwd?: string;
  readonly scope?: CloudVaultScope;
  readonly id: number;
  readonly keep?: ConflictKeep;
}): Promise<CloudConflictResolveResult> {
  const scope = opts.scope ?? 'project';
  const db = await storeOf(scope, opts.cwd);
  if (!hasTable(db, '_sync_conflict')) {
    return { scope, id: opts.id, resolved: false, written: [], warnings: [NOT_SYNCING] };
  }
  const nowIso = new Date().toISOString();
  if (opts.keep === undefined) {
    return {
      scope,
      id: opts.id,
      resolved: resolveConflict(db, opts.id, nowIso),
      written: [],
      warnings: [],
    };
  }
  const { written } = resolveConflictKeeping(db, scope, opts.id, opts.keep, nowIso);
  return { scope, id: opts.id, resolved: true, written: [...written], warnings: [] };
}
