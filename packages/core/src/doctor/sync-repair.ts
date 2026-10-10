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
import { HELD_WARN_DAYS, type HoldsReport, holdsReport } from '../store/sync/held.js';
import { type RepairReport, repairSuspectTables } from '../store/sync/repair.js';
import { UNDO_BUDGET_BYTES, type UndoBudget, undoBudget } from '../store/sync/sequencing.js';

/** What `cleo doctor sync-journal` reports. */
export interface SyncRepairResult {
  readonly dbPath: string;
  readonly storeExists: boolean;
  readonly report: RepairReport;
  /** Tables that stay suspect (a plan in a dry run; unverified after a repair). */
  readonly suspect: readonly string[];
  /** Local writes a sync rebase holds, with the long holds and their reason (§3.5 Rule 5). */
  readonly holds: HoldsReport;
  /** Undo against its budget: warns from 80%, `exceeded` from 100% until a rebind (§3.5 Rule 2, D5). */
  readonly undo: UndoBudget;
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
  options: {
    readonly repair?: boolean;
    readonly nowMs?: number;
    /** The undo budget in bytes; defaults to `UNDO_BUDGET_BYTES`. */
    readonly undoBudgetBytes?: number;
  } = {},
): Promise<SyncRepairResult> {
  const nowMs = options.nowMs ?? Date.now();
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  const dryRun = options.repair !== true;
  const none: RepairReport = { refused: null, dryRun, tables: [], sealed: { txns: 0, ops: 0 } };
  if (!existsSync(dbPath)) {
    return {
      dbPath,
      storeExists: false,
      report: none,
      suspect: [],
      holds: holdsReportOfNone(),
      undo: {
        bytes: 0,
        budget: options.undoBudgetBytes ?? UNDO_BUDGET_BYTES,
        state: 'ok',
        exceededAt: null,
      },
    };
  }
  let report: RepairReport;
  let holds: HoldsReport;
  let undo: UndoBudget;
  if (dryRun) {
    const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
    try {
      report = repairSuspectTables(snap.db, { scope: 'project', dryRun: true });
      holds = holdsReport(snap.db, nowMs);
      undo = undoBudget(snap.db, options.undoBudgetBytes);
    } finally {
      snap.close();
    }
  } else {
    const db = getDualScopeNativeDb(await openDualScopeDb('project', projectRoot));
    report = repairSuspectTables(db, { scope: 'project' });
    holds = holdsReport(db, nowMs);
    undo = undoBudget(db, options.undoBudgetBytes);
  }
  return {
    dbPath,
    storeExists: true,
    report,
    suspect: report.tables.filter((t) => !t.cleared).map((t) => t.table),
    holds,
    undo,
  };
}

/** No store, no holds. */
function holdsReportOfNone(): HoldsReport {
  return { total: 0, oldestAt: null, long: [], warnDays: HELD_WARN_DAYS };
}
