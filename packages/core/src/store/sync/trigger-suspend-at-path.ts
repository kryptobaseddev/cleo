/**
 * Create `cleo_trigger_suspend` in a store FILE that was just placed outside
 * the open pass: a bundle import or a restore from a snapshot (journal spec
 * §3.5 Rule 4, round 9; T12819).
 *
 * A placed store that syncs also has its whole sync set marked suspect
 * (§2.3a rule 3). A placed store may come from an older build. Until the next chokepoint
 * open, a 9.24 binary would open it as is; with the table present its owned
 * triggers (if any carry the clause) keep working. A file that is not a
 * project store (no `tasks_tasks`) is left alone.
 *
 * @task T12819
 * @module store/sync/trigger-suspend-at-path
 */

import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { syncSetTables } from './capture.js';
import { markSuspect } from './structural.js';
import { ensureTriggerSuspendTable, type TriggerSuspendStepZero } from './trigger-classes.js';

/**
 * Open `dbPath` read-write, create the flag table when it is a project store
 * missing it, and close.
 *
 * @returns What step 0 did, or `null` when the file is not a project store.
 */
export function ensureTriggerSuspendTableAtPath(dbPath: string): TriggerSuspendStepZero | null {
  const snap = openCleoDbSnapshot(dbPath, { readOnly: false });
  try {
    const isProject =
      snap.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks_tasks'")
        .get() !== undefined;
    if (!isProject) return null;
    const step0 = ensureTriggerSuspendTable(snap.db);
    // §2.3a rule 3 (B): nothing in a placed file was written through this
    // device's capture, so a store that syncs has its whole sync set marked
    // suspect for the repair diff. A store without the sync schema stays so.
    markSuspect(snap.db, 'project', syncSetTables('project'));
    return step0;
  } finally {
    snap.close();
  }
}
