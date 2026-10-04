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
import {
  CAPTURE_TRIGGER_PREFIX,
  classifyStoreTriggers,
  ensureTriggerSuspendTable,
  hasTriggerSuspendTable,
  normalizeSql,
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

/** Words the scan can meet where a table name could stand that are never a table. */
const NOT_A_TABLE = new Set(['new', 'old', 'select', 'values']);

/** Columns every insert target has without declaring them. */
const IMPLICIT_COLUMNS = new Set(['rowid', 'oid', '_rowid_', 'rank']);

/** One SQL token: an identifier (bare or quoted), or one punctuation character. */
interface SqlToken {
  readonly text: string;
  /** Lower-cased identifier with its quotes removed; null for punctuation. */
  readonly ident: string | null;
}

/**
 * Tokenise SQL for the reference scan. String literals (`'…'` with `''`
 * escapes), blob and numeric literals, and line and block comments are
 * dropped, so text inside them is never read as a name. Quoted identifiers
 * (`"a b"`, `` `a` ``, `[a]`) are kept whole.
 */
function sqlTokens(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const rest = sql.slice(i);
    if (/\s/.test(c)) {
      i += 1;
    } else if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'") {
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === "'" && sql[k + 1] === "'") k += 2;
        else if (sql[k] === "'") break;
        else k += 1;
      }
      i = k + 1;
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === close && close !== ']' && sql[k + 1] === close) k += 2;
        else if (sql[k] === close) break;
        else k += 1;
      }
      const body = sql.slice(i + 1, k).replaceAll(`${close}${close}`, close);
      out.push({ text: sql.slice(i, k + 1), ident: body.toLowerCase() });
      i = k + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest) as RegExpExecArray;
      out.push({ text: m[0], ident: m[0].toLowerCase() });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9][A-Za-z0-9_.]*/.exec(rest) as RegExpExecArray;
      i += m[0].length; // a number is never a name
    } else {
      out.push({ text: c, ident: null });
      i += 1;
    }
  }
  return out;
}

/** A `[schema.]name` at tokens[at]; the table name, or null when it is not one we can judge. */
function tableAt(tokens: readonly SqlToken[], at: number): { name: string; next: number } | null {
  const first = tokens[at];
  if (!first?.ident) return null;
  if (tokens[at + 1]?.text === '.' && tokens[at + 2]?.ident) {
    // Only the main schema is this store's; temp and attached schemas are not judged.
    if (first.ident !== 'main') return null;
    return { name: tokens[at + 2]?.ident as string, next: at + 3 };
  }
  return { name: first.ident, next: at + 1 };
}

/**
 * Every trigger whose text references a table the store lacks, or inserts
 * into a column its table lacks (T12754). SQLite resolves trigger bodies only
 * when the trigger fires, so such a trigger fails every write to its table.
 *
 * The scan tokenises the trigger (string literals and comments dropped,
 * quoted identifiers kept). A table is the name after `FROM` or `JOIN`
 * (the WHEN clause included; not `IS [NOT] DISTINCT FROM`), or the target of
 * `INSERT … INTO`, `REPLACE INTO`, `UPDATE` or `DELETE FROM` in the body.
 * A name followed by `(` is a table-valued function, a CTE name is local to
 * its statement, and a schema other than `main` is not judged.
 *
 * Not checked (false negatives by design): `UPDATE … SET` columns and
 * `NEW.` / `OLD.` columns.
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
    const tokens = sqlTokens(sql);
    const begin = tokens.findIndex((t) => t.ident === 'begin');
    const ctes = new Set<string>();
    tokens.forEach((t, k) => {
      // `WITH [RECURSIVE] name [(cols)] AS (` and `, name [(cols)] AS (`
      const prev = tokens[k - 1];
      const starts = prev?.ident === 'with' || prev?.ident === 'recursive' || prev?.text === ',';
      if (!t.ident || !starts) return;
      let n = k + 1;
      if (tokens[n]?.text === '(') {
        while (n < tokens.length && tokens[n]?.text !== ')') n += 1;
        n += 1;
      }
      if (tokens[n]?.ident === 'as' && tokens[n + 1]?.text === '(') ctes.add(t.ident);
    });
    const referenced = new Set<string>();
    const inserts: Array<{ table: string; cols: string[] }> = [];
    tokens.forEach((t, k) => {
      const prev = tokens[k - 1]?.ident;
      let target: { name: string; next: number } | null = null;
      if ((t.ident === 'from' || t.ident === 'join') && prev !== 'distinct') {
        target = tableAt(tokens, k + 1);
        if (target && tokens[target.next]?.text === '(') target = null; // table-valued function
      } else if (k > begin && begin !== -1) {
        if (
          t.ident === 'into' &&
          (prev === 'insert' ||
            prev === 'replace' ||
            prev === 'ignore' ||
            prev === 'rollback' ||
            prev === 'abort' ||
            prev === 'fail')
        ) {
          target = tableAt(tokens, k + 1);
          if (target && tokens[target.next]?.text === '(') {
            const cols: string[] = [];
            let n = target.next + 1;
            while (n < tokens.length && tokens[n]?.text !== ')') {
              const c = tokens[n];
              if (c?.ident) cols.push(c.ident);
              n += 1;
            }
            inserts.push({ table: target.name, cols });
          }
        } else if (t.ident === 'update' && tokens[k + 1]?.ident !== 'of') {
          let at = k + 1;
          if (tokens[at]?.ident === 'or') at += 2; // UPDATE OR <action>
          target = tableAt(tokens, at);
        }
      }
      if (target) referenced.add(target.name);
    });
    const missing: string[] = [];
    for (const t of referenced) {
      if (NOT_A_TABLE.has(t) || ctes.has(t) || t.startsWith('sqlite_') || t.startsWith('pragma_'))
        continue;
      if (!objects.has(t)) missing.push(`table ${t}`);
    }
    for (const { table, cols } of inserts) {
      if (!objects.has(table)) continue;
      const have = columns(table);
      for (const col of cols) {
        // rowid aliases always exist; an FTS5 table's command column and
        // `rank` are hidden from table_info.
        if (have.has(col) || IMPLICIT_COLUMNS.has(col) || col === table) continue;
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
  const was = inspectSyncTriggers(projectRoot);
  // A cold open already runs these steps in its schema pass; on a cached
  // handle they run here. Either way the actions come from the diff below.
  const handle = await openDualScopeDb('project', projectRoot);
  const db = getDualScopeNativeDb(handle);
  ensureTriggerSuspendTable(db);
  verifyOwnedTriggers(db, { repair: true });
  syncCaptureOpenPass(db, 'project');
  const now = inspectSyncTriggers(projectRoot);
  return {
    before,
    after: syncTriggersDoctorCheck(projectRoot),
    actions: repairActions(was, now),
  };
}

/** What changed between two trigger reports, one line per repair. */
export function repairActions(was: SyncTriggersReport, now: SyncTriggersReport): string[] {
  const actions: string[] = [];
  if (was.suspendTable === 'missing' && now.suspendTable === 'present') {
    actions.push('recreated cleo_trigger_suspend');
  }
  if (was.suspendRows > 0 && now.suspendRows === 0) {
    actions.push(`cleared ${was.suspendRows} committed cleo_trigger_suspend row(s)`);
  }
  const still = new Set(now.owned.map((f) => f.name));
  for (const f of was.owned) {
    if (!still.has(f.name)) actions.push(`re-ran the owned DDL of ${f.name} (${f.problem})`);
  }
  if (was.orphanedCaptureTriggers.length > 0 && now.orphanedCaptureTriggers.length === 0) {
    actions.push('recreated _sync_capture');
  }
  const d = was.captureDrift;
  const fixed = (k: 'missing' | 'differing' | 'extra') =>
    d[k].filter((t) => !now.captureDrift[k].includes(t)).length;
  const [installed, regenerated, dropped] = [fixed('missing'), fixed('differing'), fixed('extra')];
  if (installed + regenerated + dropped > 0) {
    actions.push(
      `capture triggers: ${installed} installed, ${regenerated} regenerated, ${dropped} orphaned dropped`,
    );
  }
  const left = new Set(now.dangling.map((t) => t.name));
  for (const t of was.dangling) {
    if (!left.has(t.name) && !was.owned.some((f) => f.name === t.name)) {
      if (!t.name.startsWith(CAPTURE_TRIGGER_PREFIX)) actions.push(`repaired ${t.name}`);
    }
  }
  return actions;
}
