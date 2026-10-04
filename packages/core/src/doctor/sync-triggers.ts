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
 * - a capture trigger (`_sync_cap_*`) while `_sync_capture` is missing;
 * - any trigger whose body references a table that does not exist, or
 *   inserts into a column its table lacks (T12754). SQLite only notices this
 *   when the trigger fires, so every write to its table fails until then.
 *
 * The repair is the open pass: any `cleo` command against the project
 * recreates the table (step 0) and re-runs the owned DDL of every differing
 * trigger. `cleo doctor sync-triggers --repair` ({@link repairSyncTriggers})
 * runs the same steps on demand and reports what it changed. A store whose
 * journal has not reached the C2 migration yet is reported as pending, not
 * broken.
 *
 * @module
 * @task T12819
 * @task T12754
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  getDualScopeNativeDb,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import { generateCaptureTriggers, syncCaptureOpenPass } from '../store/sync/capture.js';
import { readSyncFlags } from '../store/sync/flags.js';
import { hasTable } from '../store/sync/schema.js';
import {
  CAPTURE_TRIGGER_PREFIX,
  classifyStoreTriggers,
  ensureTriggerSuspendTable,
  hasTriggerSuspendTable,
  normalizeSql,
  type OwnedTriggerFinding,
  TRIGGER_CLAUSE_MIGRATION,
  triggerWriteTargets,
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
  /** With `sync.capture` on: capture triggers missing, differing from the generated text, or extra (rule 9). */
  readonly captureDrift: { missing: string[]; differing: string[]; extra: string[] };
  /** Triggers that reference a missing table or insert into a missing column (T12754). */
  readonly dangling: DanglingTrigger[];
}

/** A trigger whose body references objects the store does not have (T12754). */
export interface DanglingTrigger {
  readonly name: string;
  /** `table <t>` or `column <t>.<c>`, for each missing object. */
  readonly missing: string[];
}

const FIX =
  "Run 'cleo doctor sync-triggers --repair' (any 'cleo' command in this project also runs the same open pass): it recreates cleo_trigger_suspend, re-runs the owned DDL of every differing trigger, and makes the capture triggers match sync.capture";

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
    captureDrift: { missing: [], differing: [], extra: [] },
    dangling: [],
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
      captureDrift: readSyncFlags(db)['sync.capture']
        ? captureDrift(db)
        : { missing: [], differing: [], extra: [] },
      dangling: danglingTriggers(db),
    };
  } finally {
    snap.close();
  }
}

/** Words the FROM/JOIN scan can catch that are never a table. */
const NOT_A_TABLE = new Set(['new', 'old', 'select', 'values']);

/** Columns every insert target has without declaring them. */
const IMPLICIT_COLUMNS = new Set(['rowid', 'oid', '_rowid_', 'rank']);

/**
 * Every trigger whose body references a table the store lacks, or inserts
 * into a column its table lacks (T12754). Reads are the tables after `FROM`
 * and `JOIN`; writes are {@link triggerWriteTargets}. A name followed by `(`
 * is a table-valued function, and a CTE name is local to the body; neither
 * is a table.
 */
export function danglingTriggers(db: DatabaseSync): DanglingTrigger[] {
  const objects = new Set(
    (
      db
        .prepare(
          "SELECT lower(name) AS name FROM main.sqlite_master WHERE type IN ('table', 'view')",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const columns = (table: string): Set<string> =>
    new Set(
      (
        db.prepare('SELECT lower(name) AS name FROM pragma_table_info(?)').all(table) as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
  const out: DanglingTrigger[] = [];
  const triggers = db
    .prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all() as Array<{ name: string; sql: string }>;
  for (const { name, sql } of triggers) {
    const body = sql.slice(Math.max(0, sql.search(/\bBEGIN\b/i)));
    // CTE names (`WITH [RECURSIVE] name[(cols)] AS (`, and later `, name AS (`)
    // are local to the statement.
    const ctes = new Set(
      [
        ...sql.matchAll(
          /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*[`"]?(\w+)[`"]?\s*(?:\([^)]*\))?\s+AS\s*\(/gi,
        ),
      ].map((m) => (m[1] as string).toLowerCase()),
    );
    const referenced = new Set(triggerWriteTargets(sql));
    // Reads anywhere, the WHEN clause included (it can read a dropped table).
    for (const m of sql.matchAll(
      /\b(?:from|join)\s+[`"[]?(?:main\.)?[`"[]?(\w+)[`"\]]?\s*(\()?/gi,
    )) {
      if (m[2] === '(') continue;
      referenced.add((m[1] as string).toLowerCase());
    }
    const missing: string[] = [];
    for (const t of referenced) {
      if (NOT_A_TABLE.has(t) || ctes.has(t) || t.startsWith('sqlite_') || t.startsWith('pragma_'))
        continue;
      if (!objects.has(t)) missing.push(`table ${t}`);
    }
    const insertCols =
      /\binsert(?:\s+or\s+\w+)?\s+into\s+[`"[]?(?:main\.)?[`"[]?(\w+)[`"\]]?\s*\(([^)]*)\)/gi;
    for (const m of body.matchAll(insertCols)) {
      const table = (m[1] as string).toLowerCase();
      if (!objects.has(table)) continue;
      const have = columns(table);
      for (const raw of (m[2] as string).split(',')) {
        const col = raw
          .trim()
          .replace(/^[`"[]|[`"\]]$/g, '')
          .toLowerCase();
        // rowid aliases always exist; an FTS5 table's command column and
        // `rank` are hidden from table_info.
        if (!col || have.has(col) || IMPLICIT_COLUMNS.has(col) || col === table) continue;
        missing.push(`column ${table}.${col}`);
      }
    }
    if (missing.length > 0) out.push({ name, missing: [...new Set(missing)] });
  }
  return out;
}

/** Live capture triggers against the text generated for the current schema. */
function captureDrift(db: DatabaseSync): {
  missing: string[];
  differing: string[];
  extra: string[];
} {
  const want = new Map(generateCaptureTriggers(db, 'project').map((t) => [t.name, t.sql]));
  const live = new Map(
    (
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, length(?)) = ?",
        )
        .all(CAPTURE_TRIGGER_PREFIX, CAPTURE_TRIGGER_PREFIX) as Array<{ name: string; sql: string }>
    ).map((r) => [r.name, r.sql]),
  );
  return {
    missing: [...want.keys()].filter((n) => !live.has(n)),
    differing: [...want]
      .filter(
        ([n, sql]) => live.has(n) && normalizeSql(live.get(n) as string) !== normalizeSql(sql),
      )
      .map(([n]) => n),
    extra: [...live.keys()].filter((n) => !want.has(n)),
  };
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
  const drift = r.captureDrift;
  if (drift.missing.length + drift.differing.length + drift.extra.length > 0) {
    problems.push(
      `capture triggers differ from the generated set (missing ${drift.missing.length}, differing ${drift.differing.length}, extra ${drift.extra.length})`,
    );
  }
  if (r.unclassified.length > 0)
    problems.push(`unclassified trigger(s): ${r.unclassified.join(', ')}`);
  if (r.dangling.length > 0) {
    problems.push(
      `trigger(s) referencing missing objects, so every write to their table fails: ${r.dangling
        .map((d) => `${d.name} (${d.missing.join(', ')})`)
        .join('; ')}`,
    );
  }
  if (problems.length > 0) {
    const blocking =
      (r.clauseMigrationApplied && r.suspendTable === 'missing') ||
      r.orphanedCaptureTriggers.length > 0 ||
      r.dangling.length > 0;
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

/** What {@link repairSyncTriggers} did. */
export interface SyncTriggersRepairResult {
  /** The `sync_triggers` row before the repair. */
  readonly before: SyncTriggersDoctorCheck;
  /** The row after it. A trigger CLEO does not own is reported, never dropped. */
  readonly after: SyncTriggersDoctorCheck;
  /** One line per change. */
  readonly actions: string[];
}

/**
 * `cleo doctor sync-triggers --repair` (T12754): run the open pass's trigger
 * steps on the project store now, and report the row before and after.
 *
 * - step 0: recreate `cleo_trigger_suspend`, or clear a committed row;
 * - owned guard and side-effect triggers: drop and re-run their owned DDL
 *   when missing, differing or dangling;
 * - capture triggers: match `sync.capture`. With it on, the outbox tables are
 *   healed and the triggers regenerated for the current schema; with it off,
 *   they are dropped.
 *
 * A trigger CLEO does not own that references a missing object is reported in
 * `after`, never dropped: it is not CLEO's to remove.
 */
export async function repairSyncTriggers(projectRoot: string): Promise<SyncTriggersRepairResult> {
  const before = syncTriggersDoctorCheck(projectRoot);
  if (!existsSync(resolveDualScopeDbPath('project', projectRoot))) {
    return { before, after: before, actions: [] };
  }
  const handle = await openDualScopeDb('project', projectRoot);
  const db = getDualScopeNativeDb(handle);
  const actions: string[] = [];
  const step0 = ensureTriggerSuspendTable(db);
  if (step0.created) actions.push('recreated cleo_trigger_suspend');
  if (step0.cleared > 0)
    actions.push(`cleared ${step0.cleared} committed cleo_trigger_suspend row(s)`);
  for (const f of verifyOwnedTriggers(db, { repair: true })) {
    actions.push(`re-ran the owned DDL of ${f.name} (${f.problem})`);
  }
  const outboxMissing = !hasTable(db, '_sync_capture');
  const capture = syncCaptureOpenPass(db, 'project');
  if (capture.capture === 'on' && outboxMissing && hasTable(db, '_sync_capture')) {
    actions.push('recreated _sync_capture');
  }
  if (capture.capture === 'on') {
    const r = capture.report;
    if (r.installed.length + r.replaced.length + r.dropped.length > 0) {
      actions.push(
        `capture triggers: ${r.installed.length} installed, ${r.replaced.length} regenerated, ${r.dropped.length} orphaned dropped`,
      );
    }
  } else if (capture.dropped.length > 0) {
    actions.push(`dropped ${capture.dropped.length} capture trigger(s): sync.capture is off`);
  }
  return { before, after: syncTriggersDoctorCheck(projectRoot), actions };
}
