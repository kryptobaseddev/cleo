/**
 * `cleo doctor sync-journal`: the repair diff of every suspect table (journal spec
 * §4.4; S3d, T12987).
 *
 * Read-only by default: it opens the project `cleo.db` as a snapshot and
 * plans the repair of each `suspect:` table (the I, U and D ops it would
 * emit, the rows it would baseline, held and unidentified rows), writing
 * nothing. `--repair` opens the store like any command and runs
 * {@link repairSuspectTables}: seal what is pending, emit the repair ops in a
 * `repair` frame per table, seal them, verify, and clear each suspect key
 * that verifies.
 *
 * @module
 * @task T12987
 */

import { existsSync } from 'node:fs';
import {
  getDualScopeNativeDb,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import { type RepairReport, repairSuspectTables } from '../store/sync/repair.js';

/** What `cleo doctor sync-journal` reports. */
export interface SyncRepairResult {
  readonly dbPath: string;
  readonly storeExists: boolean;
  readonly report: RepairReport;
  /** Tables that stay suspect (a plan in a dry run; unverified after a repair). */
  readonly suspect: readonly string[];
}

/**
 * Plan (default) or run (`repair`) the repair diff of the project store's
 * suspect tables.
 *
 * @param projectRoot - The project root.
 * @param options - `repair: true` writes; otherwise read-only.
 */
export async function runSyncRepair(
  projectRoot: string,
  options: { readonly repair?: boolean } = {},
): Promise<SyncRepairResult> {
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  const dryRun = options.repair !== true;
  const none: RepairReport = { refused: null, dryRun, tables: [], sealed: { txns: 0, ops: 0 } };
  if (!existsSync(dbPath)) return { dbPath, storeExists: false, report: none, suspect: [] };
  let report: RepairReport;
  if (dryRun) {
    const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
    try {
      report = repairSuspectTables(snap.db, { scope: 'project', dryRun: true });
    } finally {
      snap.close();
    }
  } else {
    const handle = await openDualScopeDb('project', projectRoot);
    report = repairSuspectTables(getDualScopeNativeDb(handle), { scope: 'project' });
  }
  return {
    dbPath,
    storeExists: true,
    report,
    suspect: report.tables.filter((t) => !t.cleared).map((t) => t.table),
  };
}
