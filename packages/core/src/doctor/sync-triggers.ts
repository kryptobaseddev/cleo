/**
 * `cleo doctor` row `sync_triggers` (journal spec §2.3a rule 9, §3.5 Rule 4;
 * C2(b), T12819).
 *
 * Read-only. It opens the project `cleo.db` as a snapshot and reports:
 * - `cleo_trigger_suspend` missing (every write to tasks, sessions and
 *   acceptance criteria then fails, and a 9.24 binary fails closed) or
 *   holding a committed row;
 * - a trigger no class rule covers;
 * - an owned guard or side-effect trigger missing, or whose live text
 *   differs from its owned DDL (for example without its suspension clause);
 * - a capture trigger (`_sync_cap_*`) while `_sync_capture` is missing.
 *
 * The repair is the open pass itself: any `cleo` command against the project
 * recreates the table (step 0) and re-runs the owned DDL of every differing
 * trigger. A store whose journal has not reached the C2 migration yet is
 * reported as pending, not broken.
 *
 * @module
 * @task T12819
 */

import { existsSync } from 'node:fs';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import {
  CAPTURE_TRIGGER_PREFIX,
  classifyStoreTriggers,
  hasTriggerSuspendTable,
  type OwnedTriggerFinding,
  TRIGGER_CLAUSE_MIGRATION,
  verifyOwnedTriggers,
} from '../store/sync/trigger-classes.js';

/** The `sync_triggers` row of `cleo doctor`. */
export interface SyncTriggersDoctorCheck {
  readonly check: 'sync_triggers';
  readonly status: 'ok' | 'warning' | 'error';
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly fix?: string;
}

/** What {@link inspectSyncTriggers} found. */
export interface SyncTriggersReport {
  readonly dbPath: string;
  readonly storeExists: boolean;
  /** The C2 migration is journaled. */
  readonly clauseMigrationApplied: boolean;
  readonly suspendTable: 'present' | 'missing';
  readonly suspendRows: number;
  readonly unclassified: string[];
  readonly owned: OwnedTriggerFinding[];
  readonly orphanedCaptureTriggers: string[];
}

const FIX =
  "Run any 'cleo' command in this project: the open pass recreates cleo_trigger_suspend and repairs owned triggers from their migration DDL";

/** Inspect the project store's triggers. Read-only. */
export function inspectSyncTriggers(projectRoot: string): SyncTriggersReport {
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  const empty: SyncTriggersReport = {
    dbPath,
    storeExists: false,
    clauseMigrationApplied: false,
    suspendTable: 'missing',
    suspendRows: 0,
    unclassified: [],
    owned: [],
    orphanedCaptureTriggers: [],
  };
  if (!existsSync(dbPath)) return empty;
  const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
  try {
    const db = snap.db;
    const journaled =
      db
        .prepare(
          "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
        )
        .get() !== undefined &&
      db
        .prepare('SELECT 1 FROM main."__drizzle_migrations" WHERE name = ?')
        .get(TRIGGER_CLAUSE_MIGRATION) !== undefined;
    const present = hasTriggerSuspendTable(db);
    const rows = present
      ? (db.prepare('SELECT count(*) AS n FROM cleo_trigger_suspend').get() as { n: number }).n
      : 0;
    const captureTriggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, length(?)) = ?",
        )
        .all(CAPTURE_TRIGGER_PREFIX, CAPTURE_TRIGGER_PREFIX) as Array<{ name: string }>
    ).map((r) => r.name);
    const hasCapture =
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sync_capture'")
        .get() !== undefined;
    return {
      dbPath,
      storeExists: true,
      clauseMigrationApplied: journaled,
      suspendTable: present ? 'present' : 'missing',
      suspendRows: rows,
      unclassified: classifyStoreTriggers(db, 'project').unclassified,
      owned: journaled ? verifyOwnedTriggers(db) : [],
      orphanedCaptureTriggers: hasCapture ? [] : captureTriggers,
    };
  } finally {
    snap.close();
  }
}

/** The `sync_triggers` row of the default `cleo doctor` report. */
export function syncTriggersDoctorCheck(projectRoot: string): SyncTriggersDoctorCheck {
  let r: SyncTriggersReport;
  try {
    r = inspectSyncTriggers(projectRoot);
  } catch (error) {
    return {
      check: 'sync_triggers',
      status: 'warning',
      message: `trigger state unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!r.storeExists) {
    return { check: 'sync_triggers', status: 'ok', message: 'no project store yet' };
  }
  const details = { ...r } as unknown as Record<string, unknown>;
  const problems: string[] = [];
  if (r.clauseMigrationApplied && r.suspendTable === 'missing') {
    problems.push(
      'cleo_trigger_suspend is missing: writes to tasks, sessions and acceptance criteria fail until the next open recreates it',
    );
  }
  if (r.suspendRows > 0)
    problems.push(`cleo_trigger_suspend holds ${r.suspendRows} committed row(s)`);
  if (r.owned.length > 0) {
    problems.push(
      `owned trigger(s) differ from their DDL: ${r.owned.map((f) => `${f.name} (${f.problem})`).join(', ')}`,
    );
  }
  if (r.orphanedCaptureTriggers.length > 0) {
    problems.push(
      `capture trigger(s) without _sync_capture: ${r.orphanedCaptureTriggers.join(', ')}`,
    );
  }
  if (r.unclassified.length > 0)
    problems.push(`unclassified trigger(s): ${r.unclassified.join(', ')}`);
  if (problems.length > 0) {
    const blocking =
      (r.clauseMigrationApplied && r.suspendTable === 'missing') ||
      r.orphanedCaptureTriggers.length > 0;
    return {
      check: 'sync_triggers',
      status: blocking ? 'error' : 'warning',
      message: problems.join('; '),
      details,
      fix: FIX,
    };
  }
  if (!r.clauseMigrationApplied) {
    return {
      check: 'sync_triggers',
      status: 'ok',
      message: `trigger-suspension migration ${TRIGGER_CLAUSE_MIGRATION} pending; the next open applies it`,
      details,
    };
  }
  return {
    check: 'sync_triggers',
    status: 'ok',
    message: 'every trigger is classified; owned triggers match their DDL',
    details,
  };
}
