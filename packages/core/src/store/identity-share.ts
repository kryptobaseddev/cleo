/**
 * Record on the project store that its row identity left it, or came from
 * elsewhere (`row_identity_synced`), so a later full identity refill refuses
 * (T13249, T13250). Every path that carries the store's uids out of it calls
 * this: a snapshot export or import, a portable bundle export, a vault push.
 *
 * @module store/identity-share
 * @task T13250
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Options of {@link markProjectIdentityShared}. */
export interface MarkIdentitySharedOptions {
  /**
   * Mark only when the store holds any identity value. A store the fill never
   * ran on (row uids off, the default) has no uid to share, and stays
   * untouched: no identity meta is written.
   */
  readonly onlyIfIdentity?: boolean;
}

/**
 * Mark the project store's identity shared. Never skipped silently: without a
 * bound handle the store is opened through the chokepoint, and a failure
 * throws (T13270).
 *
 * @param cwd - The project.
 * @param direction - `send` (uids left the store) or `receive` (uids came in).
 * @param opts - Whether to mark only a store that holds identity values.
 * @returns Whether the marker was written (or was already there).
 * @task T13250
 */
export async function markProjectIdentityShared(
  cwd: string | undefined,
  direction: 'send' | 'receive',
  opts: MarkIdentitySharedOptions = {},
): Promise<boolean> {
  const { getNativeTasksDb } = await import('./sqlite.js');
  const { fullRefillPlan, markRowIdentityShared } = await import('./row-identity.js');
  const holdsIdentity = (h: DatabaseSync) => Object.keys(fullRefillPlan(h)).length > 0;
  let db: DatabaseSync | null = getNativeTasksDb(cwd);
  if (!db) {
    const { getDualScopeNativeDb, openDualScopeDb, resolveDualScopeDbPath } = await import(
      './dual-scope-db.js'
    );
    // No bound handle: a store with no identity is decided read-only, so an
    // export of it opens (and migrates) nothing.
    if (opts.onlyIfIdentity === true) {
      const path = resolveDualScopeDbPath('project', cwd);
      if (!existsSync(path)) return false;
      const { openCleoDbSnapshot } = await import('./open-cleo-db.js');
      const snap = openCleoDbSnapshot(path, { readOnly: true });
      try {
        if (!holdsIdentity(snap.db)) return false;
      } finally {
        snap.close();
      }
    }
    db = getDualScopeNativeDb(await openDualScopeDb('project', cwd));
  }
  if (opts.onlyIfIdentity === true && !holdsIdentity(db)) return false;
  // The marker goes through the chokepoint writers.
  await import('./sqlite-data-accessor.js');
  markRowIdentityShared(db, direction);
  return true;
}
